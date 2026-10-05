import { describe, expect, it } from "vitest";
import { SubagentRunScheduler } from "../src/core/subagents/run-scheduler.ts";
import type { SubagentRun } from "../src/core/subagents/types.ts";

function run(agentId: string, runId = agentId): SubagentRun {
	return {
		agentId,
		runId,
		issuerAgentId: "root",
		issuerRunId: "root-run",
		toolCallId: runId,
		task: "task",
		permission: { mode: "read-only" },
		state: "queued",
		createdAt: 0,
	};
}

describe("subagent run scheduler", () => {
	it("rejects a fourth child immediately even while the first three are waiting", () => {
		const scheduler = new SubagentRunScheduler();
		for (const id of ["A", "B", "C"]) scheduler.accept(run(id), 4, () => {});
		scheduler.get("A")!.state = "waiting";
		scheduler.get("B")!.state = "waiting";
		expect(() => scheduler.accept(run("D"), 4, () => {})).toThrow("execution_capacity_exceeded");
		expect(scheduler.activeCount).toBe(3);
		expect(scheduler.queuedCount).toBe(0);
	});

	it("atomically hands the existing permit to its FIFO successor", () => {
		const scheduler = new SubagentRunScheduler();
		for (const id of ["A", "B", "C"]) scheduler.accept(run(id), 4, () => {});
		scheduler.accept(run("A", "A2"), 7, () => {});
		expect(scheduler.queuedBytes).toBe(7);
		expect(scheduler.finish("A", () => {})?.runId).toBe("A2");
		expect(scheduler.activeCount).toBe(3);
		expect(scheduler.queuedBytes).toBe(0);
		expect(scheduler.get("A2")?.state).toBe("initializing");
	});

	it("recomputes the predecessor after cancellation, retaining the wait cycle", () => {
		const scheduler = new SubagentRunScheduler();
		for (const id of ["A1", "A2", "A3"]) scheduler.accept(run("A", id), 4, () => {});
		scheduler.finish("A2", () => {});
		expect(scheduler.queue("A").map((item) => item.runId)).toEqual(["A1", "A3"]);
		expect(() => scheduler.addWait("A1", ["A3"])).toThrow("run_wait_cycle");
		expect(scheduler.queuedCount).toBe(1);
	});

	it("rejects nested cross-agent cycles and removes timed-out wait edges", () => {
		const scheduler = new SubagentRunScheduler();
		scheduler.accept(run("A", "A1"), 4, () => {});
		scheduler.accept(run("B", "B1"), 4, () => {});
		scheduler.accept(run("A", "A2"), 4, () => {});
		const remove = scheduler.addWait("A1", ["B1"]);
		expect(() => scheduler.addWait("B1", ["A2"])).toThrow("run_wait_cycle");
		remove();
		expect(() => scheduler.addWait("B1", ["A2"])).not.toThrow();
	});

	it("does not mutate capacity when durable admission or completion fails", () => {
		const scheduler = new SubagentRunScheduler();
		expect(() =>
			scheduler.accept(run("A"), 4, () => {
				throw new Error("disk");
			}),
		).toThrow("disk");
		expect(scheduler.activeCount).toBe(0);
		scheduler.accept(run("A"), 4, () => {});
		expect(() =>
			scheduler.finish("A", () => {
				throw new Error("disk");
			}),
		).toThrow("disk");
		expect(scheduler.activeCount).toBe(1);
	});

	it("rejects admission after close and enforces both queue limits", () => {
		const scheduler = new SubagentRunScheduler();
		scheduler.accept(run("A"), 4, () => {});
		for (let i = 0; i < 32; i++) scheduler.accept(run("A", `A${i}`), 64 * 1024, () => {});
		expect(() => scheduler.accept(run("A", "overflow"), 1, () => {})).toThrow("task_queue_full");
		scheduler.closeAdmission();
		expect(() => scheduler.accept(run("B"), 1, () => {})).toThrow("root_closing");
	});
});
