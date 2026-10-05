import { createHash, randomUUID } from "node:crypto";
import type { Agent, PreparedContinuation } from "@earendil-works/pi-agent-core";
import { type ContextBudget, estimateTextTokens, type Message } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { contextRemaining } from "./context-budget.ts";
import { createContextWindowIdentity, currentContextWindow } from "./context-window.ts";
import { History } from "./history.ts";
import {
	buildSessionContext,
	type ContextOperationEntry,
	type ContextRolloverEntry,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.ts";
import {
	type ContextTransitionGate,
	captureSubagentHandoff,
	type SubagentHandoff,
	subagentRecoveryRecords,
} from "./subagent-continuation.ts";
import {
	buildTaskNoteProjectionFromBranch,
	createTaskNoteFreshnessResolver,
	createTaskScopeId,
	resolveTaskNoteScope,
	resolveTaskNoteScopeByTaskSource,
	type TaskNoteFreshness,
	type TaskNoteProjectionSnapshot,
	type TaskNoteReference,
} from "./task-note-projection.ts";
import type { ContextRecoveryReadPage, SessionTraceEvent } from "./trace.ts";

export type ContextTransitionCause = "model_requested";
export type ContextControlCause = ContextTransitionCause | "work_budget_reached" | "provider_context_rejected";
export interface ContextRecoveryReferences extends SubagentHandoff {
	saveStateOperationId: string;
	nextActionEventId: string;
	relatedNoteEventIds: string[];
	noteFreshness: Array<{ eventId: string; freshness: TaskNoteFreshness }>;
	requiredHistoryRefs: TaskNoteReference[];
	requirementSourceRefs: TaskNoteReference[];
	todoIds: string[];
	taskSourceEntryId: string;
	requirementsStartEntryId: string;
	historyCutoffEntryId: string;
	historyStartEntryId: string;
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	taskNoteProjectionRevision: string;
	taskScopeId: string;
}

export const SAVE_STATE_MAX_SAMPLES = 3;
export const RECOVERY_OUTPUT_TOKENS = 2048;
export const RECOVERY_TOOL_NAMES = ["history", "context_note", "get_context_remaining"] as const;

export interface SaveStateOperationSnapshot {
	operationId: string;
	transitionCause: ContextControlCause;
	windowId: string;
	promptGeneration: number;
	contextEpoch: number;
	sourceFingerprint: string;
	businessCutoffEntryId: string;
	startTaskNoteRevision: string;
	controlBudgetTokens: number;
	outputBudgetTokens: number;
	samplesUsed: number;
	consumedControlTokens: number;
	consumedOutputTokens: number;
	finished: boolean;
}

export type ContinuationStateValidation =
	| {
			status: "valid";
			finalTaskNoteRevision: string;
			nextActionEventId: string;
			relatedNoteEventIds: string[];
			noteFreshness: Array<{ eventId: string; freshness: TaskNoteFreshness }>;
			requiredHistoryRefs: TaskNoteReference[];
			requirementSourceRefs: TaskNoteReference[];
			todoIds: string[];
	  }
	| { status: "invalid"; reason: string };

export interface ContextRecoveryCoverage {
	complete: boolean;
	progressFingerprint: string;
	coveredUnits: number;
	missing: string[];
	pages: ContextRecoveryReadPage[];
}
export interface ContextRolloverRevisions {
	sessionLeafId: string | null;
	sourceFingerprint: string;
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	queueRevision: string;
	progressRevision: string;
	requestConfigFingerprint: string;
	taskNoteProjectionRevision: string;
}
export type ContextRolloverBlockedReason =
	| "source_changed"
	| "operation_in_flight"
	| "subagent_handoff_invalid"
	| "rollover_already_used"
	| "rollover_limit"
	| "recovery_unavailable"
	| "tool_transaction_incomplete"
	| "invalid_continuation_context"
	| "continuation_state_changed"
	| "prepared_context_limit"
	| "recovery_workset_too_large"
	| "unchanged_request"
	| "post_commit_mismatch"
	| "dispatch_prepare_mismatch"
	| "model_request_missing"
	| "dispatch_outcome_unknown";
export interface ContextRolloverRequest {
	cause: ContextTransitionCause;
	requestId: string;
	windowId: string;
	budget: ContextBudget;
	requestFingerprint: string;
}
export type ContextRolloverOutcome =
	| { outcome: "dispatched" }
	| { outcome: "blocked"; reason: ContextRolloverBlockedReason }
	| { outcome: "cancelled" };
interface ContextRolloverDependencies {
	agent: Agent;
	manager: SessionManager;
	revisions: () => ContextRolloverRevisions;
	transitionGate: (retainedRequiredIds?: readonly string[]) => ContextTransitionGate;
	isCancelled: () => boolean;
	pendingDeliveryIds: () => readonly string[];
	canRecover: (recovery?: ContextRecoveryReferences) => boolean;
	workThresholdPercent: () => number;
	measureSource: () => Promise<{ budget: ContextBudget; requestFingerprint: string }>;
	onDispatch: (preparationId: string | undefined) => void;
	onTrace: (data: Omit<Extract<SessionTraceEvent, { type: "context/rollover" }>["data"], "turn">) => void;
}
export function fingerprintContextRolloverValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function createContextRolloverDispatchId(rolloverId: string, fingerprint: string): string {
	return fingerprintContextRolloverValue(["context-rollover-dispatch", rolloverId, fingerprint]);
}
export function collectCompleteToolTransactions(entries: readonly SessionEntry[]): string[][] {
	const transactions: string[][] = [];
	let expected = new Set<string>();
	let current: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!expected.delete(message.toolCallId)) throw new Error("tool_transaction_incomplete");
			current.push(entry.id);
			if (expected.size === 0) transactions.push(current);
			continue;
		}
		if (expected.size > 0) throw new Error("tool_transaction_incomplete");
		current = [entry.id];
		if (message.role === "assistant")
			expected = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
		if (expected.size === 0) transactions.push(current);
	}
	if (expected.size > 0) throw new Error("tool_transaction_incomplete");
	return transactions;
}

