import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineExtension, ToolDefinition } from "../src/core/extensions/index.ts";
import { PendingDeliveryStore } from "../src/core/pending-delivery.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { withSubagentToolPermission } from "../src/core/subagents/permissions.ts";
import { RootSubagentCoordinator } from "../src/core/subagents/root-coordinator.ts";
import { deliverSubagentMail } from "../src/core/subagents/session-mailbox.ts";
import { InProcessSubagentFactory, selectSubagentContext } from "../src/core/subagents/session-runtime.ts";
import type { SubagentPermission } from "../src/core/subagents/types.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const cleanups: (() => Promise<void>)[] = [];
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(extensions: InlineExtension[] = [], tools: ToolDefinition[] = []) {
	const harness = await createHarness({
		persistSession: true,
		settings: { retry: { enabled: false }, compaction: { enabled: false }, memory: { enabled: false } },
		initialActiveToolNames: [],
	});
	const createFactory = (manager: SessionManager) =>
		new InProcessSubagentFactory({
			rootSession: manager,
			rootResources: harness.session.resourceLoader,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			model: () => harness.getModel(),
			thinkingLevel: () => "off",
			settings: () => harness.settingsManager,
			resources: async () =>
				createTestResourceLoader({
					extensionsResult: await createTestExtensionsResult(extensions, harness.tempDir),
				}),
			tools: () => tools.map((tool) => withSubagentToolPermission(tool, "read-only")),
		});
	const factory = createFactory(harness.sessionManager);
	const permission: SubagentPermission = {
		mode: "read-only",
	};
	const coordinator = await RootSubagentCoordinator.open({
		session: harness.sessionManager,
		factory,
		permission: () => permission,
		rootContext: (selection) => selectSubagentContext(harness.session.messages, selection),
		recover: async () => {},
	});
	const root = coordinator.beginRootRun();
	cleanups.push(async () => {
		await coordinator.close();
		await harness.cleanup();
	});
	return { harness, factory, coordinator, root, permission, createFactory };
}

