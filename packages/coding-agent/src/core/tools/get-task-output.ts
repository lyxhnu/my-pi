import { randomUUID } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { TaskManager } from "../tasks/task-manager.ts";
import type { TaskOutputPage, TaskSnapshot } from "../tasks/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const MAX_MULTI_WAIT_IDS = 20;
const getTaskOutputSchema = Type.Object({
	view: Type.Optional(Type.Union([Type.Literal("report"), Type.Literal("result")])),
	task_ids: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_MULTI_WAIT_IDS })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
	cursor: Type.Optional(Type.Union([Type.String(), Type.Number()])),
});
export type GetTaskOutputToolInput = Static<typeof getTaskOutputSchema>;
export interface GetTaskOutputDetails {
	taskIds: string[];
	timedOut?: boolean;
	snapshots?: TaskSnapshot[];
	pages?: Array<TaskOutputPage | undefined>;
}
export function resolveTaskIds(ids: string[]): string[] {
	return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_MULTI_WAIT_IDS);
}

export function createGetTaskOutputToolDefinition(
	taskManager: TaskManager,
): ToolDefinition<typeof getTaskOutputSchema, GetTaskOutputDetails> {
	const reads = new Map<string, { view: string; content: string; metadata: object }>();
	const reportReads = new Map<
		string,
		{
			items: Array<{ report: unknown }>;
			timedOut: boolean;

			sampledAt: string;
		}
	>();
	const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 16384;
	const page = (key: string, offset: number) => {
		const read = reads.get(key);
		if (!read) throw new Error("invalid_read_cursor");
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			offset > read.content.length ||
			(offset > 0 && /[\uDC00-\uDFFF]/.test(read.content[offset] ?? ""))
		)
			throw new Error("invalid_read_cursor");
		let low = 0;
		let high = read.content.length - offset;
		const envelope = (length: number) => ({
			view: read.view,
			...read.metadata,
			content: read.content.slice(offset, offset + length),
			range: { start: offset, end: offset + length },
			complete: offset === 0 && offset + length === read.content.length,
			hasMore: offset + length < read.content.length,
			nextCursor: offset + length < read.content.length ? `${read.view}:${key}:${offset + length}` : null,
		});
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (fits(envelope(mid))) low = mid;
			else high = mid - 1;
		}
		if (
			low > 0 &&
			/[\uD800-\uDBFF]/.test(read.content[offset + low - 1] ?? "") &&
			/[\uDC00-\uDFFF]/.test(read.content[offset + low] ?? "")
		)
			low--;
		if (!low && read.content.length > offset) throw new Error("page_metadata_too_large");
		return envelope(low);
	};
	const openRead = (view: string, content: string, metadata: object) => {
		if (reads.size >= 32) reads.delete(reads.keys().next().value!);
		const key = randomUUID();
		reads.set(key, { view, content, metadata });
		return page(key, 0);
	};
	const reportPage = (key: string, offset: number) => {
		const read = reportReads.get(key);
		if (!read || !Number.isSafeInteger(offset) || offset < 0 || offset >= read.items.length)
			throw new Error("invalid_read_cursor");
		const selected: typeof read.items = [];
		const envelope = () => ({
			view: "report",
			reports: selected.map((item) => item.report),
			timedOut: read.timedOut,
			reportCount: read.items.length,
			unreadCount: read.items.length - offset - selected.length,
			sampledAt: read.sampledAt,
			range: { start: offset, end: offset + selected.length },
			complete: offset === 0 && selected.length === read.items.length,
			hasMore: offset + selected.length < read.items.length,
			nextCursor: offset + selected.length < read.items.length ? `report:${key}:${offset + selected.length}` : null,
		});
		for (const item of read.items.slice(offset)) {
			selected.push(item);
			if (!fits(envelope())) {
				selected.pop();
				break;
			}
		}
		if (!selected.length) throw new Error("individual_report_too_large");
		return envelope();
	};
	return {
		name: "get_task_output",
		label: "get_task_output",
		parameters: getTaskOutputSchema,
		description:
			"Read bounded reports or result pages for background commands and diagnostics. A wait timeout does not cancel work. Follow nextCursor with the same view; cursors expire after 32 newer reads. Use get_agent_info for agents.",
		async execute(_toolCallId, input, signal) {
			signal?.throwIfAborted();
			const view = input.view ?? "report";
			const ids = resolveTaskIds(input.task_ids ?? []);
			let body: unknown;
			let snapshots: TaskSnapshot[] | undefined;
			let timedOut: boolean | undefined;
			if (typeof input.cursor === "string") {
				if (ids.length || input.timeout_ms) throw new Error("cursor_parameters_are_exclusive");
				const match = /^(result|report):([^:]+):(\d+)$/.exec(input.cursor);
				if (!match || match[1] !== view) throw new Error("invalid_read_cursor");
				body = view === "report" ? reportPage(match[2], Number(match[3])) : page(match[2], Number(match[3]));
			} else {
				if (
					!ids.length ||
					(view === "result" && ids.length !== 1) ||
					(input.cursor !== undefined && ids.length !== 1)
				)
					throw new Error("invalid_task_query");
				const wait = await taskManager.wait(ids, { timeoutMs: input.timeout_ms, signal });
				signal?.throwIfAborted();
				snapshots = wait.snapshots;
				timedOut = wait.timedOut;
				if (view === "result") {
					const snapshot = snapshots[0];
					const result = "result" in snapshot ? snapshot.result : undefined;
					body = openRead(
						view,
						result === undefined ? (taskManager.read(ids[0])?.text ?? "") : JSON.stringify(result),
						{
							taskId: ids[0],
							status: snapshot.status,
							sampledAt: new Date().toISOString(),
							resultAvailable: result !== undefined,
						},
					);
				} else {
					const items = ids.map((id) => {
						const snapshot = taskManager.get(id);
						const raw = {
							taskId: id,
							status: snapshot?.status ?? "unknown",
							output: taskManager.read(id, input.cursor as number | undefined),
							result: snapshot && "result" in snapshot ? snapshot.result : undefined,
							error: snapshot && "errorMessage" in snapshot ? snapshot.errorMessage : null,
						};
						return {
							report:
								Buffer.byteLength(JSON.stringify(raw)) <= 8192
									? raw
									: {
											taskId: id,
											status: raw.status,
											output: null,
											result: null,
											error: raw.error?.slice(0, 256) ?? null,
											reportComplete: false,
											resultQuery: { view: "result", task_ids: [id] },
										},
						};
					});
					if (reportReads.size >= 32) reportReads.delete(reportReads.keys().next().value!);
					const key = randomUUID();
					reportReads.set(key, { items, timedOut, sampledAt: new Date().toISOString() });
					body = reportPage(key, 0);
				}
			}
			return {
				content: [{ type: "text", text: JSON.stringify(body) }],
				details: { taskIds: ids, snapshots, timedOut },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`get_task_output (${args.view ?? "report"})`)), 0, 0);
		},
	};
}
export function createGetTaskOutputTool(taskManager: TaskManager) {
	return wrapToolDefinition(createGetTaskOutputToolDefinition(taskManager));
}