function dedupeReferences(references: readonly TaskNoteReference[]): TaskNoteReference[] {
	const seen = new Set<string>();
	return references.filter((reference) => {
		const key = `${reference.entryId}:${reference.blockIndex ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The runtime, not the model's bounded dependency list, owns unfinished-task coverage. */
function requiredTodoIds(items: unknown[], selected: readonly string[]): string[] {
	return [
		...new Set([
			...selected,
			...items.flatMap((item) =>
				item !== null &&
				typeof item === "object" &&
				"id" in item &&
				typeof item.id === "string" &&
				"status" in item &&
				(item.status === "pending" || item.status === "in_progress")
					? [item.id]
					: [],
			),
		]),
	];
}

function referenceBlock(
	historyById: ReadonlyMap<string, ReturnType<History["getItems"]>[number]>,
	reference: TaskNoteReference,
) {
	const item = historyById.get(reference.entryId);
	if (reference.blockIndex === undefined) return item?.blocks.length === 1 ? item.blocks[0] : undefined;
	return item?.blocks.find((block) => block.blockIndex === reference.blockIndex);
}

/** Resolve the current effective continuation contract while retaining the committed task authority. */
export function currentContextRecoveryReferences(
	manager: SessionManager,
	recovery: ContextRecoveryReferences,
): ContextRecoveryReferences {
	const branch = manager.getBranch();
	const scope = resolveTaskNoteScopeByTaskSource(branch, recovery.taskSourceEntryId);
	if (!scope || scope.taskScopeId !== recovery.taskScopeId) throw new Error("recovery_reference_invalid");
	const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
	if (projection.status !== "valid") throw new Error("recovery_reference_invalid");
	const nextAction = projection.snapshot.items.find((item) => item.kind === "next_action" && item.key === "current");
	if (!nextAction?.resume) throw new Error("recovery_reference_invalid");
	subagentRecoveryRecords(
		manager,
		{ ...recovery, subagentNoteEventId: recovery.requiredTaskIds.length > 0 ? nextAction.eventId : null },
		nextAction,
	);
	const handoff = captureSubagentHandoff(manager, scope, recovery.requiredTaskIds);
	const related = nextAction.resume.relatedNotes.map((reference) =>
		projection.snapshot.items.find((item) => item.kind === reference.kind && item.key === reference.key),
	);
	if (related.some((item) => item === undefined)) throw new Error("recovery_reference_invalid");

	const cutoffIndex = branch.findIndex((entry) => entry.id === recovery.historyCutoffEntryId);
	if (cutoffIndex < 0) throw new Error("recovery_reference_invalid");
	const branchIndex = new Map(branch.map((entry, index) => [entry.id, index]));
	const deliveredRequirements = new History(manager)
		.getItems()
		.filter((item) => item.role === "user" && (branchIndex.get(item.entryId) ?? -1) > cutoffIndex)
		.flatMap((item) =>
			item.blocks.flatMap((block) =>
				block.text === undefined ? [] : [{ entryId: item.entryId, blockIndex: block.blockIndex }],
			),
		);
	const history = new History(manager).getItems();
	const historyById = new Map(history.map((item) => [item.entryId, item]));
	const requiredHistoryRefs = dedupeReferences(nextAction.resume.requiredHistoryRefs);
	const requirementSourceRefs = dedupeReferences([
		...recovery.requirementSourceRefs,
		...nextAction.resume.requirementSourceRefs,
		...deliveredRequirements,
	]);
	if (![...requiredHistoryRefs, ...requirementSourceRefs].every((reference) => referenceBlock(historyById, reference)))
		throw new Error("recovery_reference_invalid");
	const todoEntry = [...branch]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === "todo-state");
	const todoItems = todoEntry?.type === "custom" && Array.isArray(todoEntry.data) ? todoEntry.data : [];
	if (
		!nextAction.resume.todoIds.every((todoId) =>
			todoItems.some((item) => item !== null && typeof item === "object" && "id" in item && item.id === todoId),
		)
	)
		throw new Error("recovery_reference_invalid");
	return {
		...recovery,
		...handoff,
		nextActionEventId: nextAction.eventId,
		relatedNoteEventIds: related.flatMap((item) => (item === undefined ? [] : [item.eventId])),
		noteFreshness: [nextAction, ...related].flatMap((item) =>
			item === undefined ? [] : [{ eventId: item.eventId, freshness: item.freshness }],
		),
		requiredHistoryRefs,
		requirementSourceRefs,
		todoIds: requiredTodoIds(todoItems, nextAction.resume.todoIds),
		todoStateEntryId: todoEntry?.id ?? null,
		todoStateFingerprint: fingerprintContextRolloverValue(todoEntry?.type === "custom" ? todoEntry.data : []),
		taskNoteProjectionRevision: projection.snapshot.revision,
	};
}

function recoveryWorkset(
	manager: SessionManager,
	recovery: ContextRecoveryReferences,
	promptGeneration: number,
): unknown {
	const branch = manager.getBranch();
	const scope = resolveTaskNoteScope(branch, promptGeneration);
	const projection =
		scope?.taskScopeId === recovery.taskScopeId
			? buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch))
			: undefined;
	const noteIds = new Set([recovery.nextActionEventId, ...recovery.relatedNoteEventIds]);
	const history = new History(manager).getItems();
	const historyById = new Map(history.map((item) => [item.entryId, item]));
	const historyReferences = dedupeReferences([...recovery.requirementSourceRefs, ...recovery.requiredHistoryRefs]);
	return {
		resume: {
			nextActionEventId: recovery.nextActionEventId,
			taskNoteProjectionRevision: recovery.taskNoteProjectionRevision,
			todoStateFingerprint: recovery.todoStateFingerprint,
		},
		subagents: subagentRecoveryRecords(
			manager,
			recovery,
			projection?.status === "valid"
				? projection.snapshot.items.find((item) => item.eventId === recovery.subagentNoteEventId)
				: undefined,
		),
		notes:
			projection?.status === "valid"
				? projection.snapshot.items
						.filter((item) => noteIds.has(item.eventId))
						.map((item) => ({
							...item,
							resume: item.resume ? { ...item.resume, subagentContinuations: undefined } : undefined,
						}))
				: [],
		history: historyReferences.map((reference) => {
			const item = historyById.get(reference.entryId);
			const block =
				reference.blockIndex === undefined
					? item?.blocks.length === 1
						? item.blocks[0]
						: undefined
					: item?.blocks.find((candidate) => candidate.blockIndex === reference.blockIndex);
			return { ...reference, text: block?.text ?? "" };
		}),
		todos: recovery.todoIds.map((todoId) => {
			const item = recovery.todoStateEntryId ? historyById.get(recovery.todoStateEntryId) : undefined;
			return {
				todoId,
				revision: item?.todoRevision,
				text: JSON.stringify(item?.todoItems?.find((todo) => todo.id === todoId) ?? null),
			};
		}),
	};
}

function latestSaveEntry(
	manager: SessionManager,
	windowId: string,
	promptGeneration: number,
): ContextOperationEntry | undefined {
	return [...manager.getBranch()]
		.reverse()
		.find(
			(entry): entry is ContextOperationEntry =>
				entry.type === "context_operation" &&
				entry.operationKind === "save_state" &&
				entry.windowId === windowId &&
				entry.promptGeneration === promptGeneration,
		);
}

export function getSaveStateOperation(
	manager: SessionManager,
	windowId: string,
	promptGeneration: number,
): SaveStateOperationSnapshot | undefined {
	const entry = latestSaveEntry(manager, windowId, promptGeneration);
	if (!entry) return undefined;
	return {
		operationId: entry.operationId,
		transitionCause: entry.transitionCause,
		windowId: entry.windowId,
		promptGeneration: entry.promptGeneration,
		contextEpoch: entry.contextEpoch,
		sourceFingerprint: entry.sourceFingerprint,
		businessCutoffEntryId: entry.businessCutoffEntryId,
		startTaskNoteRevision: entry.startTaskNoteRevision,
		controlBudgetTokens: entry.controlBudgetTokens,
		outputBudgetTokens: entry.outputBudgetTokens,
		samplesUsed: entry.samplesUsed,
		consumedControlTokens: entry.consumedControlTokens,
		consumedOutputTokens: entry.consumedOutputTokens,
		finished: entry.state === "finished",
	};
}

function branchTaskNoteProjection(
	manager: SessionManager,
	promptGeneration: number,
): { snapshot: TaskNoteProjectionSnapshot; branch: SessionEntry[] } | undefined {
	const branch = manager.getBranch();
	const scope = resolveTaskNoteScope(branch, promptGeneration);
	if (!scope) return undefined;
	const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
	return projection.status === "valid" ? { snapshot: projection.snapshot, branch } : undefined;
}

function isBusinessFact(entry: SessionEntry): boolean {
	if (entry.type === "delivery_receipt") return true;
	if (entry.type === "custom" && entry.customType === "todo-state") return true;
	if (entry.type !== "message") return false;
	if (entry.message.role === "user") return true;
	return (
		entry.message.role === "toolResult" &&
		!["context_note", "history", "get_context_remaining", "new_context"].includes(entry.message.toolName)
	);
}

/** Validate the single continuation contract that permits a save-state operation to finish. */
export function validateContinuationState(
	manager: SessionManager,
	operation: SaveStateOperationSnapshot,
): ContinuationStateValidation {
	const projected = branchTaskNoteProjection(manager, operation.promptGeneration);
	if (!projected) return { status: "invalid", reason: "continuation_projection_invalid" };
	const { branch, snapshot } = projected;
	const cutoffIndex = branch.findIndex((entry) => entry.id === operation.businessCutoffEntryId);
	if (cutoffIndex < 0) return { status: "invalid", reason: "business_cutoff_unavailable" };
	const nextAction = snapshot.items.find((item) => item.kind === "next_action" && item.key === "current");
	if (!nextAction?.resume) return { status: "invalid", reason: "continuation_state_missing" };
	const noteEntryIndex = branch.findIndex(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "task-note-event" &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			"eventId" in entry.data &&
			entry.data.eventId === nextAction.eventId,
	);
	if (noteEntryIndex < 0) return { status: "invalid", reason: "continuation_reference_invalid" };
	if (branch.slice(noteEntryIndex + 1).some(isBusinessFact)) {
		return { status: "invalid", reason: "continuation_state_stale" };
	}
	try {
		collectCompleteToolTransactions(branch.slice(cutoffIndex + 1));
	} catch {
		return { status: "invalid", reason: "tool_transaction_incomplete" };
	}

	const related = nextAction.resume.relatedNotes.map((reference) =>
		snapshot.items.find((item) => item.kind === reference.kind && item.key === reference.key),
	);
	if (related.some((item) => item === undefined))
		return { status: "invalid", reason: "continuation_reference_invalid" };
	const history = new History(manager).getItems();
	const readable = new Map(history.map((item) => [item.entryId, item]));
	const refIsReadable = (reference: TaskNoteReference) => {
		const item = readable.get(reference.entryId);
		if (item === undefined) return false;
		const block =
			reference.blockIndex === undefined
				? item.blocks.length === 1
					? item.blocks[0]
					: undefined
				: item.blocks.find((candidate) => candidate.blockIndex === reference.blockIndex);
		return block?.text !== undefined;
	};
	if (!nextAction.resume.requiredHistoryRefs.every(refIsReadable))
		return { status: "invalid", reason: "continuation_history_reference_invalid" };
	const scopeTask = history.find((item) => createTaskScopeId(item.entryId) === snapshot.scope.taskScopeId);
	if (!scopeTask) return { status: "invalid", reason: "task_source_unavailable" };
	const requiredUserRefs = history
		.filter((item) => item.role === "user")
		.filter((item) => {
			const index = branch.findIndex((entry) => entry.id === item.entryId);
			const start = branch.findIndex((entry) => entry.id === scopeTask.entryId);
			return index >= start && index <= noteEntryIndex;
		})
		.flatMap((item) =>
			item.blocks
				.filter((block) => block.type === "text")
				.map((block) => ({ entryId: item.entryId, blockIndex: block.blockIndex })),
		);
	const requirementSourceRefs = dedupeReferences([...requiredUserRefs, ...nextAction.resume.requirementSourceRefs]);
	if (
		!requirementSourceRefs.every((reference) => {
			const entry = branch.find((candidate) => candidate.id === reference.entryId);
			return (
				(entry?.type === "message" || entry?.type === "pending_delivery") &&
				entry.message.role === "user" &&
				readable.get(reference.entryId)?.role === "user" &&
				refIsReadable(reference)
			);
		})
	)
		return { status: "invalid", reason: "requirement_source_invalid" };

	const todoEntry = [...branch]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === "todo-state");
	const todoItems = todoEntry?.type === "custom" && Array.isArray(todoEntry.data) ? todoEntry.data : [];
	if (
		!nextAction.resume.todoIds.every((todoId) =>
			todoItems.some((item) => item !== null && typeof item === "object" && "id" in item && item.id === todoId),
		)
	)
		return { status: "invalid", reason: "todo_reference_invalid" };

	return {
		status: "valid",
		finalTaskNoteRevision: snapshot.revision,
		nextActionEventId: nextAction.eventId,
		relatedNoteEventIds: related.flatMap((item) => (item === undefined ? [] : [item.eventId])),
		noteFreshness: [nextAction, ...related].flatMap((item) =>
			item === undefined ? [] : [{ eventId: item.eventId, freshness: item.freshness }],
		),
		requiredHistoryRefs: dedupeReferences(nextAction.resume.requiredHistoryRefs),
		requirementSourceRefs,
		todoIds: requiredTodoIds(todoItems, nextAction.resume.todoIds),
	};
}

function parseVisibleToolPages(messages: readonly Message[]): ContextRecoveryReadPage[] {
	return messages.flatMap((message) => {
		if (message.role !== "toolResult" || message.isError) return [];
		return message.content.flatMap((block): ContextRecoveryReadPage[] => {
			if (block.type !== "text") return [];
			try {
				const value: unknown = JSON.parse(block.text);
				return value !== null &&
					typeof value === "object" &&
					"source" in value &&
					(value.source === "task_notes" || value.source === "session_history")
					? [
							{
								toolCallId: message.toolCallId,
								toolName: message.toolName,
								page: value as Record<string, unknown>,
							},
						]
					: [];
			} catch {
				return [];
			}
		});
	});
}

function visibleToolInputs(messages: readonly Message[]): ReadonlyMap<string, Record<string, unknown>> {
	const inputs = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") inputs.set(block.id, block.arguments);
		}
	}
	return inputs;
}

function normalizedRecoveryCursor(source: "task_notes" | "session_history", encoded: unknown): string | undefined {
	if (typeof encoded !== "string") return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (
			value === null ||
			typeof value !== "object" ||
			!("query" in value) ||
			typeof value.query !== "string" ||
			!("index" in value) ||
			typeof value.index !== "number" ||
			!("offset" in value) ||
			typeof value.offset !== "number" ||
			![value.index, value.offset].every((position) => Number.isSafeInteger(position) && position >= 0)
		)
			return undefined;
		if (source === "task_notes")
			return JSON.stringify({ source, query: value.query, index: value.index, offset: value.offset });
		if (
			!("version" in value) ||
			typeof value.version !== "number" ||
			!("sessionId" in value) ||
			typeof value.sessionId !== "string" ||
			!("windowId" in value) ||
			(value.windowId !== null && typeof value.windowId !== "string") ||
			!("block" in value) ||
			typeof value.block !== "number" ||
			!Number.isSafeInteger(value.block) ||
			value.block < 0
		)
			return undefined;
		return JSON.stringify({
			source,
			version: value.version,
			query: value.query,
			sessionId: value.sessionId,
			windowId: value.windowId,
			index: value.index,
			block: value.block,
			offset: value.offset,
		});
	} catch {
		return undefined;
	}
}

interface RecoveryInterval {
	offset: number;
	end: number;
	total: number;
}

function normalizedIntervals(intervals: RecoveryInterval[]): RecoveryInterval[] {
	const totals = new Set(intervals.map((interval) => interval.total));
	if (totals.size !== 1) return [];
	const merged: RecoveryInterval[] = [];
	for (const interval of [...intervals].sort((left, right) => left.offset - right.offset || left.end - right.end)) {
		const previous = merged.at(-1);
		if (previous && interval.offset <= previous.end) previous.end = Math.max(previous.end, interval.end);
		else merged.push({ ...interval });
	}
	return merged;
}

function intervalsCoverTotal(intervals: RecoveryInterval[]): boolean {
	if (intervals.length === 0) return false;
	const normalized = normalizedIntervals(intervals);
	if (normalized.length === 0) return false;
	const total = normalized[0].total;
	let covered = 0;
	for (const interval of normalized) {
		if (interval.offset > covered) return false;
		covered = Math.max(covered, interval.end);
	}
	return covered >= total;
}

function pageItems(page: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(page.items)
		? page.items.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
		: [];
}

function intervalMatchesText(
	item: Record<string, unknown>,
	expected: string,
): item is Record<string, unknown> & RecoveryInterval {
	if (
		typeof item.offset !== "number" ||
		typeof item.end !== "number" ||
		typeof item.total !== "number" ||
		typeof item.text !== "string" ||
		![item.offset, item.end, item.total].every(Number.isSafeInteger) ||
		item.offset < 0 ||
		item.end < item.offset ||
		item.total < item.end ||
		item.text.length !== item.end - item.offset
	)
		return false;
	return expected.length === item.total && expected.slice(item.offset, item.end) === item.text;
}

function referenceKey(
	reference: TaskNoteReference,
	historyById: ReadonlyMap<string, ReturnType<History["getItems"]>[number]>,
): string {
	const block = referenceBlock(historyById, reference);
	return `${reference.entryId}:${block?.blockIndex ?? reference.blockIndex ?? ""}`;
}

/** Derive recovery coverage exclusively from sourced text present in the final provider request. */
export function contextRecoveryCoverage(
	manager: SessionManager,
	messages: readonly Message[],
	recovery: ContextRecoveryReferences,
): ContextRecoveryCoverage {
	const pages = parseVisibleToolPages(messages);
	const toolInputs = visibleToolInputs(messages);
	const notePages = pages.filter(
		(record) => record.page.source === "task_notes" && record.page.revision === recovery.taskNoteProjectionRevision,
	);
	const historyPages = pages.filter((record) => record.page.source === "session_history");
	const branch = manager.getBranch();
	const scope = resolveTaskNoteScopeByTaskSource(branch, recovery.taskSourceEntryId);
	const projection = scope
		? buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch))
		: undefined;
	const expectedNotes = new Map(
		projection?.status === "valid" && projection.snapshot.revision === recovery.taskNoteProjectionRevision
			? projection.snapshot.items.map((item) => [item.eventId, item.text] as const)
			: [],
	);
	const history = new History(manager).getItems();
	const historyById = new Map(history.map((item) => [item.entryId, item]));
	const requiredHistory = dedupeReferences([...recovery.requirementSourceRefs, ...recovery.requiredHistoryRefs]);
	const requiredHistoryKeys = new Set(requiredHistory.map((reference) => referenceKey(reference, historyById)));
	const requiredTodoKeys = new Set(recovery.todoIds.map((todoId) => `${recovery.todoStateEntryId ?? ""}:${todoId}`));
	const requiredNoteIds = new Set([recovery.nextActionEventId, ...recovery.relatedNoteEventIds]);
	const resumeResolved = notePages.some((record) =>
		pageItems(record.page).some((item) => item.type === "next_action" && item.eventId === recovery.nextActionEventId),
	);
	const noteIntervals = new Map<string, RecoveryInterval[]>();
	const expectedSubagents = new Map(
		subagentRecoveryRecords(
			manager,
			recovery,
			projection?.status === "valid"
				? projection.snapshot.items.find((item) => item.eventId === recovery.subagentNoteEventId)
				: undefined,
		).map((item) => [item.taskId, item.text]),
	);
	const subagentIntervals = new Map<string, RecoveryInterval[]>();
	const historyIntervals = new Map<string, RecoveryInterval[]>();
	const todoIntervals = new Map<string, RecoveryInterval[]>();
	const discoveries = new Set<string>();
	const relevantCursors = new Set<string>();
	for (const record of notePages) {
		let relevantPage = false;
		for (const item of pageItems(record.page)) {
			if (item.type === "subagent_task" && typeof item.taskId === "string") {
				const expected = expectedSubagents.get(item.taskId);
				if (expected !== undefined && intervalMatchesText(item, expected)) {
					const intervals = subagentIntervals.get(item.taskId) ?? [];
					intervals.push({ offset: item.offset, end: item.end, total: item.total });
					subagentIntervals.set(item.taskId, intervals);
					discoveries.add(`subagent:${item.taskId}`);
					relevantPage = true;
				}
			}
			if (typeof item.eventId === "string" && requiredNoteIds.has(item.eventId)) {
				discoveries.add(`note:${item.eventId}`);
				relevantPage = true;
			}
			if (
				(item.type === "requirement_source" || item.type === "required_history") &&
				typeof item.entryId === "string"
			) {
				const key = `${item.entryId}:${typeof item.blockIndex === "number" ? item.blockIndex : ""}`;
				const matching = [...requiredHistoryKeys].find(
					(required) =>
						required === key || (item.blockIndex === undefined && required.startsWith(`${item.entryId}:`)),
				);
				if (matching) {
					discoveries.add(`history:${matching}`);
					relevantPage = true;
				}
			}
			if (item.type === "todo" && typeof item.todoId === "string" && recovery.todoIds.includes(item.todoId)) {
				discoveries.add(`todo:${item.todoId}`);
				relevantPage = true;
			}
			if (typeof item.eventId !== "string" || !requiredNoteIds.has(item.eventId)) continue;
			const expected = expectedNotes.get(item.eventId);
			if (expected === undefined || !intervalMatchesText(item, expected)) continue;
			const intervals = noteIntervals.get(item.eventId) ?? [];
			intervals.push({ offset: item.offset, end: item.end, total: item.total });
			noteIntervals.set(item.eventId, intervals);
		}
		const cursor = normalizedRecoveryCursor("task_notes", record.page.cursor);
		if (relevantPage && cursor) relevantCursors.add(cursor);
	}
	for (const record of historyPages) {
		let relevantPage = false;
		for (const item of pageItems(record.page)) {
			if (
				typeof item.entryId === "string" &&
				Array.isArray(item.blocks) &&
				[...requiredHistoryKeys].some((key) => key.startsWith(`${item.entryId}:`))
			) {
				discoveries.add(`history-location:${item.entryId}`);
				relevantPage = true;
			}
			if (
				typeof item.entryId !== "string" ||
				(typeof item.blockIndex !== "number" && typeof item.todoId !== "string")
			)
				continue;
			if (typeof item.todoId === "string") {
				const key = `${item.entryId}:${item.todoId}`;
				if (!requiredTodoKeys.has(key)) continue;
				discoveries.add(`todo:${item.todoId}`);
				relevantPage = true;
				const source = historyById.get(item.entryId);
				const todo = source?.todoItems?.find((candidate) => candidate.id === item.todoId);
				const expected = todo === undefined ? undefined : JSON.stringify(todo);
				if (
					item.revision !== recovery.todoStateFingerprint ||
					expected === undefined ||
					!intervalMatchesText(item, expected)
				)
					continue;
				const intervals = todoIntervals.get(key) ?? [];
				intervals.push({ offset: item.offset, end: item.end, total: item.total });
				todoIntervals.set(key, intervals);
			} else {
				const key = `${item.entryId}:${item.blockIndex}`;
				if (!requiredHistoryKeys.has(key)) continue;
				discoveries.add(`history:${key}`);
				relevantPage = true;
				const source = historyById
					.get(item.entryId)
					?.blocks.find((block) => block.blockIndex === item.blockIndex)?.text;
				if (source === undefined || !intervalMatchesText(item, source)) continue;
				const intervals = historyIntervals.get(key) ?? [];
				intervals.push({ offset: item.offset, end: item.end, total: item.total });
				historyIntervals.set(key, intervals);
			}
		}
		const input = toolInputs.get(record.toolCallId);
		const directoryAdvanced =
			record.toolName === "history" &&
			input !== undefined &&
			"operation" in input &&
			["list_windows", "list_items", "search"].includes(String(input.operation));
		const cursor = normalizedRecoveryCursor("session_history", record.page.cursor);
		if ((relevantPage || directoryAdvanced) && cursor) relevantCursors.add(cursor);
	}

	const missing: string[] = [];
	for (const taskId of expectedSubagents.keys()) {
		if (!intervalsCoverTotal(subagentIntervals.get(taskId) ?? [])) missing.push(`subagent:${taskId}`);
	}
	if (!resumeResolved) missing.push(`resume:${recovery.nextActionEventId}`);
	for (const eventId of [recovery.nextActionEventId, ...recovery.relatedNoteEventIds]) {
		if (!intervalsCoverTotal(noteIntervals.get(eventId) ?? [])) missing.push(`note:${eventId}`);
	}
	for (const reference of requiredHistory) {
		const key = referenceKey(reference, historyById);
		if (!intervalsCoverTotal(historyIntervals.get(key) ?? [])) missing.push(`history:${key}`);
	}
	for (const todoId of recovery.todoIds) {
		const key = `${recovery.todoStateEntryId ?? ""}:${todoId}`;
		if (!intervalsCoverTotal(todoIntervals.get(key) ?? [])) missing.push(`todo:${todoId}`);
	}
	const progress = {
		resumeResolved,
		subagents: [...subagentIntervals.entries()].map(([key, intervals]) => [key, normalizedIntervals(intervals)]),
		discoveries: [...discoveries].sort(),
		cursors: [...relevantCursors].sort(),
		notes: [...noteIntervals.entries()].map(([key, intervals]) => [key, normalizedIntervals(intervals)]),
		history: [...historyIntervals.entries()].map(([key, intervals]) => [key, normalizedIntervals(intervals)]),
		todos: [...todoIntervals.entries()].map(([key, intervals]) => [key, normalizedIntervals(intervals)]),
	};
	const coveredCharacters = [
		...subagentIntervals.values(),
		...noteIntervals.values(),
		...historyIntervals.values(),
		...todoIntervals.values(),
	]
		.flatMap(normalizedIntervals)
		.reduce((total, interval) => total + interval.end - interval.offset, 0);
	return {
		complete: missing.length === 0,
		progressFingerprint: fingerprintContextRolloverValue(progress),
		coveredUnits: discoveries.size + relevantCursors.size + coveredCharacters,
		missing,
		pages,
	};
}

/** Validate the immutable commit proof, then require a resolvable current effective contract. */
export function validateCommittedRecovery(manager: SessionManager, rollover: ContextRolloverEntry): boolean {
	const branch = manager.getBranch();
	const rolloverIndex = branch.findIndex((entry) => entry.id === rollover.id);
	if (rolloverIndex < 0) return false;
	const committedBranch = branch.slice(0, rolloverIndex);
	const scope = resolveTaskNoteScope(committedBranch, rollover.promptGeneration);
	if (!scope || scope.taskScopeId !== rollover.recovery.taskScopeId) return false;
	const projection = buildTaskNoteProjectionFromBranch(committedBranch, scope);
	if (projection.status !== "valid") return false;
	try {
		const handoff = rollover.recovery;
		if (handoff.subagentTasks.some((ref) => !committedBranch.some((entry) => entry.id === ref.sourceEntryId)))
			return false;
		subagentRecoveryRecords(
			manager,
			handoff,
			projection.snapshot.items.find((item) => item.eventId === handoff.nextActionEventId),
		);
	} catch {
		return false;
	}
	const expectedNotes = [rollover.recovery.nextActionEventId, ...rollover.recovery.relatedNoteEventIds];
	if (!expectedNotes.every((eventId) => projection.snapshot.items.some((item) => item.eventId === eventId)))
		return false;
	const history = new History(manager).getItems();
	const readable = new Set(history.map((item) => item.entryId));
	if (
		![...rollover.recovery.requiredHistoryRefs, ...rollover.recovery.requirementSourceRefs].every((reference) =>
			readable.has(reference.entryId),
		)
	)
		return false;
	const todo = [...committedBranch]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === "todo-state");
	if (
		rollover.recovery.todoStateEntryId === (todo?.id ?? null) &&
		rollover.recovery.todoStateFingerprint ===
			fingerprintContextRolloverValue(todo?.type === "custom" ? todo.data : [])
	) {
		try {
			currentContextRecoveryReferences(manager, rollover.recovery);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}
export function validateContextRecovery(
	manager: SessionManager,
	revisions: ContextRolloverRevisions,
): ContextRecoveryReferences {
	const branch = manager.getBranch();
	const scope = resolveTaskNoteScope(branch, manager.getLatestContextCoordinates().promptGeneration);
	if (!scope) throw new Error("recovery_unavailable");
	const currentWindow = currentContextWindow(branch)?.windowId;
	if (!currentWindow) throw new Error("recovery_unavailable");
	const operationEntry = latestSaveEntry(manager, currentWindow, scope.promptGeneration);
	if (!operationEntry || operationEntry.state !== "finished") throw new Error("continuation_state_missing");
	const operation = getSaveStateOperation(manager, currentWindow, scope.promptGeneration);
	if (!operation) throw new Error("continuation_state_missing");
	const continuation = validateContinuationState(manager, operation);
	if (continuation.status !== "valid") throw new Error(continuation.reason);
	if (
		operationEntry.finalTaskNoteRevision !== continuation.finalTaskNoteRevision ||
		operationEntry.nextActionEventId !== continuation.nextActionEventId ||
		JSON.stringify(operationEntry.relatedNoteEventIds ?? []) !== JSON.stringify(continuation.relatedNoteEventIds) ||
		JSON.stringify(operationEntry.noteFreshness ?? []) !== JSON.stringify(continuation.noteFreshness) ||
		JSON.stringify(operationEntry.requiredHistoryRefs ?? []) !== JSON.stringify(continuation.requiredHistoryRefs) ||
		JSON.stringify(operationEntry.requirementSourceRefs ?? []) !==
			JSON.stringify(continuation.requirementSourceRefs) ||
		JSON.stringify(operationEntry.todoIds ?? []) !== JSON.stringify(continuation.todoIds)
	)
		throw new Error("recovery_reference_invalid");
	const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
	if (projection.status !== "valid" || projection.snapshot.revision !== revisions.taskNoteProjectionRevision)
		throw new Error("recovery_unavailable");
	const readable = new History(manager).getItems();
	const task = readable.find((item) => item.role === "user" && createTaskScopeId(item.entryId) === scope.taskScopeId);
	if (
		!task ||
		!branch.at(-1) ||
		(revisions.todoStateEntryId !== null && !readable.some((item) => item.entryId === revisions.todoStateEntryId))
	)
		throw new Error("recovery_unavailable");
	const windowEntry = [...branch]
		.reverse()
		.find((entry) => entry.type === "context_window" || entry.type === "context_rollover");
	const windowIndex = windowEntry ? branch.indexOf(windowEntry) : -1;
	collectCompleteToolTransactions(branch.slice(Math.max(0, windowIndex + 1)));
	return {
		saveStateOperationId: operation.operationId,
		...captureSubagentHandoff(manager, scope, []),
		nextActionEventId: continuation.nextActionEventId,
		relatedNoteEventIds: continuation.relatedNoteEventIds,
		noteFreshness: continuation.noteFreshness,
		requiredHistoryRefs: continuation.requiredHistoryRefs,
		requirementSourceRefs: continuation.requirementSourceRefs,
		todoIds: continuation.todoIds,
		taskSourceEntryId: task.entryId,
		requirementsStartEntryId: task.entryId,
		historyCutoffEntryId: branch.at(-1)!.id,
		historyStartEntryId: [...readable].reverse().find((item) => item.role === "toolResult")?.entryId ?? task.entryId,
		todoStateEntryId: revisions.todoStateEntryId,
		todoStateFingerprint: revisions.todoStateFingerprint,
		taskNoteProjectionRevision: projection.snapshot.revision,
		taskScopeId: scope.taskScopeId,
	};
}

/** Owns preparation, commit and dispatch ordering, including restart recovery. */
export class ContextRollover {
	private dependencies: ContextRolloverDependencies;
	private inFlight: Promise<ContextRolloverOutcome> | undefined;
	private inFlightRequestId: string | undefined;
	constructor(dependencies: ContextRolloverDependencies) {
		this.dependencies = dependencies;
	}
	async run(request: ContextRolloverRequest): Promise<ContextRolloverOutcome> {
		while (this.inFlight) {
			const sameRequest = this.inFlightRequestId === request.requestId;
			const outcome = await this.inFlight;
			if (sameRequest) return outcome;
		}
		const promise = this.execute(request);
		this.inFlight = promise;
		this.inFlightRequestId = request.requestId;
		try {
			return await promise;
		} finally {
			this.inFlight = undefined;
			this.inFlightRequestId = undefined;
		}
	}
	private async execute(request: ContextRolloverRequest): Promise<ContextRolloverOutcome> {
		const { agent, manager, revisions, transitionGate, isCancelled, onTrace } = this.dependencies;
		const rolloverId = randomUUID();
		const identity = createContextWindowIdentity(manager.getBranch());
		const coordinates = manager.getLatestContextCoordinates();
		const base = {
			rolloverId,
			windowId: identity.windowId,
			cause: request.cause,
			promptGeneration: coordinates.promptGeneration,
			sourceContextEpoch: coordinates.contextEpoch,
		};
		const block = (
			reason: ContextRolloverBlockedReason,
			diagnostics: {
				recoveryWorksetTokens?: number;
				configuredContextWindow?: number;
				outputReserveTokens?: number;
				safetyTokens?: number;
			} = {},
		): ContextRolloverOutcome => {
			onTrace({ ...base, ...diagnostics, phase: "rollover", outcome: "blocked", reasonCode: reason });
			return { outcome: "blocked", reason };
		};
		let requiredTaskIds: string[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			if (isCancelled()) return { outcome: "cancelled" };
			if (
				request.cause !== "model_requested" ||
				!manager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "context_transition_request" &&
							entry.requestId === request.requestId &&
							entry.windowId === request.windowId &&
							entry.promptGeneration === coordinates.promptGeneration,
					)
			)
				return block("model_request_missing");
			const gate = transitionGate(requiredTaskIds);
			if (gate.status === "busy") return block("operation_in_flight");
			if (gate.status === "invalid") return block(gate.reason);
			requiredTaskIds = gate.requiredTaskIds;
			if (!this.dependencies.canRecover()) return block("recovery_unavailable");
			if (attempt > 0) request = { ...request, ...(await this.dependencies.measureSource()) };
			if (
				manager.ensureContextWindow().windowId !== request.windowId ||
				manager.getLatestContextCoordinates().promptGeneration !== coordinates.promptGeneration
			)
				return block("source_changed");
			const rollovers = manager.getBranch().filter((entry) => entry.type === "context_rollover");
			if (
				rollovers.some(
					(entry) => entry.previousWindowId === request.windowId || entry.requestId === request.requestId,
				)
			)
				return block("rollover_already_used");
			if (rollovers.filter((entry) => entry.promptGeneration === coordinates.promptGeneration).length >= 8)
				return block("rollover_limit");
			const expected = revisions();
			let recovery: ContextRecoveryReferences;
			try {
				recovery = {
					...validateContextRecovery(manager, expected),
					subagentTasks: gate.subagentTasks,
					requiredTaskIds,
					subagentNoteEventId: gate.subagentNoteEventId,
				};
			} catch (error) {
				return block(
					error instanceof Error && error.message === "subagent_handoff_invalid"
						? "subagent_handoff_invalid"
						: error instanceof Error && error.message === "tool_transaction_incomplete"
							? "tool_transaction_incomplete"
							: "continuation_state_changed",
				);
			}
			if (!this.dependencies.canRecover(recovery)) return block("recovery_unavailable");
			const provisional: ContextRolloverEntry = {
				type: "context_rollover",
				id: rolloverId,
				parentId: expected.sessionLeafId,
				timestamp: "1970-01-01T00:00:00.000Z",
				rolloverId,
				dispatchId: "pending",
				requestId: request.requestId,
				cause: request.cause,
				...identity,
				promptGeneration: coordinates.promptGeneration,
				sourceContextEpoch: coordinates.contextEpoch,
				targetContextEpoch: coordinates.contextEpoch + 1,
				recovery,
				expectedRevisions: expected,
				sourceTokens: request.budget.tokens,
				preparedTokens: 0,
				configuredContextWindow: agent.state.model.contextWindow,
				sourceRequestFingerprint: request.requestFingerprint,
				preparedRequestFingerprint: "pending",
				preparationBaseFingerprint: "pending",
				reservedDeliveryIds: [],
			};
			const messages = buildSessionContext([...manager.getEntries(), provisional], provisional.id).messages;
			let preparation: PreparedContinuation;
			try {
				preparation = await agent.prepareContinuation(messages, {
					toolNames: RECOVERY_TOOL_NAMES,
					maxTokens: Math.min(RECOVERY_OUTPUT_TOKENS, agent.state.model.maxTokens),
				});
			} catch {
				return block("invalid_continuation_context");
			}
			if (
				preparation.budget.decision !== "fits" ||
				contextRemaining(
					preparation.budget,
					{
						windowId: identity.windowId,
						measuredAtEntryId: expected.sessionLeafId,
						requestConfigRevision: expected.requestConfigFingerprint,
					},
					this.dependencies.workThresholdPercent(),
				).phase !== "normal"
			) {
				agent.releasePreparedContinuation(preparation);
				return block("prepared_context_limit");
			}
			if (
				preparation.requestFingerprint === request.requestFingerprint ||
				preparation.budget.tokens >= request.budget.tokens
			) {
				agent.releasePreparedContinuation(preparation);
				return block("unchanged_request");
			}
			const preparedGate = transitionGate(requiredTaskIds);
			if (
				isCancelled() ||
				preparedGate.status !== "ready" ||
				!this.dependencies.canRecover(recovery) ||
				JSON.stringify(revisions()) !== JSON.stringify(expected)
			) {
				agent.releasePreparedContinuation(preparation);
				if (isCancelled()) return { outcome: "cancelled" };
				if (preparedGate.status === "invalid") return block(preparedGate.reason);
				if (preparedGate.status === "busy") return block("operation_in_flight");
				if (attempt === 0) continue;
				return block("source_changed");
			}
			let worksetBudget: ContextBudget;
			try {
				const workset = JSON.stringify(recoveryWorkset(manager, recovery, coordinates.promptGeneration));
				const minimumPages =
					2 +
					recovery.relatedNoteEventIds.length +
					recovery.requiredHistoryRefs.length +
					recovery.requirementSourceRefs.length +
					recovery.todoIds.length +
					recovery.subagentTasks.length;
				const pageCount = Math.max(minimumPages, Math.ceil(estimateTextTokens(workset) / 2048));
				worksetBudget = await agent.measurePreparedContinuation(
					preparation,
					[
						{
							role: "custom",
							customType: "context-recovery-workset-preflight",
							content: `${workset}\n${"[recovery page metadata and cursor] ".repeat(pageCount * 16)}`,
							display: false,
							timestamp: 0,
						},
						{
							role: "custom",
							customType: "context-recovery-complete",
							content:
								"Required continuation sources are present in the preceding provider request. Continue the current task from next_action/current.",
							display: false,
							timestamp: 0,
						},
					],
					{
						toolNames: agent.state.tools.map((tool) => tool.name),
						maxTokens: agent.state.model.maxTokens,
					},
				);
			} catch {
				agent.releasePreparedContinuation(preparation);
				return block("recovery_workset_too_large", {
					configuredContextWindow: agent.state.model.contextWindow,
				});
			}
			const worksetRemaining = contextRemaining(
				worksetBudget,
				{
					windowId: identity.windowId,
					measuredAtEntryId: expected.sessionLeafId,
					requestConfigRevision: expected.requestConfigFingerprint,
				},
				this.dependencies.workThresholdPercent(),
			);
			const worksetDiagnostics = {
				recoveryWorksetTokens: worksetBudget.tokens,
				configuredContextWindow: worksetBudget.contextWindow,
				outputReserveTokens: worksetBudget.outputReserveTokens,
				safetyTokens: worksetBudget.safetyTokens,
			};
			if (worksetBudget.decision !== "fits" || worksetRemaining.phase !== "normal") {
				agent.releasePreparedContinuation(preparation);
				return block("recovery_workset_too_large", worksetDiagnostics);
			}
			const commitGate = transitionGate(requiredTaskIds);
			if (
				isCancelled() ||
				commitGate.status !== "ready" ||
				!this.dependencies.canRecover(recovery) ||
				JSON.stringify(revisions()) !== JSON.stringify(expected)
			) {
				agent.releasePreparedContinuation(preparation);
				if (isCancelled()) return { outcome: "cancelled" };
				if (commitGate.status === "invalid") return block(commitGate.reason);
				if (commitGate.status === "busy") return block("operation_in_flight");
				if (attempt === 0) continue;
				return block("source_changed");
			}
			const { type: _type, id: _id, parentId: _parentId, timestamp: _timestamp, ...input } = provisional;
			const record = {
				...input,
				dispatchId: createContextRolloverDispatchId(rolloverId, preparation.requestFingerprint),
				preparedTokens: preparation.budget.tokens,
				preparedRequestFingerprint: preparation.requestFingerprint,
				preparationBaseFingerprint: preparation.baseContextFingerprint,
				reservedDeliveryIds: [...preparation.reservedQueueItemIds],
			};
			try {
				manager.appendContextRollover(record);
			} catch {
				agent.releasePreparedContinuation(preparation);
				return block("source_changed");
			}
			onTrace({
				...base,
				phase: "rollover",
				outcome: "committed",
				targetContextEpoch: record.targetContextEpoch,
				sourceTokens: request.budget.tokens,
				preparedTokens: preparation.budget.tokens,
				reservedDeliveryCount: record.reservedDeliveryIds.length,
			});
			if (
				fingerprintContextRolloverValue(manager.buildSessionContext().messages) !==
				fingerprintContextRolloverValue(messages)
			) {
				agent.releasePreparedContinuation(preparation);
				manager.appendContextRolloverDispatch({
					dispatchId: record.dispatchId,
					rolloverId,
					state: "blocked",
					requestFingerprint: record.preparedRequestFingerprint,
					reason: "post_commit_mismatch",
				});
				return block("post_commit_mismatch");
			}
			return await this.dispatch(record, preparation);
		}
		return block("source_changed");
	}
	private async dispatch(
		record: Omit<ContextRolloverEntry, "type" | "id" | "parentId" | "timestamp">,
		preparation: PreparedContinuation,
	): Promise<ContextRolloverOutcome> {
		const { agent, manager, isCancelled, pendingDeliveryIds } = this.dependencies;
		const data = {
			dispatchId: record.dispatchId,
			rolloverId: record.rolloverId,
			requestFingerprint: record.preparedRequestFingerprint,
		};
		if (isCancelled() || record.reservedDeliveryIds.some((id) => !pendingDeliveryIds().includes(id))) {
			agent.releasePreparedContinuation(preparation);
			manager.appendContextRolloverDispatch({ ...data, state: "cancelled" });
			return { outcome: "cancelled" };
		}
		try {
			manager.appendContextRolloverDispatch({
				...data,
				state: "started",
				reservedDeliveryIds: record.reservedDeliveryIds,
			});
		} catch {
			agent.releasePreparedContinuation(preparation);
			return { outcome: "blocked", reason: "source_changed" };
		}
		return await this.runStartedDispatch(
			record,
			preparation.preparationId,
			async () => await agent.dispatchPreparedContinuation(preparation),
		);
	}
	private async runStartedDispatch(
		record: Omit<ContextRolloverEntry, "type" | "id" | "parentId" | "timestamp">,
		preparationId: string | undefined,
		run: () => Promise<void>,
	): Promise<ContextRolloverOutcome> {
		const { agent, manager, onDispatch, onTrace } = this.dependencies;
		const data = {
			dispatchId: record.dispatchId,
			rolloverId: record.rolloverId,
			requestFingerprint: record.preparedRequestFingerprint,
		};
		const trace = {
			rolloverId: record.rolloverId,
			windowId: record.windowId,
			cause: record.cause,
			dispatchId: record.dispatchId,
			promptGeneration: record.promptGeneration,
			sourceContextEpoch: record.sourceContextEpoch,
			targetContextEpoch: record.targetContextEpoch,
			phase: "dispatch" as const,
		};
		onDispatch(preparationId);
		onTrace({ ...trace, outcome: "started" });
		try {
			await run();
			const state = agent.state.runState;
			const outcome = state.status === "idle" ? state.lastOutcome?.type : undefined;
			const failureMessage =
				state.status === "idle" && state.lastOutcome?.type === "failed" ? state.lastOutcome.message : undefined;
			const last = agent.state.messages.at(-1);
			const rejected =
				last?.role === "assistant" &&
				last.stopReason === "error" &&
				last.content.every((block) => block.type !== "toolCall") &&
				isContextOverflow(last, agent.state.model.contextWindow);
			if (
				outcome === "failed" &&
				!rejected &&
				!failureMessage?.startsWith("recovery_") &&
				failureMessage !== "subagent_handoff_invalid"
			) {
				onTrace({ ...trace, outcome: "outcome_unknown", reasonCode: "dispatch_outcome_unknown" });
				return { outcome: "blocked", reason: "dispatch_outcome_unknown" };
			}
			manager.appendContextRolloverDispatch({
				...data,
				state: "finished",
				outcome: rejected
					? "context_limit"
					: outcome === "context_limit" ||
							outcome === "context_transition" ||
							outcome === "context_maintenance" ||
							outcome === "aborted" ||
							outcome === "failed"
						? outcome
						: "completed",
			});
			onTrace({ ...trace, outcome: "finished" });
			return { outcome: "dispatched" };
		} finally {
			onDispatch(undefined);
		}
	}
	async resumeInterrupted(
		record: ContextRolloverEntry,
		options: { continueRun: boolean; recovering: boolean },
	): Promise<ContextRolloverOutcome> {
		const { agent, manager, transitionGate, isCancelled, onTrace } = this.dependencies;
		const data = {
			dispatchId: record.dispatchId,
			rolloverId: record.rolloverId,
			requestFingerprint: record.preparedRequestFingerprint,
		};
		if (isCancelled()) return { outcome: "cancelled" };
		const gate = transitionGate();
		if (gate.status !== "ready")
			return { outcome: "blocked", reason: gate.status === "busy" ? "operation_in_flight" : gate.reason };
		if (!options.continueRun) {
			manager.appendContextRolloverDispatch({ ...data, state: "finished", outcome: "completed" });
			onTrace({
				rolloverId: record.rolloverId,
				windowId: record.windowId,
				cause: record.cause,
				dispatchId: record.dispatchId,
				promptGeneration: record.promptGeneration,
				sourceContextEpoch: record.sourceContextEpoch,
				targetContextEpoch: record.targetContextEpoch,
				phase: "dispatch",
				outcome: "finished",
			});
			return { outcome: "dispatched" };
		}
		manager.appendContextRolloverDispatch({ ...data, state: "started", reservedDeliveryIds: [] });
		return await this.runStartedDispatch(record, undefined, async () => {
			await agent.continue(
				options.recovering
					? {
							toolNames: RECOVERY_TOOL_NAMES,
							maxTokens: Math.min(RECOVERY_OUTPUT_TOKENS, agent.state.model.maxTokens),
						}
					: {},
			);
		});
	}
	async resume(): Promise<ContextRolloverOutcome | undefined> {
		const { agent, manager } = this.dependencies;
		const state = manager.getContextRolloverState();
		if (state.dispatchState === "outcome_unknown") return { outcome: "blocked", reason: "dispatch_outcome_unknown" };
		if (state.dispatchState !== "prepared") return undefined;
		const record = manager
			.getBranch()
			.reverse()
			.find((entry) => entry.type === "context_rollover" && entry.rolloverId === state.rolloverId);
		if (record?.type !== "context_rollover") return undefined;
		const gate = this.dependencies.transitionGate();
		if (gate.status !== "ready")
			return { outcome: "blocked", reason: gate.status === "busy" ? "operation_in_flight" : gate.reason };
		if (
			!this.dependencies.canRecover() ||
			record.dispatchId !== createContextRolloverDispatchId(record.rolloverId, record.preparedRequestFingerprint)
		)
			return { outcome: "blocked", reason: "dispatch_prepare_mismatch" };
		let preparation: PreparedContinuation;
		try {
			preparation = await agent.prepareContinuation(manager.buildSessionContext().messages, {
				requiredQueueItemIds: record.reservedDeliveryIds,
				toolNames: RECOVERY_TOOL_NAMES,
				maxTokens: Math.min(RECOVERY_OUTPUT_TOKENS, agent.state.model.maxTokens),
			});
		} catch {
			return { outcome: "blocked", reason: "dispatch_prepare_mismatch" };
		}
		if (
			preparation.requestFingerprint !== record.preparedRequestFingerprint ||
			preparation.baseContextFingerprint !== record.preparationBaseFingerprint ||
			preparation.budget.tokens !== record.preparedTokens ||
			JSON.stringify(preparation.reservedQueueItemIds) !== JSON.stringify(record.reservedDeliveryIds)
		) {
			agent.releasePreparedContinuation(preparation);
			manager.appendContextRolloverDispatch({
				dispatchId: record.dispatchId,
				rolloverId: record.rolloverId,
				requestFingerprint: record.preparedRequestFingerprint,
				state: "blocked",
				reason: "dispatch_prepare_mismatch",
			});
			return { outcome: "blocked", reason: "dispatch_prepare_mismatch" };
		}
		return await this.dispatch(record, preparation);
	}
}
