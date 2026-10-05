import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { TaskManager } from "../../../src/core/tasks/task-manager.ts";
import { TaskOutputBuffer } from "../../../src/core/tasks/task-output-buffer.ts";
import { createGetTaskOutputToolDefinition, resolveTaskIds } from "../../../src/core/tools/get-task-output.ts";
import { createKillTaskToolDefinition } from "../../../src/core/tools/kill-task.ts";
import { createHarness, type Harness } from "../harness.ts";

const ctx = {} as ExtensionContext;
let harness: Harness;
beforeEach(async () => {
	harness = await createHarness();
});
afterEach(async () => {
	await harness.cleanup();
});

function startLongRunningTask(taskManager: TaskManager, ms = 5000) {
	return taskManager.start({
		kind: "bash",
		description: "long running",
		run: (taskCtx) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve({ status: "completed", exitCode: 0 }), ms);
				taskCtx.signal.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("cancelled"));
				});
			}),
	});
}

describe("resolveTaskIds", () => {
	it("trims, dedupes, and preserves first-seen order", () => {
		expect(resolveTaskIds([" a ", "b", "a", "", "c", "b"])).toEqual(["a", "b", "c"]);
	});

	it("caps at 20 ids", () => {
		const ids = Array.from({ length: 30 }, (_, i) => `id-${i}`);
		expect(resolveTaskIds(ids)).toHaveLength(20);
	});
});

