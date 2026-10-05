import { type Static, type TSchema, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { withSubagentToolPermission } from "./permissions.ts";
import { summarizeMail, summarizeRun } from "./queries.ts";
import type { RootSubagentCoordinator } from "./root-coordinator.ts";
import { SUBAGENT_LIMITS, type SubagentCaller, SubagentError } from "./types.ts";

const id = Type.String({ minLength: 1, maxLength: 128 });
const permission = Type.Object({
	mode: Type.Union([Type.Literal("read-only"), Type.Literal("read-write"), Type.Literal("full")]),
});
const paging = {
	cursor: Type.Optional(Type.String({ maxLength: 2048 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SUBAGENT_LIMITS.maxPageSize })),
};
const spawnSchema = Type.Object({
	task: Type.String({ minLength: 1, maxLength: SUBAGENT_LIMITS.taskBytes }),
	permission,
	context: Type.Union([Type.Literal("none"), Type.Literal("all"), Type.Integer({ minimum: 1 })]),
});
const followupSchema = Type.Object({
	agentId: id,
	task: Type.String({ minLength: 1, maxLength: SUBAGENT_LIMITS.taskBytes }),
	permission: Type.Optional(permission),
});
const messageSchema = Type.Object({
	targetAgentId: id,
	targetRunId: Type.Optional(id),
	message: Type.String({ minLength: 1, maxLength: SUBAGENT_LIMITS.messageBytes }),
	kind: Type.Optional(Type.Union([Type.Literal("information"), Type.Literal("question"), Type.Literal("progress")])),
});
const listSchema = Type.Object(paging);
const infoSchema = Type.Object({
	section: Type.Optional(
		Type.Union([
			Type.Literal("overview"),
			Type.Literal("runs"),
			Type.Literal("queue"),
			Type.Literal("messages"),
			Type.Literal("updates"),
			Type.Literal("descendants"),
			Type.Literal("content"),
		]),
	),
	agentId: Type.Optional(id),
	runId: Type.Optional(id),
	contentRef: Type.Optional(Type.String({ maxLength: 512 })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	...paging,
});
const waitSchema = Type.Object({
	runId: id,
	condition: Type.Optional(
		Type.Union([Type.Literal("result"), Type.Literal("update"), Type.Literal("subtree_stopped")]),
	),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: SUBAGENT_LIMITS.maxWaitMs })),
	version: Type.Optional(Type.Integer({ minimum: 0 })),
});
const interruptSchema = Type.Object({ runId: id, scope: Type.Union([Type.Literal("run"), Type.Literal("subtree")]) });

