import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ContextProgressEntry, SessionEntry } from "./session-manager.ts";

export const MAX_ACTIVE_TASK_NOTES = 64;
export const MAX_TASK_NOTE_TEXT_CHARS = 2000;
export const MAX_TASK_NOTE_SOURCE_REFS = 8;
export const MAX_TASK_NOTE_EVIDENCE_REFS = 8;
export const MAX_TASK_NOTE_RESUME_REFS = 8;

export const TASK_NOTE_KINDS = ["constraint", "decision", "state", "next_action", "failed_attempt"] as const;
export type TaskNoteKind = (typeof TASK_NOTE_KINDS)[number];
export type TaskNoteFreshness = "fresh" | "stale" | "unknown" | "not_applicable";

export interface TaskNoteScope {
	taskScopeId: string;
	promptGeneration: number;
}

export interface TaskNoteReference {
	entryId: string;
	blockIndex?: number;
}

export interface NextActionResume {
	relatedNotes: Array<{ kind: TaskNoteKind; key: string }>;
	requiredHistoryRefs: TaskNoteReference[];
	requirementSourceRefs: TaskNoteReference[];
	todoIds: string[];
	subagentContinuations: Array<{ taskId: string; parentRelation: string; onResult: string }>;
}

export type TaskNoteCandidate =
	| {
			operation: "upsert";
			kind: TaskNoteKind;
			key: string;
			text: string;
			sourceRefs: TaskNoteReference[];
			evidenceRefs: TaskNoteReference[];
			resume?: NextActionResume;
			supersedesEventId?: string;
	  }
	| {
			operation: "retract";
			kind: TaskNoteKind;
			key: string;
			sourceRefs: TaskNoteReference[];
			supersedesEventId: string;
	  };

export interface TaskNoteEvidenceStamp {
	reference: TaskNoteReference;
	evidenceKind: "user_confirmation" | "workspace_state" | "process_result" | "task_terminal" | "external_readback";
	subjectId: string;
	inputFingerprint: string;
	resultFingerprint: string;
	observedAtEntryId: string;
	outcome: "succeeded" | "failed";
}

export type TaskNoteEventSource = { type: "model_tool"; toolCallId: string };

export interface TaskNoteEvent {
	version: 1;
	eventId: string;
	scope: TaskNoteScope;
	createdInContextEpoch: number;
	operation: "upsert" | "retract";
	kind: TaskNoteKind;
	key: string;
	text?: string;
	sourceRefs: TaskNoteReference[];
	evidence: TaskNoteEvidenceStamp[];
	resume?: NextActionResume;
	supersedesEventId?: string;
	source: TaskNoteEventSource;
}

export interface TaskNoteProjectionItem {
	eventId: string;
	kind: TaskNoteKind;
	key: string;
	text: string;
	sourceRefs: readonly TaskNoteReference[];
	evidence: readonly TaskNoteEvidenceStamp[];
	resume?: NextActionResume;
	freshness: TaskNoteFreshness;
}

export interface TaskNoteProjectionSnapshot {
	scope: TaskNoteScope;
	revision: string;
	items: readonly TaskNoteProjectionItem[];
}

export type TaskNoteProjectionResult =
	| { status: "valid"; snapshot: TaskNoteProjectionSnapshot; events: readonly TaskNoteEvent[] }
	| { status: "projection_invalid"; reason: string };

export interface TaskNoteProjectionInput {
	events: readonly TaskNoteEvent[];
	scope: TaskNoteScope;
	resolveFreshness?: (stamp: TaskNoteEvidenceStamp) => TaskNoteFreshness;
}

export type TaskNoteBranchProjectionResult =
	| { status: "valid"; snapshot: TaskNoteProjectionSnapshot; events: readonly TaskNoteEvent[] }
	| { status: "projection_invalid"; reason: string };

export interface TaskNoteAcceptanceContext {
	scope: TaskNoteScope;
	contextEpoch: number;
	source: TaskNoteEventSource;
	branch: readonly SessionEntry[];
	projection: TaskNoteProjectionSnapshot;
	allowedEntryIds?: ReadonlySet<string>;
}

