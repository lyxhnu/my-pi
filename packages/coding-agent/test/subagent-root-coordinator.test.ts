import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { RootSubagentCoordinator } from "../src/core/subagents/root-coordinator.ts";
import { subagentMailMessage } from "../src/core/subagents/session-mailbox.ts";
import type {
	SubagentIdentity,
	SubagentPermission,
	SubagentRun,
	SubagentRuntimeFactory,
} from "../src/core/subagents/types.ts";
import { SUBAGENT_LIMITS, SubagentError } from "../src/core/subagents/types.ts";

const cleanups: (() => Promise<void>)[] = [];

async function fixture() {
	let expectedCloseFailure: string | undefined;
	const directory = mkdtempSync(join(tmpdir(), "pi-root-coordinator-"));
	const session = SessionManager.create(directory, directory);
	const permission: SubagentPermission = {
		mode: "read-only",
	};
	const children = new Map<string, SessionManager>();
	const running = new Map<
		string,
		{ run: SubagentRun; signal: AbortSignal; finish: (text: string) => void; fail: (error: Error) => void }
	>();
	const histories = new Map<string, string[]>();
	const factory: SubagentRuntimeFactory = {
		async recover() {
			return [];
		},
		async discard(agent) {
			children.get(agent.agentId)?.closeOwnership();
			children.delete(agent.agentId);
			rmSync(agent.sessionFile, { force: true });
		},
		async prepare(agent) {
			children.set(
				agent.agentId,
				SessionManager.createChild(
					directory,
					agent.sessionFile,
					agent.sessionId,
					agent.agentId,
					session.getRootOwnership()!,
				),
			);
		},
		async open(agent: SubagentIdentity) {
			const child = children.get(agent.agentId)!;
			histories.set(agent.agentId, []);
			return {
				sessionId: agent.sessionId,
				processId: process.pid,
				context: () => [],
				async close() {
					child.closeOwnership();
				},
				run(run, signal) {
					histories.get(agent.agentId)!.push(run.task);
					return new Promise((resolve, reject) => {
						running.set(run.runId, {
							run,
							signal,
							finish(text) {
								running.delete(run.runId);
								resolve({ text });
							},
							fail(error) {
								running.delete(run.runId);
								reject(error);
							},
						});
					});
				},
			};
		},
	};
	const coordinator = await RootSubagentCoordinator.open({
		session,
		factory,
		permission: () => permission,
		rootContext: () => [],
		recover: async () => {},
	});
	const root = coordinator.beginRootRun();
	cleanups.push(async () => {
		const closed = coordinator.close();
		for (const runtime of running.values()) runtime.finish("cleanup");
		if (expectedCloseFailure) {
			await expect(closed).rejects.toThrow(expectedCloseFailure);
			for (const child of children.values()) child.closeOwnership();
			session.closeOwnership();
		} else await closed;
		rmSync(directory, { force: true, recursive: true });
	});
	async function started(runId: string) {
		for (let i = 0; i < 20 && !running.has(runId); i++) await Promise.resolve();
		const runtime = running.get(runId);
		if (!runtime) throw new Error(`Run ${runId} did not start`);
		return runtime;
	}
	async function spawn(task = "first", callId = task) {
		const run = await coordinator.spawn(root, { task, permission, context: "none" }, callId);
		await started(run.runId);
		return run;
	}
	async function finish(runId: string, text = "done") {
		(await started(runId)).finish(text);
		return coordinator.wait(root, runId, { timeoutMs: 1000 });
	}
	return {
		directory,
		session,
		permission,
		coordinator,
		root,
		spawn,
		started,
		finish,
		running,
		histories,
		expectCloseFailure: (message: string) => {
			expectedCloseFailure = message;
		},
	};
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("root subagent coordinator", () => {
	it("acknowledges only returned update records and retains later notifications across pagination", async () => {
		const f = await fixture();
		const a = await f.spawn("A");
		const caller = f.coordinator.callerFor(a.runId);
		const b = await f.coordinator.spawn(caller, { task: "B", permission: f.permission, context: "none" }, "B");
		await f.finish(b.runId);
		expect(f.coordinator.pendingUpdates(caller)).toBeDefined();
		let page = f.coordinator.listUpdates(caller, { limit: 1 });
		expect(page.hasMore).toBe(true);
		const firstSequence = page.items[0].sequence;
		const latest = f.coordinator.pendingUpdates(caller)!;
		expect(latest).toBeGreaterThan(firstSequence);
		const fresh = f.coordinator.followup(caller, { agentId: b.agentId, task: "another run" }, "next");
		await f.finish(fresh.runId);
		const seen = [firstSequence];
		while (page.hasMore) {
			page = f.coordinator.listUpdates(caller, { limit: 1, cursor: page.nextCursor });
			seen.push(...page.items.map((item) => item.sequence));
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.at(-1)).toBe(latest);
		expect(f.coordinator.pendingUpdates(caller)).toBeGreaterThan(latest);
		const next = f.coordinator.listUpdates(caller);
		expect(next.items.every((item) => item.runId === fresh.runId)).toBe(true);
		expect(f.coordinator.pendingUpdates(caller)).toBeUndefined();
		expect(f.coordinator.pendingUpdates(f.root)).toBeDefined();
	});

	it("records a child's wait timeout for the root without stopping either run", async () => {
		const f = await fixture();
		const a = await f.spawn("A");
		const caller = f.coordinator.callerFor(a.runId);
		const b = await f.coordinator.spawn(caller, { task: "B", permission: f.permission, context: "none" }, "B");
		await f.started(b.runId);
		expect((await f.coordinator.wait(caller, b.runId, { timeoutMs: 0 })).timedOut).toBe(true);
		expect(
			f.coordinator
				.listUpdates(f.root)
				.items.some((event) => event.kind === "wait_timed_out" && event.runId === b.runId),
		).toBe(true);
		expect(f.coordinator.getRun(f.root, a.runId).state).toBe("running");
		expect(f.coordinator.getRun(f.root, b.runId).state).toBe("running");
	});

	it("bounds a complete safe-point batch and leaves the rest pending", async () => {
		const f = await fixture();
		const run = await f.spawn();
		for (let i = 0; i < 3; i++)
			f.coordinator.sendMessage(f.root, { targetAgentId: run.agentId, message: "x".repeat(12_000) });
		let bytes = 0;
		f.coordinator.deliverMail(run.runId, (mail) => {
			bytes += Buffer.byteLength(JSON.stringify(subagentMailMessage(mail)));
		});
		expect(bytes).toBeLessThanOrEqual(SUBAGENT_LIMITS.responseBytes);
		expect(f.coordinator.usage.mail).toBe(1);
		f.coordinator.deliverMail(run.runId, () => {});
		expect(f.coordinator.usage.mail).toBe(0);
	});

	it("retains the execution permit when the runtime cannot confirm tool cleanup", async () => {
		const f = await fixture();
		const run = await f.spawn();
		f.expectCloseFailure("child_cleanup_failed");
		f.running.get(run.runId)!.fail(new SubagentError("child_cleanup_failed"));
		await vi.waitFor(() => expect(f.coordinator.phase).toBe("closing"));
		expect(f.coordinator.usage.active).toBe(1);
		expect(f.coordinator.getRun(f.root, run.runId)).toMatchObject({
			state: "stopping",
			blockingReason: "child_cleanup_failed",
		});
		expect((await f.coordinator.wait(f.root, run.runId, { timeoutMs: 0 })).timedOut).toBe(true);
	});

	it("aborts executions when the cancellation receipt cannot be persisted", async () => {
		const f = await fixture();
		const run = await f.spawn();
		f.expectCloseFailure("disk failed");
		const write = vi.spyOn(f.session, "appendSubagentControl").mockImplementationOnce(() => {
			throw new Error("disk failed");
		});
		try {
			expect(() => f.coordinator.interrupt(f.root, run.runId, "subtree")).toThrow("disk failed");
			expect(f.running.get(run.runId)?.signal.aborted).toBe(true);
			expect(f.coordinator.phase).toBe("closing");
			expect(f.coordinator.usage.active).toBe(1);
		} finally {
			write.mockRestore();
		}
	});

	it("reuses independent child history and does not refund successful identities", async () => {
		const f = await fixture();
		const first = await f.spawn();
		await f.finish(first.runId);
		const next = f.coordinator.followup(f.root, { agentId: first.agentId, task: "second" }, "second");
		await f.finish(next.runId);
		expect(f.histories.get(first.agentId)).toEqual(["first", "second"]);
		expect(f.coordinator.usage.created).toBe(1);
		expect(f.coordinator.usage.active).toBe(0);
	});

	it("uses one cumulative identity budget for every level and idempotent tool replay", async () => {
		const f = await fixture();
		const first = await f.spawn();
		const replay = await f.coordinator.spawn(
			f.root,
			{ task: "first", permission: f.permission, context: "none" },
			"first",
		);
		expect(replay.runId).toBe(first.runId);
		const nested = await f.coordinator.spawn(
			f.coordinator.callerFor(first.runId),
			{ task: "nested", permission: f.permission, context: "none" },
			"nested",
		);
		await f.finish(nested.runId);
		await f.finish(first.runId);
		for (let i = 2; i < 8; i++) {
			const run = await f.spawn(`task-${i}`);
			await f.finish(run.runId);
		}
		await expect(f.spawn("ninth")).rejects.toThrow("agent_creation_limit");
		expect(f.coordinator.usage.created).toBe(8);
	});

	it("times out only the waiter and confirms stop only after the actual runtime settles", async () => {
		const f = await fixture();
		const run = await f.spawn();
		const timeout = await f.coordinator.wait(f.root, run.runId, { timeoutMs: 0 });
		expect(timeout.timedOut).toBe(true);
		expect(timeout.run.state).toBe("running");
		const interrupted = f.coordinator.interrupt(f.root, run.runId, "subtree");
		expect(interrupted.stopped).toBe(false);
		expect(f.coordinator.usage.active).toBe(1);
		expect(f.running.get(run.runId)?.signal.aborted).toBe(true);
		const stopping = await f.coordinator.wait(f.root, run.runId, { condition: "subtree_stopped", timeoutMs: 0 });
		expect(stopping.subtreeStopped).toBe(false);
		await f.finish(run.runId);
		expect(
			(await f.coordinator.wait(f.root, run.runId, { condition: "subtree_stopped", timeoutMs: 0 })).subtreeStopped,
		).toBe(true);
	});

	it("cancels a completed run's causal descendants without cancelling unrelated followups", async () => {
		const f = await fixture();
		const parent = await f.spawn();
		const child = await f.coordinator.spawn(
			f.coordinator.callerFor(parent.runId),
			{ task: "nested", permission: f.permission, context: "none" },
			"nested",
		);
		await f.started(child.runId);
		await f.finish(parent.runId);
		const unrelated = f.coordinator.followup(
			f.root,
			{ agentId: parent.agentId, task: "new independent task" },
			"unrelated",
		);
		await f.started(unrelated.runId);
		f.coordinator.interrupt(f.root, parent.runId, "subtree");
		expect(f.running.get(child.runId)?.signal.aborted).toBe(true);
		expect(f.running.get(unrelated.runId)?.signal.aborted).toBe(false);
		await f.finish(child.runId);
		await f.finish(unrelated.runId);
	});

	it("retains the A3 predecessor after cancelling queued A2", async () => {
		const f = await fixture();
		const a1 = await f.spawn();
		const a2 = f.coordinator.followup(f.root, { agentId: a1.agentId, task: "A2" }, "A2");
		const a3 = f.coordinator.followup(f.root, { agentId: a1.agentId, task: "A3" }, "A3");
		f.coordinator.interrupt(f.root, a2.runId, "run");
		await expect(f.coordinator.wait(f.coordinator.callerFor(a1.runId), a3.runId, { timeoutMs: 0 })).rejects.toThrow(
			"run_wait_cycle",
		);
		await f.finish(a1.runId);
		await f.finish(a3.runId);
		expect(f.histories.get(a1.agentId)).toEqual(["first", "A3"]);
	});

	it("paginates a UTF-8 result without losing characters", async () => {
		const f = await fixture();
		const run = await f.spawn();
		const expected = "中文😀".repeat(3000);
		await f.finish(run.runId, expected);
		let actual = "";
		let offset = 0;
		while (true) {
			const chunk = f.coordinator.readResult(f.root, run.runId, offset);
			actual += chunk.text;
			if (chunk.complete) break;
			offset = chunk.nextOffset!;
		}
		expect(actual).toBe(expected);
		expect(() => f.coordinator.readResult(f.root, run.runId, 1)).toThrow("invalid_content_cursor");
	});

	it("waits for the requested run's version instead of unrelated activity", async () => {
		const f = await fixture();
		const a = await f.spawn("A");
		const b = await f.spawn("B");
		const before = await f.coordinator.wait(f.root, a.runId, { condition: "update", timeoutMs: 0 });
		const waiting = f.coordinator.wait(f.root, a.runId, {
			condition: "update",
			version: before.version,
			timeoutMs: 20,
		});
		f.coordinator.activity(b.runId, "unrelated progress");
		const unchanged = await waiting;
		expect(unchanged.timedOut).toBe(true);
		expect(unchanged.version).toBe(before.version);
		const updated = f.coordinator.wait(f.root, a.runId, {
			condition: "update",
			version: before.version,
			timeoutMs: 1000,
		});
		f.coordinator.activity(a.runId, "requested progress");
		expect((await updated).timedOut).toBe(false);
	});

	it("coalesces streamed activity commits while retaining the latest live and terminal timestamps", async () => {
		const f = await fixture();
		const run = await f.spawn();
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const before = [...f.session.readSubagentControl()].length;
			for (let i = 0; i < 100; i++) {
				now++;
				f.coordinator.activity(run.runId);
			}
			expect([...f.session.readSubagentControl()].length - before).toBe(1);
			expect(f.coordinator.getRun(f.root, run.runId).lastActivityAt).toBe(now);
			now += 1000;
			f.coordinator.activity(run.runId);
			expect([...f.session.readSubagentControl()].length - before).toBe(2);
			f.coordinator.activity(run.runId, "progress is immediate");
			expect(f.coordinator.getRun(f.root, run.runId).lastProgressAt).toBe(now);
			now++;
			f.coordinator.activity(run.runId);
			const result = await f.finish(run.runId);
			expect(result.run.lastActivityAt).toBe(now);
		} finally {
			clock.mockRestore();
		}
	});

	it("bounds JSON pages and excludes records accepted after the first page", async () => {
		const f = await fixture();
		const task = "\u0000".repeat(1500);
		const first = await f.spawn(task, "initial");
		await f.finish(first.runId);
		const expected = [first.runId];
		for (let i = 0; i < 21; i++) {
			const run = f.coordinator.followup(f.root, { agentId: first.agentId, task }, `run-${i}`);
			expected.push(run.runId);
			await f.finish(run.runId);
		}
		let page = f.coordinator.listRuns(f.root, { limit: 50 });
		expect(page.hasMore).toBe(true);
		const later = f.coordinator.followup(f.root, { agentId: first.agentId, task: "outside snapshot" }, "later");
		await f.finish(later.runId);
		const actual: string[] = [];
		while (true) {
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SUBAGENT_LIMITS.responseBytes);
			actual.push(...page.items.map((item) => item.runId));
			if (!page.hasMore) break;
			page = f.coordinator.listRuns(f.root, { limit: 50, cursor: page.nextCursor });
		}
		expect(actual).toEqual(expected);
		const defaultPage = f.coordinator.listRuns(f.root);
		expect(defaultPage.items.length).toBeLessThanOrEqual(20);
		expect(defaultPage.items[0].task.incomplete).toBe(true);
		expect(f.coordinator.readContent(f.root, defaultPage.items[0].task.contentRef).text).toBe(task);
		expect(() => f.coordinator.listRuns(f.root, { limit: 51 })).toThrow("invalid_page_limit");
		expect(() => f.coordinator.listRuns(f.root, { cursor: defaultPage.nextCursor, agentId: first.agentId })).toThrow(
			"invalid_query_cursor",
		);
	});

	it("keeps stable queue pagination when the middle predecessor is cancelled", async () => {
		const f = await fixture();
		const a1 = await f.spawn();
		const a2 = f.coordinator.followup(f.root, { agentId: a1.agentId, task: "A2" }, "A2");
		const a3 = f.coordinator.followup(f.root, { agentId: a1.agentId, task: "A3" }, "A3");
		const page = f.coordinator.listRuns(f.root, { queuedOnly: true, limit: 1 });
		expect(page.items[0].runId).toBe(a2.runId);
		f.coordinator.interrupt(f.root, a2.runId, "run");
		const next = f.coordinator.listRuns(f.root, { queuedOnly: true, limit: 1, cursor: page.nextCursor });
		expect(next.items.map((run) => run.runId)).toEqual([a3.runId]);
	});

	it("rechecks access to pages and content refs for each requesting agent", async () => {
		const f = await fixture();
		const a = await f.spawn("A private task");
		const b = await f.spawn("B private task");
		const callerA = f.coordinator.callerFor(a.runId);
		const page = f.coordinator.listRuns(f.root, { limit: 1 });
		expect(() => f.coordinator.listRuns(callerA, { cursor: page.nextCursor, limit: 1 })).toThrow(
			"invalid_query_cursor",
		);
		expect(f.coordinator.listRuns(callerA).items.map((run) => run.runId)).toEqual([a.runId]);
		expect(() => f.coordinator.readContent(callerA, `${f.root.rootSessionId}:task:${b.runId}`)).toThrow(
			"run_access_denied",
		);
		const mail = f.coordinator.sendMessage(f.root, { targetAgentId: b.agentId, message: "private message" });
		expect(() => f.coordinator.readContent(callerA, `${f.root.rootSessionId}:mail:${mail.messageId}`)).toThrow(
			"mail_access_denied",
		);
		expect(f.coordinator.listMessages(callerA).items).toEqual([]);
		const receive = vi.fn();
		f.coordinator.deliverMail(b.runId, receive);
		expect(receive).toHaveBeenCalledTimes(1);
		const delivered = f.coordinator.listMessages(f.root).items;
		expect(delivered).toHaveLength(1);
		expect(delivered[0].state).toBe("delivered");
	});

	it("uses host permissions instead of a modified caller grant", async () => {
		const f = await fixture();
		const a = await f.spawn();
		const caller = f.coordinator.callerFor(a.runId);
		caller.permission = {
			mode: "full",
		};
		const b = await f.coordinator.spawn(
			caller,
			{ task: "nested", context: "none", permission: caller.permission },
			"nested",
		);
		expect(b.permission.mode).toBe("read-only");
	});
});
