import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { RootSubagentCoordinator } from "../../src/core/subagents/root-coordinator.ts";
import { InProcessSubagentFactory, selectSubagentContext } from "../../src/core/subagents/session-runtime.ts";
import { createSubagentTools } from "../../src/core/subagents/tools.ts";
import type { SubagentCaller, SubagentPermission } from "../../src/core/subagents/types.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("root/child/grandchild through the seven in-process tools", () => {
	it("delegates recursively, returns results to each issuer, and follows up in the original child context", async () => {
		let coordinator: RootSubagentCoordinator;
		let caller: SubagentCaller;
		const harness = await createHarness({
			persistSession: true,
			settings: {
				retry: { enabled: false },
				compaction: { enabled: false },
				memory: { enabled: false },
				permissions: { mode: "bypassPermissions" },
			},
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					for (const tool of createSubagentTools(
						() => coordinator,
						() => caller,
					))
						pi.registerTool(tool);
				},
			],
		});
		const permission: SubagentPermission = {
			mode: "read-only",
		};
		const factory = new InProcessSubagentFactory({
			rootSession: harness.sessionManager,
			rootResources: harness.session.resourceLoader,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			model: () => harness.getModel(),
			thinkingLevel: () => "off",
			settings: () => harness.settingsManager,
			resources: async () => createTestResourceLoader(),
			tools: (_agent, scope) =>
				createSubagentTools(
					() => coordinator,
					() => coordinator.callerFor(scope.assertActive().runId),
				),
		});
		coordinator = await RootSubagentCoordinator.open({
			session: harness.sessionManager,
			factory,
			permission: () => permission,
			rootContext: (selection) => selectSubagentContext(harness.session.messages, selection),
			recover: async () => {},
		});
		caller = coordinator.beginRootRun();
		cleanups.push(async () => {
			await coordinator.close();
			await harness.cleanup();
		});
		const calls: { task: string; pid: number }[] = [];
		let rootPhase = 0;
		let childPhase = 0;
		let childAgentId = "";
		const respond: FauxResponseFactory = (context) => {
			const task = context.messages
				.filter((message) => message.role === "user")
				.map(getMessageText)
				.filter((text) => text.startsWith("TEST:"))
				.at(-1)!;
			calls.push({ task, pid: process.pid });
			const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
			const value = result
				? (JSON.parse(getMessageText(result)) as {
						run?: { runId: string; agentId: string; state?: string };
						runId?: string;
						timedOut?: boolean;
						error?: string;
					})
				: undefined;
			if (value?.error) throw new Error(`Tool failed: ${value.error}`);
			if (task === "TEST:root") {
				rootPhase++;
				if (rootPhase === 1)
					return fauxAssistantMessage(
						fauxToolCall("spawn_agent", { task: "TEST:child", permission, context: "none" }),
						{ stopReason: "toolUse" },
					);
				if (rootPhase === 2) {
					childAgentId = value!.run!.agentId;
					return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: value!.run!.runId, timeoutMs: 1000 }), {
						stopReason: "toolUse",
					});
				}
				if (rootPhase === 3) {
					expect(value?.run?.state).toBe("completed");
					return fauxAssistantMessage(
						fauxToolCall("followup_task", { agentId: childAgentId, task: "TEST:followup" }),
						{ stopReason: "toolUse" },
					);
				}
				if (rootPhase === 4)
					return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: value!.runId, timeoutMs: 1000 }), {
						stopReason: "toolUse",
					});
				expect(value?.run?.state).toBe("completed");
				return fauxAssistantMessage("root finished");
			}
			if (task === "TEST:child") {
				childPhase++;
				if (childPhase === 1)
					return fauxAssistantMessage(
						fauxToolCall("spawn_agent", { task: "TEST:grandchild", permission, context: "none" }),
						{ stopReason: "toolUse" },
					);
				if (childPhase === 2)
					return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: value!.run!.runId, timeoutMs: 1000 }), {
						stopReason: "toolUse",
					});
				expect(value?.run?.state).toBe("completed");
				return fauxAssistantMessage("child private marker");
			}
			if (task === "TEST:followup") {
				expect(context.messages.map(getMessageText).join("\n")).toContain("child private marker");
				return fauxAssistantMessage("continued same child");
			}
			expect(task).toBe("TEST:grandchild");
			return fauxAssistantMessage("grandchild completed");
		};
		harness.setResponses(Array.from({ length: 10 }, () => respond));
		await harness.session.prompt("TEST:root");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("root finished");
		expect(calls).toHaveLength(10);
		expect(calls.every((call) => call.pid === process.pid)).toBe(true);
		expect(coordinator.usage.created).toBe(2);
		expect(coordinator.usage.active).toBe(0);
		const runs = coordinator.listRuns(caller).items;
		expect(runs).toHaveLength(3);
		expect(runs.filter((run) => run.agentId === childAgentId)).toHaveLength(2);
		expect(runs.every((run) => run.state === "completed")).toBe(true);
	});
});