export type TaskNoteAcceptanceFailureReason =
	| "invalid_output"
	| "invalid_reference"
	| "invalid_evidence"
	| "invalid_supersession"
	| "unsafe_content"
	| "note_limit";

export type TaskNoteAcceptanceResult =
	| { status: "accepted"; event: TaskNoteEvent }
	| { status: "rejected"; reason: TaskNoteAcceptanceFailureReason };

const KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,95}$/;
const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\bsk-[A-Za-z0-9_-]{16,}\b/,
	/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
];

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hash(...parts: string[]): string {
	const digest = createHash("sha256");
	for (const part of parts) digest.update(part);
	return digest.digest("hex");
}

function sameScope(left: TaskNoteScope, right: TaskNoteScope): boolean {
	return left.taskScopeId === right.taskScopeId && left.promptGeneration === right.promptGeneration;
}

function identity(kind: TaskNoteKind, key: string): string {
	return `${kind}\u0000${key}`;
}

function containsPotentialSecret(value: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function isTaskNoteKind(value: unknown): value is TaskNoteKind {
	return typeof value === "string" && (TASK_NOTE_KINDS as readonly string[]).includes(value);
}

function validReference(value: unknown): value is TaskNoteReference {
	if (value === null || typeof value !== "object") return false;
	const reference = value as Partial<TaskNoteReference>;
	const keys = Object.keys(value);
	return (
		keys.every((key) => key === "entryId" || key === "blockIndex") &&
		typeof reference.entryId === "string" &&
		reference.entryId.length > 0 &&
		(reference.blockIndex === undefined || (Number.isInteger(reference.blockIndex) && reference.blockIndex >= -1))
	);
}

function validSource(value: unknown): value is TaskNoteEventSource {
	if (value === null || typeof value !== "object") return false;
	const source = value as Partial<TaskNoteEventSource>;
	if (source.type === "model_tool") {
		return Object.keys(value).length === 2 && typeof source.toolCallId === "string" && source.toolCallId.length > 0;
	}

	return false;
}

function validResume(value: unknown, kind: TaskNoteKind, key: string): value is NextActionResume {
	if (value === null || typeof value !== "object") return false;
	const resume = value as Partial<NextActionResume>;
	if (
		!Object.keys(value).every((name) =>
			["relatedNotes", "requiredHistoryRefs", "requirementSourceRefs", "todoIds", "subagentContinuations"].includes(
				name,
			),
		) ||
		!Array.isArray(resume.relatedNotes) ||
		!Array.isArray(resume.requiredHistoryRefs) ||
		!Array.isArray(resume.requirementSourceRefs) ||
		!Array.isArray(resume.todoIds) ||
		!Array.isArray(resume.subagentContinuations) ||
		[
			resume.relatedNotes.length,
			resume.requiredHistoryRefs.length,
			resume.requirementSourceRefs.length,
			resume.todoIds.length,
		].some((length) => length > MAX_TASK_NOTE_RESUME_REFS)
	)
		return false;
	if (
		!resume.subagentContinuations.every(
			(item) =>
				item !== null &&
				typeof item === "object" &&
				Object.keys(item).length === 3 &&
				typeof item.taskId === "string" &&
				item.taskId.length > 0 &&
				item.taskId.length <= 128 &&
				[item.parentRelation, item.onResult].every(
					(text) =>
						typeof text === "string" &&
						text.trim().length > 0 &&
						text.length <= MAX_TASK_NOTE_TEXT_CHARS &&
						!containsPotentialSecret(text),
				),
		) ||
		new Set(resume.subagentContinuations.map((item) => item.taskId)).size !== resume.subagentContinuations.length
	)
		return false;
	const related = resume.relatedNotes;
	if (
		!related.every(
			(item) =>
				item !== null &&
				typeof item === "object" &&
				Object.keys(item).length === 2 &&
				isTaskNoteKind(item.kind) &&
				typeof item.key === "string" &&
				KEY_PATTERN.test(item.key) &&
				(item.kind !== kind || item.key !== key),
		) ||
		new Set(related.map((item) => identity(item.kind, item.key))).size !== related.length
	)
		return false;
	if (
		!resume.requiredHistoryRefs.every(validReference) ||
		new Set(resume.requiredHistoryRefs.map((reference) => canonical(reference))).size !==
			resume.requiredHistoryRefs.length ||
		!resume.requirementSourceRefs.every(validReference) ||
		new Set(resume.requirementSourceRefs.map((reference) => canonical(reference))).size !==
			resume.requirementSourceRefs.length ||
		!resume.todoIds.every((todoId) => typeof todoId === "string" && todoId.length > 0 && todoId.length <= 128) ||
		new Set(resume.todoIds).size !== resume.todoIds.length
	)
		return false;
	return true;
}

function validEvidence(value: unknown): value is TaskNoteEvidenceStamp {
	if (value === null || typeof value !== "object") return false;
	const evidence = value as Partial<TaskNoteEvidenceStamp>;
	return (
		Object.keys(value).length === 7 &&
		validReference(evidence.reference) &&
		["user_confirmation", "workspace_state", "process_result", "task_terminal", "external_readback"].includes(
			evidence.evidenceKind ?? "",
		) &&
		typeof evidence.subjectId === "string" &&
		typeof evidence.inputFingerprint === "string" &&
		typeof evidence.resultFingerprint === "string" &&
		typeof evidence.observedAtEntryId === "string" &&
		(evidence.outcome === "succeeded" || evidence.outcome === "failed")
	);
}

export function isTaskNoteEvent(value: unknown): value is TaskNoteEvent {
	if (value === null || typeof value !== "object") return false;
	const event = value as Partial<TaskNoteEvent>;
	const expectedKeys = new Set([
		"version",
		"eventId",
		"scope",
		"createdInContextEpoch",
		"operation",
		"kind",
		"key",
		"text",
		"sourceRefs",
		"evidence",
		"resume",
		"supersedesEventId",
		"source",
	]);
	if (!Object.keys(value).every((key) => expectedKeys.has(key))) return false;
	const scopeKeys = event.scope && typeof event.scope === "object" ? Object.keys(event.scope) : [];
	return (
		event.version === 1 &&
		typeof event.eventId === "string" &&
		event.eventId.length > 0 &&
		event.scope !== undefined &&
		scopeKeys.length === 2 &&
		scopeKeys.includes("taskScopeId") &&
		scopeKeys.includes("promptGeneration") &&
		typeof event.scope.taskScopeId === "string" &&
		event.scope.taskScopeId.length > 0 &&
		Number.isInteger(event.scope.promptGeneration) &&
		typeof event.scope.promptGeneration === "number" &&
		event.scope.promptGeneration >= 0 &&
		Number.isInteger(event.createdInContextEpoch) &&
		typeof event.createdInContextEpoch === "number" &&
		event.createdInContextEpoch >= 0 &&
		(event.operation === "upsert" || event.operation === "retract") &&
		isTaskNoteKind(event.kind) &&
		typeof event.key === "string" &&
		KEY_PATTERN.test(event.key) &&
		Array.isArray(event.sourceRefs) &&
		event.sourceRefs.length > 0 &&
		event.sourceRefs.length <= MAX_TASK_NOTE_SOURCE_REFS &&
		event.sourceRefs.every(validReference) &&
		Array.isArray(event.evidence) &&
		event.evidence.length <= MAX_TASK_NOTE_EVIDENCE_REFS &&
		event.evidence.every(validEvidence) &&
		validSource(event.source) &&
		(event.operation === "upsert"
			? typeof event.text === "string" &&
				event.text.trim().length > 0 &&
				event.text.length <= MAX_TASK_NOTE_TEXT_CHARS &&
				(event.kind === "next_action" && event.key === "current"
					? validResume(event.resume, event.kind, event.key)
					: event.resume === undefined)
			: event.text === undefined &&
				event.resume === undefined &&
				event.evidence.length === 0 &&
				typeof event.supersedesEventId === "string" &&
				event.supersedesEventId.length > 0)
	);
}

export function createTaskScopeId(rootUserEntryId: string): string {
	return hash("task-note-scope-v1", rootUserEntryId);
}

export function fingerprintTaskNoteWorkspaceContent(content: string | undefined): string {
	return hash("task-note-workspace-state-v1", content === undefined ? "missing" : content);
}

export function resolveTaskNoteScope(
	branch: readonly SessionEntry[],
	promptGeneration: number,
): TaskNoteScope | undefined {
	let markerIndex = -1;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== "context-prompt-generation") continue;
		if (entry.data === null || typeof entry.data !== "object") continue;
		const data = entry.data as { promptGeneration?: unknown };
		if (data.promptGeneration === promptGeneration) markerIndex = index;
	}
	for (let index = markerIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") {
			return { taskScopeId: createTaskScopeId(entry.id), promptGeneration };
		}
	}
	return undefined;
}

