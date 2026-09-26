import { History } from "./history.ts";
import type { SessionManager } from "./session-manager.ts";
import {
	buildTaskNoteProjectionFromBranch,
	resolveTaskNoteScope,
	type TaskNoteProjectionItem,
	type TaskNoteScope,
} from "./task-note-projection.ts";
import type { TaskSnapshot } from "./tasks/types.ts";

export interface SubagentContinuationRef {
	taskId: string;
	toolCallId: string;
	sourceEntryId: string;
}

export interface SubagentHandoff {
	subagentTasks: SubagentContinuationRef[];
	requiredTaskIds: string[];
	subagentNoteEventId: string | null;
}

export type ContextTransitionGate =
	| ({ status: "ready" } & SubagentHandoff)
	| { status: "busy" }
	| { status: "invalid"; reason: "subagent_handoff_invalid" };

interface Delegation {
	ref: SubagentContinuationRef;
	taskScopeId: string;
	arguments: Record<string, unknown>;
}

/** Resolve only canonical, branch-visible task results and their original calls. */
function delegations(manager: SessionManager): Delegation[] {
	const branch = manager.getBranch();
	const history = new History(manager).getItems();
	const result: Delegation[] = [];
	for (const item of history) {
		if (item.role !== "toolResult" || item.toolName !== "task" || item.isError) continue;
		const source = branch.find((entry) => entry.id === item.entryId);
		const details =
			source?.type === "tool_result_source"
				? source.details
				: source?.type === "message" && source.message.role === "toolResult"
					? source.message.details
					: undefined;
		if (
			!details ||
			typeof details !== "object" ||
			!("taskId" in details) ||
			typeof details.taskId !== "string" ||
			!details.taskId.trim()
		)
			throw new Error("subagent_handoff_invalid");
		const call = history
			.flatMap((entry) => entry.blocks.map((block) => ({ entry, block })))
			.filter(
				({ block }) =>
					block.type === "tool_call" && block.toolName === "task" && block.toolCallId === item.toolCallId,
			);
		if (
			call.length !== 1 ||
			!item.toolCallId ||
			!call[0].block.text ||
			result.some((entry) => entry.ref.taskId === details.taskId)
		)
			throw new Error("subagent_handoff_invalid");
		const callIndex = branch.findIndex((entry) => entry.id === call[0].entry.entryId);
		if (callIndex < 0 || callIndex >= branch.findIndex((entry) => entry.id === item.entryId))
			throw new Error("subagent_handoff_invalid");
		const prefix = branch.slice(0, callIndex + 1);
		let generation = 0;
		for (const entry of prefix) {
			if (
				entry.type === "custom" &&
				entry.customType === "context-prompt-generation" &&
				entry.data &&
				typeof entry.data === "object" &&
				"promptGeneration" in entry.data &&
				typeof entry.data.promptGeneration === "number"
			)
				generation = entry.data.promptGeneration;
		}
		const scope = resolveTaskNoteScope(prefix, generation);
		const args: unknown = JSON.parse(call[0].block.text);
		if (
			!scope ||
			!args ||
			typeof args !== "object" ||
			Array.isArray(args) ||
			!("prompt" in args) ||
			typeof args.prompt !== "string" ||
			!("description" in args) ||
			typeof args.description !== "string" ||
			!("subagent_type" in args) ||
			typeof args.subagent_type !== "string"
		)
			throw new Error("subagent_handoff_invalid");
		result.push({
			ref: { taskId: details.taskId, toolCallId: item.toolCallId, sourceEntryId: item.entryId },
			taskScopeId: scope.taskScopeId,
			arguments: args as Record<string, unknown>,
		});
	}
	return result;
}

