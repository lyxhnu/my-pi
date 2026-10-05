import { History } from "./history.ts";
import type { SessionManager } from "./session-manager.ts";
import { readControlLog } from "./subagents/control-log.ts";
import { isSubagentTerminal, type SubagentRun } from "./subagents/types.ts";
import {
	buildTaskNoteProjectionFromBranch,
	resolveTaskNoteScope,
	type TaskNoteProjectionItem,
	type TaskNoteScope,
} from "./task-note-projection.ts";

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
	run: SubagentRun;
	ref: SubagentContinuationRef;
	taskScopeId: string;
	arguments: Record<string, unknown>;
}

/** Bind branch-visible calls to durable run identities, including calls interrupted before result delivery. */
function delegations(manager: SessionManager): Delegation[] {
	const owner = manager.getRootOwnership();
	if (!owner) return [];
	owner.assertActive();
	const identity = manager.getHeader()?.ownership;
	const issuerAgentId = identity?.kind === "child" ? identity.agentId : manager.getSessionId();
	const runs = new Map<string, SubagentRun>();
	for (const record of readControlLog(owner.rootFile, owner.rootSessionId)) {
		const event = record.control;
		if (
			(event.kind === "agent_created" ||
				event.kind === "run_accepted" ||
				event.kind === "run_updated" ||
				event.kind === "run_finished") &&
			event.run.issuerAgentId === issuerAgentId &&
			event.run.agentId !== issuerAgentId
		)
			runs.set(event.run.runId, event.run);
	}
	const branch = manager.getBranch();
	const history = new History(manager).getItems();
	const result: Delegation[] = [];
	for (const run of runs.values()) {
		const calls = history
			.flatMap((entry) => entry.blocks.map((block) => ({ entry, block })))
			.filter(
				({ block }) =>
					block.type === "tool_call" &&
					(block.toolName === "spawn_agent" || block.toolName === "followup_task") &&
					block.toolCallId === run.toolCallId,
			);
		// Delegation from another conversation branch is not part of this handoff.
		if (!calls.length) continue;
		if (calls.length !== 1 || !calls[0].block.text) throw new Error("subagent_handoff_invalid");
		const call = calls[0];
		const callIndex = branch.findIndex((entry) => entry.id === call.entry.entryId);
		if (callIndex < 0) throw new Error("subagent_handoff_invalid");
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
		const args: unknown = JSON.parse(call.block.text!);
		if (
			!scope ||
			!args ||
			typeof args !== "object" ||
			Array.isArray(args) ||
			!("task" in args) ||
			typeof args.task !== "string"
		)
			throw new Error("subagent_handoff_invalid");
		result.push({
			run,
			ref: { taskId: run.runId, toolCallId: run.toolCallId, sourceEntryId: call.entry.entryId },
			taskScopeId: scope.taskScopeId,
			arguments: args as Record<string, unknown>,
		});
	}
	return result;
}

export function captureSubagentHandoff(
	manager: SessionManager,
	scope: TaskNoteScope | undefined,
	retainedRequiredIds: readonly string[] = [],
): SubagentHandoff {
	const sources = delegations(manager);
	const active = sources.filter((source) => !isSubagentTerminal(source.run.state));
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
			...active.map((source) => source.ref.taskId),
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
				runId: source.ref.taskId,
				agentId: source.run.agentId,
				description: source.arguments.task,
				required,
				query: { tool: "get_agent_info", runId: ref.taskId },
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
