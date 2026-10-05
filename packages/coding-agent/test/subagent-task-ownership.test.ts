import { describe, expect, it, vi } from "vitest";
import { SubagentRunScope } from "../src/core/subagents/run-scope.ts";
import { TaskManager } from "../src/core/tasks/task-manager.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("background tool execution ownership", () => {
	it("requires the current run before starting tracked work", async () => {
		const scope = new SubagentRunScope();
		const tasks = new TaskManager(undefined, undefined, undefined, scope);
		const request = {
			kind: "bash" as const,
			description: "test",
			run: async () => ({ status: "completed" as const }),
		};
		expect(() => tasks.start(request)).toThrow("subagent_run_authority_required");
		await scope.run("run-1", new AbortController().signal, async () => {
			const task = tasks.start(request);
			expect(task.runId).toBe("run-1");
			expect((await tasks.awaitSettled(task.taskId)).status).toBe("completed");
		});
		expect(tasks.list()).toHaveLength(1);
	});

	it("propagates cancellation while retaining the task until its work actually settles", async () => {
		const scope = new SubagentRunScope();
		const tasks = new TaskManager(undefined, undefined, undefined, scope);
		const controller = new AbortController();
		const started = deferred();
		const released = deferred();
		let taskId = "";
		let taskSignal: AbortSignal | undefined;
		const run = scope.run("run-1", controller.signal, async () => {
			const task = tasks.start({
				kind: "bash",
				description: "controlled background tool",
				async run(ctx) {
					expect(ctx.runId).toBe("run-1");
					taskSignal = ctx.signal;
					started.resolve();
					await released.promise;
					return { status: "completed" };
				},
			});
			taskId = task.taskId;
			await tasks.awaitSettled(taskId);
		});
		await started.promise;
		controller.abort();
		expect(taskSignal?.aborted).toBe(true);
		expect(tasks.get(taskId)?.status).toBe("cancelling");
		let stopped = false;
		const settled = tasks.awaitSettled(taskId).then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		released.resolve();
		await Promise.all([run, settled]);
		expect(tasks.get(taskId)?.status).toBe("cancelled");
	});

	it("does not execute a task cancelled before its startup microtask", async () => {
		const scope = new SubagentRunScope();
		const tasks = new TaskManager(undefined, undefined, undefined, scope);
		const controller = new AbortController();
		const work = vi.fn(async () => ({ status: "completed" as const }));
		await scope.run("run-1", controller.signal, async () => {
			const task = tasks.start({ kind: "bash", description: "not started", run: work });
			controller.abort();
			expect((await tasks.awaitSettled(task.taskId)).status).toBe("cancelled");
		});
		expect(work).not.toHaveBeenCalled();
	});

	it("rejects an old run's delayed callback during a later run", async () => {
		const scope = new SubagentRunScope();
		const tasks = new TaskManager(undefined, undefined, undefined, scope);
		const released = deferred();
		let delayed: Promise<unknown> | undefined;
		await scope.run("old", new AbortController().signal, async () => {
			delayed = released.promise.then(() =>
				tasks.start({ kind: "bash", description: "stale", run: async () => ({ status: "completed" }) }),
			);
			void delayed.catch(() => {});
		});
		await scope.run("new", new AbortController().signal, async () => {
			released.resolve();
			await expect(delayed).rejects.toThrow("subagent_run_authority_required");
		});
		expect(tasks.list()).toHaveLength(0);
	});
});
