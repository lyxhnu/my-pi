import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { InlineExtension } from "../../src/core/extensions/index.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { withSubagentToolPermission } from "../../src/core/subagents/permissions.ts";
import type { RootSubagentOptions } from "../../src/core/subagents/root-session.ts";
import type { SubagentRun } from "../../src/core/subagents/types.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture() {
	const harness = await createHarness({
		settings: {
			retry: { enabled: false },
			compaction: { enabled: false },
			memory: { enabled: false },
			permissions: { mode: "bypassPermissions" },
		},
	});
	cleanups.push(harness.cleanup);
	return harness;
}

async function open(
	harness: Harness,
	options: {
		manager?: SessionManager;
		tools?: ToolDefinition[];
		children?: RootSubagentOptions["tools"];
		shutdown?: () => Promise<void>;
		extensions?: InlineExtension[];
	} = {},
) {
	const sessionManager = options.manager ?? SessionManager.create(harness.tempDir, join(harness.tempDir, "managed"));
	const extensionsResult = await createTestExtensionsResult(
		[
			...(options.extensions ?? []),
			(pi) => {
				if (options.shutdown) pi.on("session_shutdown", options.shutdown);
			},
		],
		harness.tempDir,
	);
	const created = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		model: harness.getModel(),
		thinkingLevel: "off",
		settingsManager: harness.settingsManager,
		sessionManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		customTools: options.tools?.map((tool) => withSubagentToolPermission(tool, "read-only")),
		tools: [
			"spawn_agent",
			"followup_task",
			"send_message",
			"list_agents",
			"get_agent_info",
			"wait_agent",
			"interrupt_agent",
			...(options.tools?.map((tool) => tool.name) ?? []),
		],
		subagents: {
			permission: () => ({ mode: "read-only" }),
			recover: async () => {},
			resources: async () => createTestResourceLoader(),
			tools: options.children ?? (() => []),
		},
	});
	await created.session.bindExtensions({});
	cleanups.push(() => created.session.dispose());
	return created.session;
}

