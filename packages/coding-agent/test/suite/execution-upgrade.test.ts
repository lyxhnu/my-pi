import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("agent-owned execution upgrades", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function setup(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({
			models: [
				{ id: "small", reasoning: true },
				{ id: "large", reasoning: true },
			],
			settings: {
				executionUpgrade: { enabled: true, modelOrder: ["faux/small", "faux/large"] },
				compaction: { enabled: false },
				retry: { enabled: false },
			},
			initialActiveToolNames: ["upgrade_execution"],
			...options,
		});
		harnesses.push(harness);
		return harness;
	}

	function upgrade(targetModel = "faux/large", thinkingLevel = "high", id?: string) {
		return fauxToolCall(
			"upgrade_execution",
			{ targetModel, thinkingLevel, reason: "Need deeper reasoning to resolve the remaining constraints." },
			{ id },
		);
	}

	it("voluntarily upgrades before any reminder and sends the exact target profile", async () => {
		const modelEvents: string[] = [];
		const thinkingEvents: string[] = [];
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => {
						modelEvents.push(`${event.source}:${event.model.id}`);
					});
					pi.on("thinking_level_select", (event) => {
						thinkingEvents.push(event.level);
					});
				},
			],
		});
		const requested: Array<{ model: string; reasoning: unknown }> = [];
		const stream = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			requested.push({ model: model.id, reasoning: options?.reasoning });
			return stream(model, context, options);
		};
		h.setResponses([
			fauxAssistantMessage(upgrade(), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain('"status":"applied"');
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("Solve the task");
		expect(requested).toEqual([
			{ model: "small", reasoning: undefined },
			{ model: "large", reasoning: "high" },
		]);
		expect(h.eventsOfType("execution_upgrade").map((event) => event.outcome.status)).toEqual(["pending", "applied"]);
		expect(h.sessionManager.buildSessionContext()).toMatchObject({
			model: { modelId: "large" },
			thinkingLevel: "high",
		});
		expect(h.settingsManager.getDefaultModel()).toBeUndefined();
		expect(h.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
		expect(modelEvents).toContain("upgrade:large");
		expect(thinkingEvents).toContain("high");
		const trace = h.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "trace" && entry.event.type === "request/header" ? [entry.event.data.header] : [],
			);
		expect(trace.map(({ model, reasoning }) => ({ model, reasoning }))).toEqual(requested);
		h.setResponses([fauxAssistantMessage("second task done")]);
		await h.session.prompt("Next task");
		expect(requested.at(-1)).toEqual({ model: "large", reasoning: "high" });
		expect(h.session.getExecutionUpgradeState().metrics.rounds).toBe(1);
	});

	it("can raise thinking without changing model", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(upgrade("faux/small", "medium"), { stopReason: "toolUse" }),
			(_context, options, _state, model) => {
				expect(model.id).toBe("small");
				expect((options as SimpleStreamOptions).reasoning).toBe("medium");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("work");
		expect(h.session.thinkingLevel).toBe("medium");
	});

	it("rejects a target removed by the account's model filter before commit", async () => {
		const h = await setup();
		const runtime = h.session.modelRuntime;
		const provider = runtime.getProvider("faux");
		if (!provider) throw new Error("Missing faux provider");
		let allowLarge = true;
		runtime.registerNativeProvider({
			...provider,
			filterModels: (models) => models.filter((model) => allowLarge || model.id !== "large"),
		});
		await runtime.getAvailable();
		h.session.subscribe((event) => {
			if (event.type === "execution_upgrade" && event.outcome.status === "pending") allowLarge = false;
		});
		h.setResponses([fauxAssistantMessage(upgrade(), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await h.session.prompt("work");
		expect(h.eventsOfType("execution_upgrade").at(-1)?.outcome.status).toBe("rejected");
		expect(h.session.model?.id).toBe("small");
	});

	it("does not repeat an upgrade when the upgraded request is retried", async () => {
		const h = await setup({
			settings: {
				executionUpgrade: { enabled: true, modelOrder: ["faux/small", "faux/large"] },
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
		});
		h.setResponses([
			fauxAssistantMessage(upgrade(), { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("work");
		expect(h.eventsOfType("execution_upgrade").map((event) => event.outcome.status)).toEqual(["pending", "applied"]);
		expect(h.session.getExecutionUpgradeState().metrics.rounds).toBe(2);
		expect(h.session.model?.id).toBe("large");
	});

	it("keeps an excluded upgrade tool unavailable", async () => {
		const h = await setup({ initialActiveToolNames: undefined, excludedToolNames: ["upgrade_execution"] });
		expect(h.session.getActiveToolNames()).not.toContain("upgrade_execution");
		h.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).not.toContain(
					"Execution status (runtime observations",
				);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("work");
	});

	it("reminds after repeated errors but never upgrades without an explicit tool call", async () => {
		const failing: AgentTool = {
			name: "probe",
			label: "probe",
			description: "probe",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("same failure");
			},
		};
		const h = await setup({
			tools: [failing],
			initialActiveToolNames: ["probe", "upgrade_execution"],
			settings: {
				executionUpgrade: {
					enabled: true,
					reminderRounds: 8,
					reminderToolCalls: 24,
					reminderRepeatedErrors: 3,
					reminderCooldownRounds: 1,
				},
				compaction: { enabled: false },
			},
		});
		h.setResponses([
			...Array.from({ length: 3 }, () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })),
			(context, _options, _state, model) => {
				expect(model.id).toBe("small");
				const status = getMessageText(context.messages.at(-1));
				expect(status).toContain('"repeatedErrors":3');
				expect(status).toContain("Review whether your current approach");
				return fauxAssistantMessage("Environment failed; no upgrade needed.");
			},
		]);
		await h.session.prompt("inspect");
		expect(h.eventsOfType("execution_upgrade")).toEqual([]);
		expect(h.faux.state.callCount).toBe(4);
		expect(h.session.getExecutionUpgradeState().metrics).toMatchObject({ rounds: 4, toolCalls: 3, toolErrors: 3 });
	});

	it("finishes the complete tool batch exactly once before applying an upgrade", async () => {
		let effects = 0;
		let h: Harness;
		const tool: AgentTool = {
			name: "effect",
			label: "effect",
			description: "effect",
			parameters: Type.Object({}),
			execute: async () => {
				expect(h.session.model?.id).toBe("small");
				effects++;
				return { content: [{ type: "text", text: "completed effect" }], details: {} };
			},
		};
		h = await setup({ tools: [tool], initialActiveToolNames: ["effect", "upgrade_execution"] });
		h.setResponses([
			fauxAssistantMessage([upgrade(), fauxToolCall("effect", {})], { stopReason: "toolUse" }),
			(context, _options, _state, model) => {
				expect(effects).toBe(1);
				expect(model.id).toBe("large");
				expect(context.messages.some((message) => getMessageText(message).includes("completed effect"))).toBe(true);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("work");
		expect(effects).toBe(1);
	});

	it.each(["manual", "abort"] as const)("invalidates a pending upgrade on %s", async (action) => {
		const h = await setup();
		h.session.subscribe((event) => {
			if (event.type === "execution_upgrade" && event.outcome.status === "pending") {
				if (action === "manual") h.session.setThinkingLevel("low");
				else h.session.agent.abort();
			}
		});
		h.setResponses([fauxAssistantMessage(upgrade(), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await h.session.prompt("work");
		expect(h.session.model?.id).toBe("small");
		expect(h.eventsOfType("execution_upgrade").some((event) => event.outcome.status === "applied")).toBe(false);
		expect(h.eventsOfType("execution_upgrade").at(-1)?.outcome.status).toBe("cancelled");
	});

	it.each([
		{ target: "faux/small", thinking: "off" },
		{ target: "faux/large", thinking: "max" },
		{ target: "faux/unknown", thinking: "high" },
	])("rejects invalid target $target / $thinking without changing state", async ({ target, thinking }) => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(upgrade(target, thinking), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("work");
		expect(h.session.model?.id).toBe("small");
		expect(h.session.thinkingLevel).toBe("off");
		expect(h.eventsOfType("execution_upgrade").at(-1)?.outcome.status).toBe("rejected");
	});

	it("rejects conflicting same-batch targets and merges identical targets", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage([upgrade("faux/small", "medium"), upgrade()], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("work");
		expect(h.eventsOfType("execution_upgrade").filter((event) => event.outcome.status === "rejected")).toHaveLength(
			2,
		);
		h.setResponses([
			fauxAssistantMessage([upgrade(), upgrade()], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("try one target");
		const applied = h.eventsOfType("execution_upgrade").filter((event) => event.outcome.status === "applied");
		expect(applied).toHaveLength(1);
		expect(applied[0].outcome.callIds).toHaveLength(2);
	});

	it("includes steering in the candidate budget and rejects a target that cannot fit", async () => {
		let transforms = 0;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("context", () => {
						transforms++;
					});
				},
			],
			models: [
				{ id: "small", reasoning: true },
				{ id: "large", reasoning: true, contextWindow: 3000, maxTokens: 128 },
			],
		});
		h.session.subscribe((event) => {
			if (event.type === "execution_upgrade" && event.outcome.status === "pending")
				void h.session.steer(`Additional requirements: ${"detail ".repeat(7000)}`);
		});
		h.setResponses([
			fauxAssistantMessage(upgrade(), { stopReason: "toolUse" }),
			(context, _options, _state, model) => {
				expect(model.id).toBe("small");
				expect(
					context.messages.some((message) => getMessageText(message).startsWith("Additional requirements")),
				).toBe(true);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("work");
		expect(transforms).toBe(h.faux.state.callCount);
		expect(h.eventsOfType("execution_upgrade").at(-1)?.outcome).toMatchObject({
			status: "rejected",
			message: expect.stringContaining("context"),
		});
	});

	it("does not turn an extension-rejected tool result into an upgrade", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) =>
						event.toolName === "upgrade_execution"
							? { isError: true, content: [{ type: "text", text: "rejected by extension" }] }
							: undefined,
					);
				},
			],
		});
		h.setResponses([fauxAssistantMessage(upgrade(), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await h.session.prompt("work");
		expect(h.eventsOfType("execution_upgrade")).toEqual([]);
		expect(h.session.model?.id).toBe("small");
	});

	it("lets a persistent child upgrade its own model and trace without changing its parent", async () => {
		const h = await setup();
		const { session: root } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			model: h.getModel(),
			thinkingLevel: "medium",
			settingsManager: h.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.create(h.tempDir, join(h.tempDir, "managed")),
			tools: ["spawn_agent", "wait_agent", "upgrade_execution"],
		});
		try {
			h.setResponses([
				(_context, options, _state, model) => {
					expect(model.id).toBe("small");
					expect((options as SimpleStreamOptions).reasoning).toBe("medium");
					return fauxAssistantMessage(upgrade(), { stopReason: "toolUse" });
				},
				(_context, options, _state, model) => {
					expect(model.id).toBe("large");
					expect((options as SimpleStreamOptions).reasoning).toBe("high");
					return fauxAssistantMessage("analyzed");
				},
			]);
			await root.subagents!.run(async () => {
				const host = root.subagents!,
					caller = host.coordinator.callerFor(host.scope.assertActive().runId);
				const run = await host.coordinator.spawn(
					caller,
					{ task: "analyze", context: "none", permission: { mode: "read-only" } },
					"analysis",
				);
				expect((await host.coordinator.wait(caller, run.runId, { timeoutMs: 3000 })).run.state).toBe("completed");
				const child = host.factory.getSession(run.agentId)!;
				expect(child.model?.id).toBe("large");
				expect(child.thinkingLevel).toBe("high");
				const headers = child.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "trace" && entry.event.type === "request/header" ? [entry.event.data.header] : [],
					);
				expect(headers.map((header) => [header.model, header.reasoning])).toEqual([
					["small", "medium"],
					["large", "high"],
				]);
			});
			expect(root.model?.id).toBe("small");
			expect(root.thinkingLevel).toBe("medium");
		} finally {
			await root.dispose();
		}
	});
});