/** Resolve the historical Note scope rooted at an explicitly selected, branch-visible user entry. */
export function resolveTaskNoteScopeByTaskSource(
	branch: readonly SessionEntry[],
	taskSourceEntryId: string,
): TaskNoteScope | undefined {
	const sourceIndex = branch.findIndex(
		(entry) => entry.id === taskSourceEntryId && entry.type === "message" && entry.message.role === "user",
	);
	if (sourceIndex < 0) return undefined;
	let promptGeneration = 0;
	for (const entry of branch.slice(0, sourceIndex + 1)) {
		if (entry.type !== "custom" || entry.customType !== "context-prompt-generation") continue;
		if (entry.data === null || typeof entry.data !== "object" || !("promptGeneration" in entry.data)) continue;
		if (typeof entry.data.promptGeneration === "number" && Number.isInteger(entry.data.promptGeneration)) {
			promptGeneration = entry.data.promptGeneration;
		}
	}
	return { taskScopeId: createTaskScopeId(taskSourceEntryId), promptGeneration };
}

export function buildTaskNoteProjectionFromBranch(
	branch: readonly SessionEntry[],
	scope: TaskNoteScope,
	resolveFreshness?: (stamp: TaskNoteEvidenceStamp) => TaskNoteFreshness,
): TaskNoteBranchProjectionResult {
	const events: TaskNoteEvent[] = [];
	const entries = new Map(branch.map((entry) => [entry.id, entry]));
	const allowedEntryIds = new Set(entries.keys());
	for (const entry of branch) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "task-note-event") {
			if (!isTaskNoteEvent(entry.data)) return { status: "projection_invalid", reason: "invalid_event" };
			if (!persistedEventEvidenceIsValid(entry.data, branch, entries, allowedEntryIds)) {
				return { status: "projection_invalid", reason: "invalid_evidence" };
			}
			events.push(entry.data);
		}
	}
	return buildTaskNoteProjection({ events, scope, resolveFreshness });
}