export function createSubagentTools(
	coordinator: () => RootSubagentCoordinator,
	caller: () => SubagentCaller,
): ToolDefinition[] {
	function tool<T extends TSchema>(
		name: string,
		description: string,
		parameters: T,
		execute: (input: Static<T>, callId: string, signal?: AbortSignal) => unknown | Promise<unknown>,
	): ToolDefinition<T> {
		return withSubagentToolPermission<ToolDefinition<T>>(
			{
				name,
				label: name,
				description,
				parameters,
				async execute(callId, input, signal) {
					try {
						if (signal?.aborted) throw new SubagentError("run_cancelled");
						const output = await execute(input, callId, signal);
						const updatesAvailableThrough = coordinator().pendingUpdates(caller());
						const body =
							typeof output === "object" && output !== null ? { ...output, updatesAvailableThrough } : output;
						const result = {
							content: [{ type: "text" as const, text: JSON.stringify(body) }],
							details: undefined,
						};
						if (Buffer.byteLength(JSON.stringify(result)) > SUBAGENT_LIMITS.responseBytes)
							throw new SubagentError("response_too_large");
						return result;
					} catch (error) {
						const code = error instanceof SubagentError ? error.code : "subagent_operation_failed";
						return {
							content: [{ type: "text" as const, text: JSON.stringify({ error: code }) }],
							details: undefined,
							isError: true,
						};
					}
				},
			},
			"read-only",
		);
	}
	return [
		tool(
			"spawn_agent",
			"Create an independent persistent child in this process. All descendants share the root's lifetime budget of 8 identities and 3 executing children. Capacity failure does not enqueue a new child. Permission limits tool capabilities: read-only for reading, read-write adds file edits, full adds commands and external tools. It is not OS filesystem/network isolation. Choose the least required permission and context.",
			spawnSchema,
			async (input, callId) => {
				const root = coordinator();
				const run = await root.spawn(caller(), input, callId);
				return { run: summarizeRun(root.rootSessionId, run), usage: root.usage };
			},
		),
		tool(
			"followup_task",
			"Start a new run in an existing child's original context. Busy children queue this task in FIFO order. This does not create a new identity or raise permission.",
			followupSchema,
			(input, callId) => {
				const root = coordinator();
				return summarizeRun(root.rootSessionId, root.followup(caller(), input, callId));
			},
		),
		tool(
			"send_message",
			"Send information or a question to an agent in this root. This never starts an idle agent. A run-bound message is not delivered to a later run.",
			messageSchema,
			(input) => {
				const root = coordinator();
				return summarizeMail(root.rootSessionId, root.sendMessage(caller(), input));
			},
		),
		tool(
			"list_agents",
			"List visible agent identities and bounded current-run summaries. Use get_agent_info for paged runs, queues, messages and content.",
			listSchema,
			(input) => {
				const root = coordinator();
				return { ...root.listAgents(caller(), input), usage: root.usage };
			},
		),
		tool(
			"get_agent_info",
			"Query overview (default), runs, queue, messages, unread updates, causal descendants or UTF-8 content. Reading updates acknowledges only the records returned on that page. Reuse each page cursor only with the same section and filters. Large bodies have contentRef and byte length.",
			infoSchema,
			(input) => {
				const root = coordinator();
				const source = caller();
				const section = input.section ?? "overview";
				if (section === "updates") return root.listUpdates(source, { cursor: input.cursor, limit: input.limit });
				if (section === "content") {
					if (!input.contentRef) throw new SubagentError("content_ref_required");
					return root.readContent(source, input.contentRef, input.offset);
				}
				if (section === "overview") {
					if (input.runId) return summarizeRun(root.rootSessionId, root.getRun(source, input.runId));
					if (!input.agentId) throw new SubagentError("agent_id_required");
					return root.getAgentInfo(source, input.agentId);
				}
				const query = { cursor: input.cursor, limit: input.limit, agentId: input.agentId };
				if (section === "messages") return root.listMessages(source, query);
				if (section === "descendants" && !input.runId) throw new SubagentError("run_id_required");
				return root.listRuns(source, {
					...query,
					queuedOnly: section === "queue",
					ancestorRunId: section === "descendants" ? input.runId : undefined,
				});
			},
		),
		tool(
			"wait_agent",
			"Wait for one run's result, update, or its subtree's agents and tracked tools to settle. A timeout only ends this wait; the run keeps executing. Decide explicitly whether to wait again or interrupt. External command descendants are not guaranteed stopped; check effectsUnknown. Use runId, never an agent's shifting current task.",
			waitSchema,
			async (input, _callId, signal) => {
				const root = coordinator();
				const result = await root.wait(caller(), input.runId, { ...input, signal });
				return {
					...result,
					stopScope: "agents_and_tracked_tools",
					run: summarizeRun(root.rootSessionId, result.run),
				};
			},
		),
		tool(
			"interrupt_agent",
			"Request cooperative cancellation of a run or its causal subtree, including queued and initializing work. accepted is not stopped. Wait for subtree_stopped before reassigning. This confirms agents and tracked tools settled, not that external command descendants stopped; effectsUnknown warns that old side effects may overlap reassignment.",
			interruptSchema,
			(input) => ({
				...coordinator().interrupt(caller(), input.runId, input.scope),
				stopScope: "agents_and_tracked_tools",
			}),
		),
	];
}