describe("SDK root-owned subagent lifetime", () => {
	it.each([false, true])("settles an accepted extension continuation before finishing (cancel=%s)", async (cancel) => {
		const h = await fixture();
		const entered = deferred(),
			release = deferred();
		const root = await open(h, {
			extensions: [
				(pi) => {
					let continued = false;
					pi.on("agent_end", () => {
						if (!continued) {
							continued = true;
							pi.sendUserMessage("accepted continuation");
						}
					});
					pi.on("input", async (event) => {
						if (event.text === "accepted continuation") {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("continuation result")]);
		let finished = false;
		const pending = root.prompt("first").then(() => {
			finished = true;
		});
		void pending.catch(() => {});
		try {
			await entered.promise;
			await vi.waitFor(() => expect(root.agent.state.runState.status).toBe("idle"));
			expect(finished).toBe(false);
			expect(
				[...root.sessionManager.readSubagentControl()].some((entry) => entry.control.kind === "run_finished"),
			).toBe(false);
			if (cancel) await root.abort();
		} finally {
			release.resolve();
		}
		await pending;
		const finishedRuns = [...root.sessionManager.readSubagentControl()].filter(
			(entry) => entry.control.kind === "run_finished",
		);
		expect(finishedRuns).toHaveLength(1);
		expect(finishedRuns[0].control).toMatchObject({ run: { state: cancel ? "cancelled" : "completed" } });
		expect(h.getPendingResponseCount()).toBe(cancel ? 1 : 0);
		if (!cancel) expect(root.messages.map(getMessageText)).toContain("continuation result");
	});

	it("runtime disposal closes admission before emitting shutdown exactly once", async () => {
		const h = await fixture();
		const order: string[] = [];
		let root: AgentSession;
		root = await open(h, {
			shutdown: async () => {
				expect(root.subagents!.coordinator.phase).toBe("closing");
				await expect(root.prompt("from shutdown")).rejects.toThrow("root_closing");
				order.push("shutdown");
			},
		});
		const runtime = new AgentSessionRuntime(
			root,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: root.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: root.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("not replacing in this test");
			},
		);
		runtime.setBeforeSessionInvalidate(() => {
			order.push("invalidate");
		});
		await runtime.dispose();
		await root.dispose();
		expect(order).toEqual(["shutdown", "invalidate"]);
		expect(root.subagents!.coordinator.phase).toBe("closed");
	});

	it("does not disable an owned root coordinator through the SDK", async () => {
		const h = await fixture();
		const root = await open(h);
		await root.dispose();
		const sessionManager = SessionManager.open(root.sessionFile!);
		try {
			await expect(
				createAgentSession({
					cwd: h.tempDir,
					agentDir: h.tempDir,
					modelRuntime: root.modelRuntime,
					subagents: false,
					sessionManager,
					settingsManager: h.settingsManager,
					resourceLoader: createTestResourceLoader(),
				}),
			).rejects.toThrow("root_coordinator_required");
		} finally {
			sessionManager.closeOwnership();
		}
	});

	it("cancels an unfinished identity preparation with its root run before it can commit", async () => {
		const h = await fixture();
		const root = await open(h);
		const prepared = deferred(),
			release = deferred();
		const prepare = root.subagents!.factory.prepare.bind(root.subagents!.factory);
		let childSignal: AbortSignal | undefined;
		vi.spyOn(root.subagents!.factory, "prepare").mockImplementation(async (agent, context, signal) => {
			await prepare(agent, context, signal);
			childSignal = signal;
			prepared.resolve();
			await release.promise;
		});
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					task: "not accepted",
					context: "none",
					permission: { mode: "read-only" },
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const pending = root.prompt("prepare child");
		void pending.catch(() => {});
		await prepared.promise;
		const stopping = root.abort();
		expect(childSignal?.aborted).toBe(true);
		expect(root.subagents!.coordinator.usage.pending).toBe(1);
		release.resolve();
		await stopping;
		await pending;
		expect(root.subagents!.coordinator.usage).toMatchObject({ created: 0, pending: 0, active: 0 });
		expect(
			[...root.sessionManager.readSubagentControl()].some((entry) => entry.control.kind === "agent_created"),
		).toBe(false);
	});

	it("keeps the root owned when its shutdown hook fails", async () => {
		const h = await fixture();
		const root = await open(h, {
			shutdown: async () => {
				throw new Error("shutdown failed");
			},
		});
		const cleanup = cleanups.pop()!;
		cleanups.push(async () => {
			await expect(cleanup()).rejects.toThrow("subagent_children_cleanup_failed");
			// This fixture's hook only throws: it has no external work to settle.
			root.sessionManager.closeOwnership();
		});
		await expect(root.dispose()).rejects.toThrow("subagent_children_cleanup_failed");
		expect(root.subagents!.coordinator.phase).toBe("closing");
		expect(() => SessionManager.open(root.sessionFile!)).toThrow();
		await expect(root.prompt("after failure")).rejects.toThrow("root_closing");
	});

	it("registers seven tools and delivers child mail at the root safe point without manually issuing root leases", async () => {
		const h = await fixture();
		const root = await open(h);
		const permission = { mode: "read-only" };
		let run: SubagentRun;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { task: "child", permission, context: "none" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				if (getMessageText(context.messages.at(-1)) === "child") {
					return fauxAssistantMessage(
						fauxToolCall("send_message", { targetAgentId: root.sessionId, message: "child-report-742" }),
						{ stopReason: "toolUse" },
					);
				}
				run = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1))).run;
				return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: run.runId, timeoutMs: 1000 }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				if (context.messages.some((m) => m.role === "toolResult" && m.toolName === "spawn_agent")) {
					run = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1))).run;
					return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: run.runId, timeoutMs: 1000 }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage(
					fauxToolCall("send_message", { targetAgentId: root.sessionId, message: "child-report-742" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("child done"),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("child-report-742");
				expect(text).toContain("Subagent updates are available");
				return fauxAssistantMessage("root done");
			},
		]);
		expect(root.getAllTools().map((tool) => tool.name)).not.toContain("task");
		await root.prompt("delegate");
		const events = [...root.sessionManager.readSubagentControl()].map((r) => r.control);
		expect(
			events.filter((event) => event.kind === "run_finished" && event.run.agentId === root.sessionId),
		).toHaveLength(1);
		expect(events.some((event) => event.kind === "mail" && event.mail.state === "delivered")).toBe(true);
		expect(root.subagents!.coordinator.usage.created).toBe(1);
	});

	it("close retains ownership until the root background task and shutdown hook both finish", async () => {
		const h = await fixture();
		const started = deferred(),
			aborted = deferred(),
			release = deferred(),
			shutdown = deferred(),
			shutdownEntered = deferred();
		let root: AgentSession;
		root = await open(h, {
			tools: [
				{
					name: "background",
					label: "background",
					description: "start owned work",
					parameters: Type.Object({}),
					async execute() {
						root.taskManager.start({
							kind: "bash",
							description: "controlled writer",
							run: async ({ signal }) => {
								signal.addEventListener("abort", aborted.resolve, { once: true });
								started.resolve();
								await release.promise;
								return { status: "completed" };
							},
						});
						return { content: [{ type: "text", text: "started" }], details: {} };
					},
				},
			],
			shutdown: async () => {
				shutdownEntered.resolve();
				await shutdown.promise;
			},
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("waiting for writer"),
		]);
		const pending = root.prompt("start");
		void pending.catch(() => {});
		await started.promise;
		let closed = false;
		const closing = root.dispose().then(() => {
			closed = true;
		});
		await aborted.promise;
		expect(root.subagents!.coordinator.phase).toBe("closing");
		await expect(root.prompt("too late")).rejects.toThrow();
		expect(() => SessionManager.open(root.sessionFile!)).toThrow();
		expect(closed).toBe(false);
		release.resolve();
		await pending.catch(() => {});
		await shutdownEntered.promise;
		expect(closed).toBe(false);
		expect(() => SessionManager.open(root.sessionFile!)).toThrow();
		shutdown.resolve();
		await closing;
		expect(root.subagents!.coordinator.phase).toBe("closed");
		const manager = SessionManager.open(root.sessionFile!);
		expect(
			[...manager.readSubagentControl()].some(
				(event) =>
					event.control.kind === "run_finished" &&
					event.control.run.agentId === root.sessionId &&
					event.control.run.state === "cancelled",
			),
		).toBe(true);
		manager.closeOwnership();
	});

	it("rejects a delayed old callback while admitting fresh user steering into the current run", async () => {
		const h = await fixture();
		const delayed = deferred(),
			active = deferred(),
			release = deferred();
		let stale: Promise<void> | undefined;
		let root: AgentSession;
		root = await open(h, {
			tools: [
				{
					name: "defer",
					label: "defer",
					description: "retain old async context",
					parameters: Type.Object({}),
					async execute() {
						stale = delayed.promise.then(() => root.prompt("stale"));
						void stale.catch(() => {});
						return { content: [{ type: "text", text: "deferred" }], details: {} };
					},
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("defer", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("one"),
		]);
		await root.prompt("first");
		h.setResponses([
			async () => {
				active.resolve();
				await release.promise;
				return fauxAssistantMessage("two");
			},
			fauxAssistantMessage("steered"),
		]);
		const next = root.prompt("second");
		await active.promise;
		delayed.resolve();
		await expect(stale).rejects.toThrow("subagent_run_authority_required");
		await root.steer("fresh input");
		release.resolve();
		await next;
		expect(root.messages.map(getMessageText)).toContain("fresh input");
		expect(root.messages.map(getMessageText)).not.toContain("stale");
		const roots = [...root.sessionManager.readSubagentControl()].filter(
			(event) => event.control.kind === "run_accepted" && event.control.run.agentId === root.sessionId,
		);
		expect(roots).toHaveLength(2);
	});

	it("restores identities and history without model calls, then explicitly continues the same child", async () => {
		const h = await fixture();
		let child: SubagentRun;
		const root = await open(h, {
			tools: [
				{
					name: "delegate",
					label: "delegate",
					description: "delegate once",
					parameters: Type.Object({}),
					async execute() {
						const host = root.subagents!;
						const caller = host.coordinator.callerFor(host.scope.assertActive().runId);
						child = await host.coordinator.spawn(
							caller,
							{ task: "remember jade-583", context: "none", permission: caller.permission },
							"spawn",
						);
						await host.coordinator.wait(caller, child.runId, { timeoutMs: 1000 });
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("jade-583"),
			fauxAssistantMessage("root done"),
		]);
		await root.prompt("first");
		const file = root.sessionFile!;
		await root.dispose();
		const stream = vi.spyOn(h.session.modelRuntime, "streamSimple");
		const reopened = await open(h, { manager: SessionManager.open(file) });
		expect(stream).not.toHaveBeenCalled();
		expect(reopened.subagents!.coordinator.usage.created).toBe(1);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("followup_task", { agentId: child!.agentId, task: "recall" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				if (context.messages.map(getMessageText).includes("recall")) {
					expect(context.messages.map(getMessageText).join("\n")).toContain("jade-583");
					return fauxAssistantMessage("jade-583 recalled");
				}
				const result = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: result.runId, timeoutMs: 1000 }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				if (context.messages.map(getMessageText).includes("recall"))
					return fauxAssistantMessage("jade-583 recalled");
				const result = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: result.runId, timeoutMs: 1000 }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("reopened root done"),
		]);
		await reopened.prompt("continue child");
		expect(reopened.subagents!.coordinator.usage.created).toBe(1);
		const results = [...reopened.sessionManager.readSubagentControl()].filter(
			(event) => event.control.kind === "run_finished" && event.control.run.agentId === child!.agentId,
		);
		expect(results).toHaveLength(2);
		expect(results[1].control.kind === "run_finished" && results[1].control.run.resultSummary).toBe(
			"jade-583 recalled",
		);
		stream.mockRestore();
	});
});