function persistedEventEvidenceIsValid(
	event: TaskNoteEvent,
	branch: readonly SessionEntry[],
	entries: ReadonlyMap<string, SessionEntry>,
	allowedEntryIds: ReadonlySet<string>,
): boolean {
	const sources = event.sourceRefs.map((reference) => resolveReference(reference, entries, allowedEntryIds));
	if (sources.some((entry) => entry === undefined || !isClaimSource(entry))) return false;
	if (event.kind === "constraint" && !sources.some((entry) => entry !== undefined && isUserEntry(entry))) return false;
	for (const stamp of event.evidence) {
		const evidenceEntry = resolveReference(stamp.reference, entries, allowedEntryIds);
		if (evidenceEntry === undefined) return false;
		const expected = stampEvidence(stamp.reference, evidenceEntry);
		if (expected === undefined || canonical(expected) !== canonical(stamp)) return false;
	}
	if (event.source.type === "model_tool") {
		const toolCallId = event.source.toolCallId;
		return branch.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(block) => block.type === "toolCall" && block.id === toolCallId && block.name === "context_note",
				),
		);
	}
	return true;
}

export function createTaskNoteEventId(
	scope: TaskNoteScope,
	source: TaskNoteEventSource,
	candidate: TaskNoteCandidate,
): string {
	return hash("task-note-event-v1", scope.taskScopeId, source.type, source.toolCallId, canonical(candidate));
}