describe("TaskManager.wait", () => {
	it("clears a long timeout when the task settles first", async () => {
		vi.useFakeTimers();
		try {
			const taskManager = harness.session.taskManager;
			let finishTask!: (result: { status: "completed"; exitCode: number }) => void;
			const { taskId } = taskManager.start({
				kind: "diagnostics",
				description: "quick diagnostics",
				run: () =>
					new Promise((resolve) => {
						finishTask = resolve;
					}),
			});

			const wait = taskManager.wait([taskId], { timeoutMs: 600_000 });
			await Promise.resolve();
			finishTask({ status: "completed", exitCode: 0 });
			const { snapshots } = await wait;
			const snapshot = snapshots[0];

			expect(snapshot?.status).toBe("completed");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports wait deadlines without changing task state", async () => {
		const taskManager = harness.session.taskManager;
		const { taskId } = startLongRunningTask(taskManager);
		const result = await taskManager.wait([taskId], { timeoutMs: 5 });
		expect(result.timedOut).toBe(true);
		expect(result.snapshots[0]?.status).toBe("running");
		taskManager.cancel(taskId);
		await taskManager.awaitSettled(taskId);
	});

	it("settles synchronous run failures instead of leaving orphaned running tasks", async () => {
		const taskManager = harness.session.taskManager;
		const { taskId } = taskManager.start({
			kind: "diagnostics",
			description: "throws synchronously",
			run: () => {
				throw new Error("sync failure");
			},
		});
		const snapshot = await taskManager.awaitSettled(taskId);
		expect(snapshot).toMatchObject({ status: "failed", errorMessage: "sync failure" });
	});
});

describe("TaskOutputBuffer byte cursors", () => {
	it("uses UTF-8 byte offsets without dropping or duplicating text", () => {
		const buffer = new TaskOutputBuffer();
		buffer.append("你好a🙂");
		const page = buffer.read();
		expect(page.text).toBe("你好a🙂");
		expect(page.nextCursor).toBe(Buffer.byteLength("你好a🙂", "utf-8"));
		expect(buffer.cursorEnd()).toBe(page.nextCursor);
	});

	it("bounds a single oversized chunk", () => {
		const buffer = new TaskOutputBuffer(10);
		buffer.append("x".repeat(100));
		expect(Buffer.byteLength(buffer.full(), "utf-8")).toBeLessThanOrEqual(10);
		expect(buffer.cursorEnd()).toBe(100);
	});
});

describe("get_task_output tool", () => {
	it("returns a non-blocking snapshot when timeout_ms is omitted", async () => {
		const taskManager = harness.session.taskManager;
		const { taskId } = startLongRunningTask(taskManager);
		const definition = createGetTaskOutputToolDefinition(taskManager);
		const result = await definition.execute("call-1", { task_ids: [taskId] }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(JSON.parse(text).reports[0].status).toBe("running");
	});

	it("waits for completion when timeout_ms > 0 (wait-all semantics)", async () => {
		const taskManager = harness.session.taskManager;
		const snapshot = taskManager.start({
			kind: "bash",
			description: "quick",
			run: async (taskCtx) => {
				taskCtx.appendOutput("done output");
				return { status: "completed", exitCode: 0 };
			},
		});
		const definition = createGetTaskOutputToolDefinition(taskManager);
		const result = await definition.execute(
			"call-1",
			{ task_ids: [snapshot.taskId], timeout_ms: 1000 },
			undefined,
			undefined,
			ctx,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(JSON.parse(text).reports[0].status).toBe("completed");
		expect(text).toContain("done output");
	});

	it("timing out never cancels the underlying task", async () => {
		const taskManager = harness.session.taskManager;
		const { taskId } = startLongRunningTask(taskManager);
		const definition = createGetTaskOutputToolDefinition(taskManager);
		await definition.execute("call-1", { task_ids: [taskId], timeout_ms: 20 }, undefined, undefined, ctx);
		expect(taskManager.get(taskId)?.status).toBe("running");
		taskManager.cancel(taskId);
	});

	it("continues from the returned byte cursor", async () => {
		const taskManager = harness.session.taskManager;
		const snapshot = taskManager.start({
			kind: "bash",
			description: "unicode output",
			run: async (taskCtx) => {
				taskCtx.appendOutput("你好");
				return { status: "completed", exitCode: 0 };
			},
		});
		await taskManager.wait([snapshot.taskId], { timeoutMs: 500 });
		const definition = createGetTaskOutputToolDefinition(taskManager);
		const result = await definition.execute(
			"call-1",
			{ task_ids: [snapshot.taskId], cursor: Buffer.byteLength("你", "utf-8") },
			undefined,
			undefined,
			ctx,
		);
		expect((result.content[0] as { text: string }).text).toContain("好");
	});

	it("returns blocked task results as structured JSON", async () => {
		const taskManager = harness.session.taskManager;
		const snapshot = taskManager.start({
			kind: "diagnostics",
			description: "blocked",
			run: async () => ({
				status: "blocked",
				result: { submission: { status: "blocked", blocker: "missing input" } },
				errorMessage: "missing input",
			}),
		});
		const definition = createGetTaskOutputToolDefinition(taskManager);
		const result = await definition.execute(
			"call-1",
			{ view: "result", task_ids: [snapshot.taskId], timeout_ms: 500 },
			undefined,
			undefined,
			ctx,
		);
		const page = JSON.parse((result.content[0] as { text: string }).text);
		expect(JSON.parse(page.content).submission.blocker).toBe("missing input");
		expect(result.details.snapshots?.[0]).toMatchObject({ status: "blocked" });
	});
});

describe("kill_task tool", () => {
	it("cancels a running task", async () => {
		const taskManager = harness.session.taskManager;
		const { taskId } = startLongRunningTask(taskManager);
		const definition = createKillTaskToolDefinition(taskManager);
		const result = await definition.execute("call-1", { task_id: taskId }, undefined, undefined, ctx);
		expect((result.content[0] as { text: string }).text).toContain("Cancellation requested");
		const waitResult = await taskManager.wait([taskId], { timeoutMs: 500 });
		expect(waitResult.snapshots[0]?.status).toBe("cancelled");
	});

	it("reports not found for an unknown id", async () => {
		const taskManager = harness.session.taskManager;
		const definition = createKillTaskToolDefinition(taskManager);
		const result = await definition.execute("call-1", { task_id: "does-not-exist" }, undefined, undefined, ctx);
		expect((result.content[0] as { text: string }).text).toContain("not found");
	});

	it("reports already-completed for a finished task", async () => {
		const taskManager = harness.session.taskManager;
		const snapshot = taskManager.start({
			kind: "bash",
			description: "quick",
			run: async () => ({ status: "completed", exitCode: 0 }),
		});
		await taskManager.wait([snapshot.taskId], { timeoutMs: 500 });
		const definition = createKillTaskToolDefinition(taskManager);
		const result = await definition.execute("call-1", { task_id: snapshot.taskId }, undefined, undefined, ctx);
		expect((result.content[0] as { text: string }).text).toContain("already completed");
	});

	it("cascades cancellation to child tasks (parentTaskId)", async () => {
		const taskManager = harness.session.taskManager;
		const parent = startLongRunningTask(taskManager);
		const child = taskManager.start({
			kind: "diagnostics",
			parentTaskId: parent.taskId,
			description: "child",
			run: (taskCtx) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve({ status: "completed", exitCode: 0 }), 5000);
					taskCtx.signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("cancelled"));
					});
				}),
		});
		taskManager.cancel(parent.taskId);
		const { snapshots } = await taskManager.wait([parent.taskId, child.taskId], {
			timeoutMs: 500,
		});
		const [parentSnapshot, childSnapshot] = snapshots;
		expect(parentSnapshot?.status).toBe("cancelled");
		expect(childSnapshot?.status).toBe("cancelled");
	});
});