export function captureSubagentHandoff(
	manager: SessionManager,
	scope: TaskNoteScope | undefined,
	tasks: readonly TaskSnapshot[],
	retainedRequiredIds: readonly string[] = [],
): SubagentHandoff {
	const sources = delegations(manager);
	const active = tasks.filter(
		(task) => task.kind === "subagent" && (task.status === "running" || task.status === "cancelling"),
	);
	for (const task of tasks) {
		if (
			sources.some((source) => source.ref.taskId === task.taskId) &&
			(task.kind !== "subagent" || task.ownerSessionId !== manager.getSessionId())
		)
			throw new Error("subagent_handoff_invalid");
	}
	if (
		active.some(
			(task) =>
				task.ownerSessionId !== manager.getSessionId() ||
				!sources.some((source) => source.ref.taskId === task.taskId),
		)
	)
		throw new Error("subagent_handoff_invalid");
	const projection = scope ? buildTaskNoteProjectionFromBranch(manager.getBranch(), scope) : undefined;
	const note =
		projection?.status === "valid"
			? projection.snapshot.items.find((item) => item.kind === "next_action" && item.key === "current")
			: undefined;
	const selected = note?.resume?.subagentContinuations ?? [];
	const referencedSources = new Set(
		[
			...(note?.sourceRefs ?? []),
			...(note?.evidence.map((stamp) => stamp.reference) ?? []),
			...(note?.resume?.requiredHistoryRefs ?? []),
		].map((reference) => reference.entryId),
	);
	const requiredTaskIds = [
		...new Set([
			...retainedRequiredIds,
			...sources
				.filter(
					(source) =>
						source.taskScopeId === scope?.taskScopeId ||
						note?.text.includes(source.ref.taskId) ||
						referencedSources.has(source.ref.sourceEntryId),
				)
				.map((source) => source.ref.taskId),
			...active.map((task) => task.taskId),
			...selected.map((item) => item.taskId),
		]),
	];
	if (
		requiredTaskIds.some(
			(taskId) =>
				!sources.some((source) => source.ref.taskId === taskId) || !selected.some((item) => item.taskId === taskId),
		)
	)
		throw new Error("subagent_handoff_invalid");
	return {
		subagentTasks: sources.map((source) => source.ref),
		requiredTaskIds,
		subagentNoteEventId: requiredTaskIds.length > 0 ? (note?.eventId ?? null) : null,
	};
}

/** Stable text records are paginated, budgeted and checked in the actual provider request. */
export function subagentRecoveryRecords(
	manager: SessionManager,
	handoff: SubagentHandoff & { historyCutoffEntryId?: string },
	note: TaskNoteProjectionItem | undefined,
): Array<{ type: "subagent_task"; taskId: string; text: string }> {
	const branch = manager.getBranch();
	const cutoff =
		handoff.historyCutoffEntryId === undefined
			? branch.length - 1
			: branch.findIndex((entry) => entry.id === handoff.historyCutoffEntryId);
	const sources = delegations(manager).filter(
		(source) => branch.findIndex((entry) => entry.id === source.ref.sourceEntryId) <= cutoff,
	);
	if (
		!Array.isArray(handoff.subagentTasks) ||
		!Array.isArray(handoff.requiredTaskIds) ||
		sources.length !== handoff.subagentTasks.length ||
		new Set(handoff.subagentTasks.map((ref) => ref.taskId)).size !== handoff.subagentTasks.length ||
		new Set(handoff.requiredTaskIds).size !== handoff.requiredTaskIds.length ||
		note?.resume?.subagentContinuations.some((item) => !handoff.requiredTaskIds.includes(item.taskId)) ||
		(handoff.requiredTaskIds.length > 0 && (!note?.resume || handoff.subagentNoteEventId !== note.eventId))
	)
		throw new Error("subagent_handoff_invalid");
	const records = handoff.subagentTasks.map((ref) => {
		const source = sources.find((entry) => entry.ref.taskId === ref.taskId);
		if (!source || source.ref.toolCallId !== ref.toolCallId || source.ref.sourceEntryId !== ref.sourceEntryId)
			throw new Error("subagent_handoff_invalid");
		const required = handoff.requiredTaskIds.includes(ref.taskId);
		const relation = note?.resume?.subagentContinuations.find((item) => item.taskId === ref.taskId);
		if (required && !relation) throw new Error("subagent_handoff_invalid");
		return {
			type: "subagent_task" as const,
			taskId: ref.taskId,
			text: JSON.stringify({
				...ref,
				description: source.arguments.description,
				required,
				query: { tool: "get_task_output", task_ids: [ref.taskId], timeout_ms: 0 },
				...(required
					? {
							historicalChildInstructions: source.arguments,
							continuationNoteEventId: note?.eventId,
							parentRelation: relation?.parentRelation,
							onResult: relation?.onResult,
						}
					: {}),
			}),
		};
	});
	if (handoff.requiredTaskIds.some((taskId) => !records.some((record) => record.taskId === taskId)))
		throw new Error("subagent_handoff_invalid");
	return records;
}