function defaultFreshness(stamp: TaskNoteEvidenceStamp): TaskNoteFreshness {
	return stamp.evidenceKind === "user_confirmation" ? "not_applicable" : "unknown";
}

export function buildTaskNoteProjection(input: TaskNoteProjectionInput): TaskNoteProjectionResult {
	const activeByIdentity = new Map<string, TaskNoteEvent>();
	const eventPayloads = new Map<string, string>();
	const accepted: TaskNoteEvent[] = [];

	for (const event of input.events) {
		if (!isTaskNoteEvent(event)) return { status: "projection_invalid", reason: "invalid_event" };
		if (event.text !== undefined && containsPotentialSecret(event.text)) {
			return { status: "projection_invalid", reason: "unsafe_content" };
		}
		if (
			(event.operation === "upsert" &&
				event.kind === "state" &&
				(event.evidence.length === 0 || event.evidence.some((stamp) => stamp.outcome !== "succeeded"))) ||
			(event.operation === "upsert" &&
				event.kind === "failed_attempt" &&
				(event.evidence.length === 0 || event.evidence.some((stamp) => stamp.outcome !== "failed")))
		) {
			return { status: "projection_invalid", reason: "invalid_evidence" };
		}
		if (!sameScope(event.scope, input.scope)) continue;
		const payload = canonical(event);
		const previousPayload = eventPayloads.get(event.eventId);
		if (previousPayload !== undefined) {
			if (previousPayload !== payload) return { status: "projection_invalid", reason: "event_id_conflict" };
			continue;
		}
		eventPayloads.set(event.eventId, payload);
		if (event.eventId !== createTaskNoteEventId(event.scope, event.source, eventToCandidate(event))) {
			return { status: "projection_invalid", reason: "event_id_mismatch" };
		}

		const noteIdentity = identity(event.kind, event.key);
		const current = activeByIdentity.get(noteIdentity);
		if (event.operation === "upsert") {
			if (current === undefined && event.supersedesEventId !== undefined) {
				return { status: "projection_invalid", reason: "broken_supersession" };
			}
			if (current !== undefined && event.supersedesEventId !== current.eventId) {
				return { status: "projection_invalid", reason: "broken_supersession" };
			}
			activeByIdentity.set(noteIdentity, event);
		} else {
			if (current === undefined || event.supersedesEventId !== current.eventId) {
				return { status: "projection_invalid", reason: "broken_retraction" };
			}
			activeByIdentity.delete(noteIdentity);
		}
		accepted.push(event);
	}

	if (activeByIdentity.size > MAX_ACTIVE_TASK_NOTES) {
		return { status: "projection_invalid", reason: "note_limit" };
	}

	const freshness = input.resolveFreshness ?? defaultFreshness;
	const items = [...activeByIdentity.values()].map((event): TaskNoteProjectionItem => {
		const evidenceFreshness = event.evidence.map(freshness);
		const itemFreshness =
			evidenceFreshness.length === 0
				? "not_applicable"
				: evidenceFreshness.includes("stale")
					? "stale"
					: evidenceFreshness.includes("unknown")
						? "unknown"
						: evidenceFreshness.every((value) => value === "not_applicable")
							? "not_applicable"
							: "fresh";
		return {
			eventId: event.eventId,
			kind: event.kind,
			key: event.key,
			text: event.text ?? "",
			sourceRefs: event.sourceRefs,
			evidence: event.evidence,
			...(event.resume === undefined ? {} : { resume: event.resume }),
			freshness: itemFreshness,
		};
	});
	const snapshotWithoutRevision = { scope: input.scope, items };
	return {
		status: "valid",
		snapshot: {
			...snapshotWithoutRevision,
			revision: hash("task-note-projection-v1", canonical(snapshotWithoutRevision)),
		},
		events: accepted,
	};
}

