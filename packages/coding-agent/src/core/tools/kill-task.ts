import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { TaskManager } from "../tasks/task-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const killTaskSchema = Type.Object({
	task_id: Type.String({ description: "The id of the background task to cancel." }),
});

export type KillTaskToolInput = Static<typeof killTaskSchema>;

export function createKillTaskToolDefinition(taskManager: TaskManager): ToolDefinition<typeof killTaskSchema> {
	return {
		name: "kill_task",
		label: "kill_task",
		description:
			"Cancel a background task (command or diagnostics job) started earlier. " +
			"Cancelling a parent task also cancels any tasks it spawned.",
		promptSnippet: "Cancel a background task by id",
		parameters: killTaskSchema,
		async execute(_toolCallId, { task_id }: KillTaskToolInput) {
			const before = taskManager.get(task_id);
			if (!before) {
				return { content: [{ type: "text", text: `Task ${task_id} not found.` }], details: undefined };
			}
			if (before.status !== "running" && before.status !== "cancelling") {
				return {
					content: [{ type: "text", text: `Task ${task_id} already ${before.status}.` }],
					details: undefined,
				};
			}
			const after = taskManager.cancel(task_id, "cancelled by kill_task");
			return {
				content: [
					{
						type: "text",
						text: `Cancellation requested for task ${task_id} (status: ${after?.status ?? "unknown"}).`,
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`kill_task ${String(args?.task_id ?? "")}`)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	};
}

export function createKillTaskTool(taskManager: TaskManager) {
	return wrapToolDefinition(createKillTaskToolDefinition(taskManager));
}