describe("in-process persistent child AgentSession", () => {
	it("keeps the child lease and reports the last accepted extension continuation result", async () => {
		const entered = deferred(),
			release = deferred();
		const f = await fixture([
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
		]);
		f.harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("final continuation result")]);
		const run = await f.coordinator.spawn(
			f.root,
			{ task: "first", permission: f.permission, context: "none" },
			"first",
		);
		try {
			await entered.promise;
			await vi.waitFor(() => expect(f.factory.getSession(run.agentId)!.agent.state.runState.status).toBe("idle"));
			expect(f.coordinator.getRun(f.root, run.runId).state).toBe("running");
			expect(f.coordinator.usage.active).toBe(1);
		} finally {
			release.resolve();
		}
		expect((await f.coordinator.wait(f.root, run.runId, { timeoutMs: 1000 })).run.state).toBe("completed");
		expect(f.coordinator.readResult(f.root, run.runId).text).toBe("final continuation result");
		expect(f.coordinator.usage.active).toBe(0);
		expect(f.harness.getPendingResponseCount()).toBe(0);
	});

	it("reports cleanup failures after attempting the remaining child resources", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("ready")]);
		const run = await f.coordinator.spawn(
			f.root,
			{ task: "first", context: "none", permission: f.permission },
			"first",
		);
		await f.coordinator.wait(f.root, run.runId, { timeoutMs: 1000 });
		const child = f.factory.getSession(run.agentId)!;
		const lsp = vi
			.spyOn(child.lspManager, "disposeAll")
			.mockRejectedValueOnce(new Error("controlled cleanup failure"));
		const mcp = vi.spyOn(child.mcpManager, "disposeAll");
		try {
			await expect(child.dispose()).rejects.toThrow("subagent_session_cleanup_failed");
			expect(mcp).toHaveBeenCalledTimes(1);
			expect(child.sessionManager.getRootOwnership()).toBeDefined();
		} finally {
			lsp.mockRestore();
			mcp.mockRestore();
		}
	});

	it("delivers running mail at a turn boundary without a steering queue or an extra run", async () => {
		const entered = deferred();
		const released = deferred();
		const f = await fixture(
			[],
			[
				{
					name: "controlled_wait",
					label: "Controlled wait",
					description: "Wait for the test host",
					parameters: Type.Object({}),
					async execute() {
						entered.resolve();
						await released.promise;
						return { content: [{ type: "text", text: "released" }], details: {} };
					},
				},
			],
		);
		f.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("controlled_wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const content = context.messages.map(getMessageText).join("\n");
				expect(content).toContain("running-message-marker");
				expect(content).toContain(`From agent: ${f.root.agentId}`);
				return fauxAssistantMessage("mail received");
			},
		]);
		const run = await f.coordinator.spawn(
			f.root,
			{ task: "wait", context: "none", permission: f.permission },
			"mail-run",
		);
		await entered.promise;
		try {
			f.coordinator.sendMessage(f.root, {
				targetAgentId: run.agentId,
				targetRunId: run.runId,
				message: "running-message-marker",
			});
			expect(f.coordinator.usage.mail).toBe(1);
			expect(f.factory.getSession(run.agentId)!.getSteeringMessages()).toHaveLength(0);
		} finally {
			released.resolve();
		}
		expect((await f.coordinator.wait(f.root, run.runId, { timeoutMs: 1000 })).run.state).toBe("completed");
		expect(f.coordinator.usage.mail).toBe(0);
		expect(f.coordinator.listMessages(f.root).items[0].state).toBe("delivered");
		expect(f.coordinator.listRuns(f.root).items).toHaveLength(1);
		expect(f.harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps idle mail pending and reconciles a recipient receipt after reopening", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("idle")]);
		const run = await f.coordinator.spawn(
			f.root,
			{ task: "first", context: "none", permission: f.permission },
			"first",
		);
		await f.coordinator.wait(f.root, run.runId, { timeoutMs: 1000 });
		const mail = f.coordinator.sendMessage(f.root, { targetAgentId: run.agentId, message: "one-durable-mail" });
		expect(f.coordinator.usage.mail).toBe(1);
		expect(f.coordinator.usage.active).toBe(0);
		// Simulate a crash after the recipient history commit but before the root receipt.
		deliverSubagentMail(f.factory.getSession(run.agentId)!, mail);
		f.coordinator.endRootRun(f.root.runId, "completed");
		await f.coordinator.close();
		const manager = SessionManager.open(f.harness.sessionManager.getSessionFile()!);
		const factory = f.createFactory(manager);
		const recovered = await RootSubagentCoordinator.open({
			session: manager,
			factory,
			permission: () => f.permission,
			rootContext: () => [],
			recover: async () => {},
		});
		try {
			expect(recovered.usage.mail).toBe(0);
			const caller = recovered.beginRootRun();
			f.harness.setResponses([
				(context) => {
					expect(
						context.messages.map(getMessageText).filter((text) => text.includes("one-durable-mail")),
					).toHaveLength(1);
					return fauxAssistantMessage("resumed");
				},
			]);
			const next = recovered.followup(caller, { agentId: run.agentId, task: "resume" }, "resume");
			expect((await recovered.wait(caller, next.runId, { timeoutMs: 1000 })).run.state).toBe("completed");
			expect(recovered.usage.mail).toBe(0);
			expect(
				factory
					.getSession(run.agentId)!
					.sessionManager.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-mail"),
			).toHaveLength(1);
		} finally {
			await recovered.close();
		}
	});

	it("reopens the same identities without replaying old runs or queued startup content", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("remembered across restart")]);
		const first = await f.coordinator.spawn(
			f.root,
			{ task: "first", permission: f.permission, context: "none" },
			"first",
		);
		await f.coordinator.wait(f.root, first.runId, { timeoutMs: 1000 });
		const child = f.factory.getSession(first.agentId)!;
		new PendingDeliveryStore(child.sessionManager).enqueue("follow_up", {
			role: "user",
			content: "do not replay",
			timestamp: 1,
		});
		const oldActive = { ...first, runId: "old-active", state: "running" as const, task: "unfinished" };
		const oldQueued = { ...first, runId: "old-queued", state: "queued" as const, task: "queued" };
		f.harness.sessionManager.appendSubagentControl({ kind: "run_accepted", run: oldActive });
		f.harness.sessionManager.appendSubagentControl({ kind: "run_accepted", run: oldQueued });
		f.coordinator.endRootRun(f.root.runId, "completed");
		await f.coordinator.close();
		const manager = SessionManager.open(f.harness.sessionManager.getSessionFile()!);
		const factory = f.createFactory(manager);
		const recovered = await RootSubagentCoordinator.open({
			session: manager,
			factory,
			permission: () => f.permission,
			rootContext: () => [],
			recover: async () => {
				const events = [...manager.readSubagentControl()].map((record) => record.control);
				expect(
					events.some(
						(event) =>
							event.kind === "run_finished" &&
							event.run.runId === "old-queued" &&
							event.run.state === "cancelled",
					),
				).toBe(true);
				expect(
					events.some(
						(event) =>
							event.kind === "run_updated" &&
							event.run.runId === "old-active" &&
							event.run.state === "recovering",
					),
				).toBe(true);
				expect(factory.getSession(first.agentId)).toBeUndefined();
			},
		});
		try {
			const caller = recovered.beginRootRun();
			expect(recovered.usage).toMatchObject({ created: 1, active: 0, queued: 0 });
			expect(recovered.getRun(caller, "old-active")).toMatchObject({ state: "interrupted", effectsUnknown: true });
			f.harness.setResponses([
				(context) => {
					const text = context.messages.map(getMessageText).join("\n");
					expect(text).toContain("remembered across restart");
					expect(text).not.toContain("do not replay");
					return fauxAssistantMessage("explicit new run");
				},
			]);
			const next = recovered.followup(caller, { agentId: first.agentId, task: "explicit continuation" }, "next");
			expect((await recovered.wait(caller, next.runId, { timeoutMs: 1000 })).run.state).toBe("completed");
			expect(factory.getSession(first.agentId)!.sessionId).toBe(child.sessionId);
			expect(recovered.usage.created).toBe(1);
		} finally {
			await recovered.close();
		}
	});

	it("reuses the same child session and provider history across explicit followups", async () => {
		const f = await fixture();
		f.harness.setResponses([
			() => {
				expect(process.pid).toBe(f.coordinator.processId);
				return fauxAssistantMessage("remembered token");
			},
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain("remembered token");
				return fauxAssistantMessage("followup completed");
			},
		]);
		const first = await f.coordinator.spawn(
			f.root,
			{ task: "first task", permission: f.permission, context: "none" },
			"first",
		);
		expect((await f.coordinator.wait(f.root, first.runId, { timeoutMs: 1000 })).run.state).toBe("completed");
		const session = f.factory.getSession(first.agentId)!;
		const next = f.coordinator.followup(f.root, { agentId: first.agentId, task: "continue" }, "next");
		const finished = await f.coordinator.wait(f.root, next.runId, { timeoutMs: 1000 });
		expect(finished.run.state).toBe("completed");
		expect(f.coordinator.readResult(f.root, next.runId).text).toBe("followup completed");
		expect(f.factory.getSession(first.agentId)).toBe(session);
		expect(session.sessionId).not.toBe(f.harness.session.sessionId);
		expect(f.harness.getPendingResponseCount()).toBe(0);
	});

	it("owns independent settings, tools, contexts and extension runtimes", async () => {
		const f = await fixture();
		f.harness.setResponses([
			fauxAssistantMessage("private A"),
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).not.toContain("private A");
				return fauxAssistantMessage("private B");
			},
		]);
		const a = await f.coordinator.spawn(f.root, { task: "A", permission: f.permission, context: "none" }, "A");
		await f.coordinator.wait(f.root, a.runId, { timeoutMs: 1000 });
		const b = await f.coordinator.spawn(f.root, { task: "B", permission: f.permission, context: "none" }, "B");
		await f.coordinator.wait(f.root, b.runId, { timeoutMs: 1000 });
		const first = f.factory.getSession(a.agentId)!;
		const second = f.factory.getSession(b.agentId)!;
		expect(first.agent).not.toBe(second.agent);
		expect(first.taskManager).not.toBe(second.taskManager);
		expect(first.resourceLoader.getExtensions().runtime).not.toBe(second.resourceLoader.getExtensions().runtime);
		first.settingsManager.setDefaultModel("changed in A");
		expect(second.settingsManager.getDefaultModel()).not.toBe("changed in A");
		expect(f.harness.settingsManager.getDefaultModel()).not.toBe("changed in A");
	});

	it("does not start an idle child from SDK or extension turn-triggering entry points", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must remain unused")]);
		const run = await f.coordinator.spawn(
			f.root,
			{ task: "task", permission: f.permission, context: "none" },
			"task",
		);
		await f.coordinator.wait(f.root, run.runId, { timeoutMs: 1000 });
		const child = f.factory.getSession(run.agentId)!;
		await expect(child.prompt("unauthorized")).rejects.toThrow("subagent_run_authority_required");
		await expect(child.sendUserMessage("unauthorized")).rejects.toThrow("subagent_run_authority_required");
		await expect(
			child.sendCustomMessage(
				{ customType: "test", content: "unauthorized", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("subagent_run_authority_required");
		expect(f.harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels during awaited prompt preflight without starting a late model request", async () => {
		const { promise: entered, resolve: notify } = deferred();
		const { promise: gate, resolve: release } = deferred();
		const f = await fixture([
			(pi) => {
				pi.on("input", async () => {
					notify();
					await gate;
				});
			},
		]);
		f.harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const run = await f.coordinator.spawn(
			f.root,
			{ task: "slow preflight", permission: f.permission, context: "none" },
			"slow",
		);
		await entered;
		try {
			expect(f.coordinator.interrupt(f.root, run.runId, "subtree").stopped).toBe(false);
			expect(f.coordinator.usage.active).toBe(1);
			expect(
				(await f.coordinator.wait(f.root, run.runId, { condition: "subtree_stopped", timeoutMs: 0 }))
					.subtreeStopped,
			).toBe(false);
		} finally {
			release();
		}
		const stopped = await f.coordinator.wait(f.root, run.runId, { condition: "subtree_stopped", timeoutMs: 1000 });
		expect(stopped.subtreeStopped).toBe(true);
		expect(f.harness.getPendingResponseCount()).toBe(1);
	});
});