function eventToCandidate(event: TaskNoteEvent): TaskNoteCandidate {
	if (event.operation === "retract") {
		return {
			operation: "retract",
			kind: event.kind,
			key: event.key,
			sourceRefs: event.sourceRefs,
			supersedesEventId: event.supersedesEventId ?? "",
		};
	}
	return {
		operation: "upsert",
		kind: event.kind,
		key: event.key,
		text: event.text ?? "",
		sourceRefs: event.sourceRefs,
		evidenceRefs: event.evidence.map((stamp) => stamp.reference),
		...(event.resume === undefined ? {} : { resume: event.resume }),
		...(event.supersedesEventId === undefined ? {} : { supersedesEventId: event.supersedesEventId }),
	};
}

function referenceBlockIsValid(entry: SessionEntry, blockIndex: number | undefined): boolean {
	if (blockIndex === undefined) return true;
	if (entry.type === "custom" && entry.customType === "todo-state") return blockIndex === -1;
	if (entry.type === "tool_result_source") return entry.content[blockIndex]?.type === "text";
	if (entry.type === "message") {
		if (entry.message.role === "bashExecution") return blockIndex === -1 && !entry.message.excludeFromContext;
		if (entry.message.role === "branchSummary" || entry.message.role === "compactionSummary")
			return blockIndex === -1;
		if (!("content" in entry.message)) return false;
		if (typeof entry.message.content === "string") return blockIndex === -1;
		return entry.message.content[blockIndex]?.type === "text";
	}
	if (entry.type === "custom_message") {
		if (typeof entry.content === "string") return blockIndex === -1;
		return entry.content[blockIndex]?.type === "text";
	}
	return false;
}

function resolveReference(
	reference: TaskNoteReference,
	entries: ReadonlyMap<string, SessionEntry>,
	allowedEntryIds: ReadonlySet<string>,
): SessionEntry | undefined {
	const entry = entries.get(reference.entryId);
	if (entry === undefined || !allowedEntryIds.has(reference.entryId)) return undefined;
	if (!referenceBlockIsValid(entry, reference.blockIndex)) return undefined;
	return entry;
}

function isClaimSource(entry: SessionEntry): boolean {
	if (entry.type === "tool_result_source") return true;
	if (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.every((block) => block.type === "thinking")
	)
		return false;
	if (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		["memory_get", "memory_search", "history", "context_note"].includes(entry.message.toolName)
	)
		return false;
	if (entry.type === "message" && entry.message.role === "bashExecution" && entry.message.excludeFromContext)
		return false;
	return (
		entry.type === "message" ||
		entry.type === "context_progress" ||
		(entry.type === "custom" && entry.customType === "todo-state") ||
		(entry.type === "custom_message" && entry.customType === "user-provenance")
	);
}

function stampEvidence(reference: TaskNoteReference, entry: SessionEntry): TaskNoteEvidenceStamp | undefined {
	if (!isClaimSource(entry)) return undefined;
	if (entry.type === "context_progress") {
		const evidenceKind =
			entry.evidenceKind === "verification"
				? "process_result"
				: entry.evidenceKind === "task_completed"
					? "task_terminal"
					: "workspace_state";
		return {
			reference,
			evidenceKind,
			subjectId: contextProgressSubject(entry),
			inputFingerprint: entry.inputFingerprint ?? entry.targetFingerprint,
			resultFingerprint: entry.resultFingerprint,
			observedAtEntryId: entry.id,
			outcome: entry.outcome,
		};
	}
	if (entry.type === "message" && entry.message.role === "user") {
		return {
			reference,
			evidenceKind: "user_confirmation",
			subjectId: entry.id,
			inputFingerprint: hash("task-note-user-input-v1", canonical(entry.message.content)),
			resultFingerprint: hash("task-note-user-result-v1", entry.id),
			observedAtEntryId: entry.id,
			outcome: "succeeded",
		};
	}
	if (entry.type === "custom_message" && entry.customType === "user-provenance") {
		return {
			reference,
			evidenceKind: "user_confirmation",
			subjectId: entry.id,
			inputFingerprint: hash("task-note-user-input-v1", canonical(entry.content)),
			resultFingerprint: hash("task-note-user-result-v1", entry.id),
			observedAtEntryId: entry.id,
			outcome: "succeeded",
		};
	}
	if (entry.type === "message" && entry.message.role === "toolResult") {
		return {
			reference,
			evidenceKind: "process_result",
			subjectId: `${entry.message.toolName}:${entry.message.toolCallId}`,
			inputFingerprint: "",
			resultFingerprint: hash("task-note-tool-result-v1", canonical(entry.message.content)),
			observedAtEntryId: entry.id,
			outcome: entry.message.isError ? "failed" : "succeeded",
		};
	}
	if (entry.type === "tool_result_source") {
		return {
			reference,
			evidenceKind: "process_result",
			subjectId: `${entry.toolName}:${entry.toolCallId}`,
			inputFingerprint: "",
			resultFingerprint: hash("task-note-tool-result-v1", canonical(entry.content)),
			observedAtEntryId: entry.id,
			outcome: entry.isError ? "failed" : "succeeded",
		};
	}
	return undefined;
}

