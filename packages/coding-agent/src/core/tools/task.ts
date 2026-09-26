import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { BUILTIN_SUBAGENT_TYPES } from "../../builtin-agents/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { isSubagentTaskResult, type SubagentTaskResult } from "../subagents/protocol.ts";
import type { SubagentCoordinator } from "../subagents/subagent-coordinator.ts";

/** Grok-aligned: foreground `task` calls (run_in_background=false) wait this long before returning control. */
const FOREGROUND_WAIT_MS = 600_000;

const taskSchema = Type.Object({
	description: Type.String({
		description: "Short (3-6 word) description of the subagent's task, shown while it runs.",
	}),
	prompt: Type.String({ description: "The task, question, or instructions to hand to the subagent." }),
	subagent_type: Type.Union(
		BUILTIN_SUBAGENT_TYPES.map((name) => Type.Literal(name)),
		{ description: "general-purpose (full access), explore (read-only recon), or plan (read-only planning)." },
	),
	capability_mode: Type.Optional(
		Type.Union(
			[Type.Literal("read-only"), Type.Literal("read-write"), Type.Literal("execute"), Type.Literal("all")],
			{
				description: "Tool access ceiling for the subagent. Defaults to the subagent_type's preset.",
			},
		),
	),
	isolation: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
			description:
				'"worktree" runs the subagent in a separate git worktree and applies successful changes back atomically; setup or conflicts fail the task.',
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Default true: returns immediately with a task_id to poll via get_task_output. Set false to block (up to 600s).",
		}),
	),
	resume_from: Type.Optional(
		Type.String({ description: "A previous task_id whose recorded output should be used as context." }),
	),
});

export type TaskToolInput = Static<typeof taskSchema>;

function statusVerb(status: string): string {
	switch (status) {
		case "completed":
			return "finished";
		case "failed":
			return "failed";
		case "blocked":
			return "was blocked";
		case "cancelled":
			return "was cancelled";
		case "cancelling":
			return "is being cancelled";
		default:
			return "is still running";
	}
}

/**
 * `task`: delegates work to a subagent. Grok-aligned dependency rule: only register this tool when
 * get_task_output and kill_task are also registered (enforced by the caller — see agent-session.ts).
 */
export function createTaskToolDefinition(
	coordinator: SubagentCoordinator,
): ToolDefinition<typeof taskSchema, { taskId: string; result?: SubagentTaskResult }> {
	return {
		name: "task",
		label: "task",
		description:
			"Delegate a task to an autonomous subagent (general-purpose, explore, or plan) that runs independently with " +
			"its own tool access and transcript. Runs in the background by default (poll with get_task_output); pass " +
			"run_in_background=false to wait for it inline (up to 600s). Subagents cannot spawn further subagents.",
		promptSnippet: "Delegate autonomous work to a subagent (general-purpose/explore/plan)",
		parameters: taskSchema,
		async execute(_toolCallId, input: TaskToolInput) {
			const handle = coordinator.spawn({
				agentType: input.subagent_type,
				description: input.description,
				prompt: input.prompt,
				capabilityMode: input.capability_mode,
				isolation: input.isolation,
				runInBackground: input.run_in_background,
				resumeFrom: input.resume_from,
			});

			if (handle.runInBackground) {
				return {
					content: [
						{
							type: "text",
							text: `Started ${input.subagent_type} subagent as task ${handle.taskId} (running in the background). Poll it with get_task_output(task_ids=["${handle.taskId}"]).`,
						},
					],
					details: { taskId: handle.taskId },
				};
			}

			const snapshot = await coordinator.awaitForeground(handle.taskId, FOREGROUND_WAIT_MS);
			if (snapshot.status === "running" || snapshot.status === "cancelling") {
				return {
					content: [
						{
							type: "text",
							text: `Subagent task ${handle.taskId} is still running after ${FOREGROUND_WAIT_MS / 1000}s; continue polling with get_task_output(task_ids=["${handle.taskId}"]).`,
						},
					],
					details: { taskId: handle.taskId },
				};
			}
			if (snapshot.status === "failed" || snapshot.status === "cancelled") {
				throw new Error(snapshot.errorMessage || `Subagent task ${handle.taskId} ${statusVerb(snapshot.status)}.`);
			}
			if (snapshot.status !== "completed" && snapshot.status !== "blocked") {
				throw new Error(`Subagent task ${handle.taskId} has invalid terminal state ${snapshot.status}.`);
			}
			if (!isSubagentTaskResult(snapshot.result)) throw new Error("Subagent task returned no structured result.");
			return {
				content: [{ type: "text", text: JSON.stringify({ taskId: handle.taskId, ...snapshot.result }) }],
				details: { taskId: handle.taskId, result: snapshot.result },
			};
		},
		renderCall(args, theme) {
			const type = typeof args?.subagent_type === "string" ? args.subagent_type : "subagent";
			const description = typeof args?.description === "string" ? args.description : "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`task (${type})`)) + (description ? ` ${description}` : ""),
				0,
				0,
			);
		},
	};
}
