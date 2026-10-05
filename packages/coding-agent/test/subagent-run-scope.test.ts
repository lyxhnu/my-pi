import { describe, expect, it } from "vitest";
import { SubagentRunScope } from "../src/core/subagents/run-scope.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("subagent async execution authority", () => {
	it("does not confirm a synchronous close before the newly entered work settles", async () => {
		const scope = new SubagentRunScope();
		const gate = deferred();
		let closed = false;
		let closing: Promise<void> | undefined;
		const run = scope.run("one", new AbortController().signal, async (signal) => {
			closing = scope.close().then(() => {
				closed = true;
			});
			expect(signal.aborted).toBe(true);
			await gate.promise;
		});
		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(closed).toBe(false);
		} finally {
			gate.resolve();
		}
		await run;
		await closing;
		expect(closed).toBe(true);
	});

	it("requires a host lease and rejects a stale callback during a later execution", async () => {
		const scope = new SubagentRunScope();
		const { promise: delayed, resolve: resume } = deferred();
		let stale: Promise<void> | undefined;
		await scope.run("first", new AbortController().signal, async () => {
			stale = delayed.then(() => {
				scope.assertActive();
			});
			void stale.catch(() => {});
		});
		await scope.run("second", new AbortController().signal, async () => {
			resume();
			await expect(stale).rejects.toThrow("subagent_run_authority_required");
			expect(scope.assertActive().runId).toBe("second");
		});
		expect(() => scope.assertActive()).toThrow("subagent_run_authority_required");
	});

	it("retains ownership until tracked work actually settles after cancellation", async () => {
		const scope = new SubagentRunScope();
		const { promise: gate, resolve: release } = deferred();
		const { promise: started, resolve: notify } = deferred();
		const controller = new AbortController();
		let done = false;
		const run = scope
			.run("first", controller.signal, async () => {
				void scope.track(async () => {
					notify();
					await gate;
				});
				await started;
			})
			.then(() => {
				done = true;
			});
		await started;
		controller.abort();
		await Promise.resolve();
		expect(done).toBe(false);
		expect(() => scope.run("second", controller.signal, async () => {})).toThrow("subagent_run_busy");
		release();
		await run;
	});

	it("close aborts the current run and waits for cooperative cleanup", async () => {
		const scope = new SubagentRunScope();
		const { promise: gate, resolve: release } = deferred();
		let signal: AbortSignal | undefined;
		const run = scope.run("one", new AbortController().signal, async (current) => {
			signal = current;
			await gate;
		});
		let closed = false;
		const closing = scope.close().then(() => {
			closed = true;
		});
		expect(signal?.aborted).toBe(true);
		await Promise.resolve();
		expect(closed).toBe(false);
		release();
		await run;
		await closing;
		expect(() => scope.run("new", new AbortController().signal, async () => {})).toThrow("subagent_session_closed");
	});
});