function contextProgressSubject(entry: ContextProgressEntry): string {
	return entry.subjectId ?? entry.taskId ?? entry.targetFingerprint;
}

export function createTaskNoteFreshnessResolver(
	branch: readonly SessionEntry[],
): (stamp: TaskNoteEvidenceStamp) => TaskNoteFreshness {
	const latestInputBySubject = new Map<string, string>();
	for (const entry of branch) {
		if (entry.type !== "context_progress" || entry.outcome !== "succeeded") continue;
		const subjectId = contextProgressSubject(entry);
		if (entry.evidenceKind === "non_read_effect") {
			latestInputBySubject.set(subjectId, entry.resultFingerprint);
		} else if (entry.inputFingerprint !== undefined && !latestInputBySubject.has(subjectId)) {
			latestInputBySubject.set(subjectId, entry.inputFingerprint);
		}
	}
	return (stamp) => {
		if (stamp.evidenceKind === "user_confirmation") return "not_applicable";
		if (stamp.evidenceKind === "external_readback") return "unknown";
		if (stamp.subjectId.startsWith("workspace-file:")) {
			const path = stamp.subjectId.slice("workspace-file:".length);
			let content: string | undefined;
			try {
				content = readFileSync(path, "utf8");
			} catch {
				content = undefined;
			}
			return fingerprintTaskNoteWorkspaceContent(content) === stamp.inputFingerprint ? "fresh" : "stale";
		}
		const current = latestInputBySubject.get(stamp.subjectId);
		if (current === undefined || stamp.inputFingerprint.length === 0) return "unknown";
		if (current !== stamp.inputFingerprint) return "stale";
		if (stamp.evidenceKind === "process_result" || stamp.evidenceKind === "task_terminal") return "unknown";
		return current === stamp.inputFingerprint ? "fresh" : "stale";
	};
}

function isUserEntry(entry: SessionEntry): boolean {
	return (
		(entry.type === "message" && entry.message.role === "user") ||
		(entry.type === "custom_message" && entry.customType === "user-provenance")
	);
}

function candidateShapeIsValid(candidate: TaskNoteCandidate): boolean {
	if (!isTaskNoteKind(candidate.kind) || !KEY_PATTERN.test(candidate.key)) return false;
	if (!Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length === 0) return false;
	if (candidate.sourceRefs.length > MAX_TASK_NOTE_SOURCE_REFS || !candidate.sourceRefs.every(validReference))
		return false;
	if (candidate.operation === "upsert") {
		const allowedKeys = new Set([
			"operation",
			"kind",
			"key",
			"text",
			"sourceRefs",
			"evidenceRefs",
			"resume",
			"supersedesEventId",
		]);
		return (
			Object.keys(candidate).every((key) => allowedKeys.has(key)) &&
			typeof candidate.text === "string" &&
			candidate.text.trim().length > 0 &&
			candidate.text.length <= MAX_TASK_NOTE_TEXT_CHARS &&
			Array.isArray(candidate.evidenceRefs) &&
			candidate.evidenceRefs.length <= MAX_TASK_NOTE_EVIDENCE_REFS &&
			candidate.evidenceRefs.every(validReference) &&
			(candidate.kind === "next_action" && candidate.key === "current"
				? validResume(candidate.resume, candidate.kind, candidate.key)
				: candidate.resume === undefined) &&
			(candidate.supersedesEventId === undefined || typeof candidate.supersedesEventId === "string")
		);
	}
	return (
		Object.keys(candidate).every((key) =>
			["operation", "kind", "key", "sourceRefs", "supersedesEventId"].includes(key),
		) &&
		typeof candidate.supersedesEventId === "string" &&
		candidate.supersedesEventId.length > 0
	);
}

export function acceptTaskNoteCandidate(
	candidate: TaskNoteCandidate,
	context: TaskNoteAcceptanceContext,
): TaskNoteAcceptanceResult {
	if (!candidateShapeIsValid(candidate)) return { status: "rejected", reason: "invalid_output" };
	if (candidate.operation === "upsert" && containsPotentialSecret(candidate.text)) {
		return { status: "rejected", reason: "unsafe_content" };
	}
	if (
		candidate.operation === "upsert" &&
		candidate.kind === "next_action" &&
		/\b(?:permission|authorization)\b.*\b(?:granted|approved|confirmed)\b/i.test(candidate.text)
	) {
		return { status: "rejected", reason: "invalid_evidence" };
	}

	const entries = new Map(context.branch.map((entry) => [entry.id, entry]));
	const allowed = context.allowedEntryIds ?? new Set(entries.keys());
	const sourceEntries = candidate.sourceRefs.map((reference) => resolveReference(reference, entries, allowed));
	if (sourceEntries.some((entry) => entry === undefined || !isClaimSource(entry))) {
		return { status: "rejected", reason: "invalid_reference" };
	}
	if (candidate.kind === "constraint" && !sourceEntries.some((entry) => entry !== undefined && isUserEntry(entry))) {
		return { status: "rejected", reason: "invalid_reference" };
	}

	const active = context.projection.items.find((item) => item.kind === candidate.kind && item.key === candidate.key);
	if (
		(active === undefined && candidate.supersedesEventId !== undefined) ||
		(active !== undefined && candidate.supersedesEventId !== active.eventId)
	) {
		return { status: "rejected", reason: "invalid_supersession" };
	}
	if (candidate.operation === "retract" && active === undefined) {
		return { status: "rejected", reason: "invalid_supersession" };
	}
	if (
		candidate.operation === "upsert" &&
		active === undefined &&
		context.projection.items.length >= MAX_ACTIVE_TASK_NOTES
	) {
		return { status: "rejected", reason: "note_limit" };
	}

	const evidence =
		candidate.operation === "upsert"
			? candidate.evidenceRefs.map((reference) => {
					const entry = resolveReference(reference, entries, allowed);
					return entry === undefined ? undefined : stampEvidence(reference, entry);
				})
			: [];
	if (evidence.some((stamp) => stamp === undefined)) return { status: "rejected", reason: "invalid_evidence" };
	const stamps = evidence.filter((stamp): stamp is TaskNoteEvidenceStamp => stamp !== undefined);
	if (
		candidate.operation === "upsert" &&
		candidate.kind === "state" &&
		(stamps.length === 0 || stamps.some((stamp) => stamp.outcome !== "succeeded"))
	) {
		return { status: "rejected", reason: "invalid_evidence" };
	}
	if (
		candidate.operation === "upsert" &&
		candidate.kind === "failed_attempt" &&
		(stamps.length === 0 || stamps.some((stamp) => stamp.outcome !== "failed"))
	) {
		return { status: "rejected", reason: "invalid_evidence" };
	}

	const event: TaskNoteEvent = {
		version: 1,
		eventId: createTaskNoteEventId(context.scope, context.source, candidate),
		scope: context.scope,
		createdInContextEpoch: context.contextEpoch,
		operation: candidate.operation,
		kind: candidate.kind,
		key: candidate.key,
		...(candidate.operation === "upsert" ? { text: candidate.text } : {}),
		sourceRefs: candidate.sourceRefs,
		evidence: stamps,
		...(candidate.operation === "upsert" && candidate.resume !== undefined ? { resume: candidate.resume } : {}),
		...(candidate.supersedesEventId === undefined ? {} : { supersedesEventId: candidate.supersedesEventId }),
		source: context.source,
	};
	return { status: "accepted", event };
}
