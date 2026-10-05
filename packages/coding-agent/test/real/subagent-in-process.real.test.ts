import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { withSubagentToolPermission } from "../../src/core/subagents/permissions.ts";
import type { RootSubagentCoordinator } from "../../src/core/subagents/root-coordinator.ts";
import type { RootSubagentOptions } from "../../src/core/subagents/root-session.ts";
import { createSubagentTools } from "../../src/core/subagents/tools.ts";
import type { SubagentPermission } from "../../src/core/subagents/types.ts";

describe.skipIf(process.env.PI_SUBAGENT_REAL !== "1")("real provider in-process delegation", () => {
	it("delegates, continues, delivers mail, times out waits and interrupts a real child through the seven tools", async () => {
		const directory = resolve(
			"../../artifacts/subagent-implementation/real",
			new Date().toISOString().replace(/[:.]/g, "-"),
		);
		const workspace = join(directory, "workspace");
		const agentDir = join(directory, "agent");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const requestBudget = 44;
		const maxTokens = 1400;
		const timeLimitMs = 600_000;
		const thinkingLevel = "low";
		const requests: {
			startedAt: number;
			finishedAt?: number;
			pid: number;
			sessionId?: string;
			model: string;
			reasoning?: string;
			stopReason?: string;
			usage?: unknown;
		}[] = [];
		const transportErrors: string[] = [];
		let fetchAttempts = 0;
		let provider: string | undefined;
		let modelId: string | undefined;
		let root: AgentSession | undefined;
		let coordinator: RootSubagentCoordinator | undefined;
		let cleanupComplete = false;
		let status = "failed";
		let failureCode: string | undefined;
		const toolCalls: { name: string; at: number; result: string }[] = [];
		const gates = new Map<
			string,
			{
				entered: Promise<void>;
				enter: () => void;
				released: Promise<void>;
				release: () => void;
				enteredAt?: number;
				abortedAt?: number;
				stoppedAt?: number;
			}
		>();
		for (const mode of ["mail", "cancel"]) {
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			gates.set(mode, { entered, enter, released, release });
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeLimitMs);
		const originalFetch = globalThis.fetch.bind(globalThis);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (++fetchAttempts > requestBudget) throw new Error("real_request_budget_exhausted");
			try {
				return await originalFetch(input, init);
			} catch (error) {
				const cause = error instanceof Error ? error.cause : undefined;
				transportErrors.push(
					cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "fetch_failed",
				);
				throw error;
			}
		});
		let restoreStream: (() => void) | undefined;
		const controlWrites = { count: 0, totalMs: 0, maxMs: 0 };
		const appendControl = SessionManager.prototype.appendSubagentControl;
		const controlSpy = vi.spyOn(SessionManager.prototype, "appendSubagentControl").mockImplementation(function (
			this: SessionManager,
			event,
		) {
			const started = performance.now();
			try {
				return appendControl.call(this, event);
			} finally {
				const elapsed = performance.now() - started;
				controlWrites.count++;
				controlWrites.totalMs += elapsed;
				controlWrites.maxMs = Math.max(controlWrites.maxMs, elapsed);
			}
		});
		try {
			const configDir = process.env.PI_SUBAGENT_REAL_CONFIG_DIR ?? join(homedir(), ".pi", "agent");
			const config: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
			if (
				!config ||
				typeof config !== "object" ||
				!("defaultProvider" in config) ||
				!("defaultModel" in config) ||
				typeof config.defaultProvider !== "string" ||
				typeof config.defaultModel !== "string"
			)
				throw new Error("real_model_not_configured");
			provider = config.defaultProvider;
			modelId = "gpt-5.5";
			const stored: unknown = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"));
			const credentials = new InMemoryCredentialStore();
			if (stored && typeof stored === "object" && provider in stored) {
				const credential = (stored as Record<string, unknown>)[provider];
				if (
					!credential ||
					typeof credential !== "object" ||
					!("type" in credential) ||
					(credential.type !== "api_key" && credential.type !== "oauth")
				)
					throw new Error("real_credential_invalid");
				await credentials.modify(provider, async () => credential as Credential);
			}
			const modelRuntime = await ModelRuntime.create({
				credentials,
				modelsPath: join(configDir, "models.json"),
				modelsStore: new InMemoryCodingAgentModelsStore(),
				allowModelNetwork: false,
			});
			if (!modelRuntime.getModel(provider, modelId)) {
				const configured = modelRuntime.getModel(provider, config.defaultModel);
				if (!configured) throw new Error("real_provider_transport_not_configured");
				// Register the requested ID only in this test runtime, using this gateway's configured transport.
				modelRuntime.registerProvider(provider, {
					models: [{ ...configured, id: modelId, name: modelId, reasoning: true }],
				});
				await modelRuntime.refresh({ allowNetwork: false });
			}
			const model = modelRuntime.getModel(provider, modelId);
			if (!model) throw new Error("real_model_not_found");
			const stream = modelRuntime.streamSimple.bind(modelRuntime);
			const streamSpy = vi.spyOn(modelRuntime, "streamSimple").mockImplementation((selected, context, options) => {
				if (requests.length >= requestBudget || controller.signal.aborted)
					throw new Error("real_test_limit_reached");
				const request: (typeof requests)[number] = {
					startedAt: Date.now(),
					pid: process.pid,
					sessionId: options?.sessionId,
					model: selected.id,
					reasoning: options?.reasoning,
				};
				requests.push(request);
				const response = stream(selected, context, {
					...options,
					maxTokens,
					maxRetries: 0,
					timeoutMs: 90_000,
					transport: "sse",
				});
				void response.result().then(
					(reply) => {
						request.finishedAt = Date.now();
						request.stopReason = reply.stopReason;
						request.usage = reply.usage;
					},
					() => {},
				);
				return response;
			});
			restoreStream = () => streamSpy.mockRestore();
			const settings = SettingsManager.inMemory(
				{
					retry: { enabled: false },
					compaction: { enabled: false },
					memory: { enabled: false },
					permissions: { mode: "bypassPermissions" },
					transport: "sse",
				},
				{ projectTrusted: false },
			);
			async function resources(childSettings: SettingsManager) {
				const loader = new DefaultResourceLoader({
					cwd: workspace,
					agentDir,
					settingsManager: childSettings,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt:
						"You are a delegation integration-test agent. Execute the requested collaboration tool sequence. Use only synthetic task content. Keep each reply brief.",
				});
				await loader.reload();
				return loader;
			}
			const manager = SessionManager.create(workspace, join(directory, "sessions"));
			const permission: SubagentPermission = {
				mode: "read-only",
			};
			const childTools: RootSubagentOptions["tools"] = () => [
				withSubagentToolPermission<ToolDefinition>(
					{
						name: "controlled_wait",
						label: "Controlled wait",
						description:
							"Test host synchronization. Call once with the requested mode and wait for the host to release it.",
						parameters: Type.Object({ mode: Type.Union([Type.Literal("mail"), Type.Literal("cancel")]) }),
						async execute(_id, args, signal) {
							if (
								typeof args !== "object" ||
								args === null ||
								!("mode" in args) ||
								typeof args.mode !== "string" ||
								!signal
							)
								throw new Error("invalid_test_gate");
							const gate = gates.get(args.mode)!;
							if (gate.enteredAt) throw new Error("test_gate_already_used");
							gate.enteredAt = Date.now();
							gate.enter();
							const abort = () => {
								gate.abortedAt = Date.now();
								// Actual cleanup deliberately finishes after cancellation is accepted.
								setTimeout(gate.release, 75);
							};
							signal.addEventListener("abort", abort, { once: true });
							if (signal.aborted) abort();
							try {
								await gate.released;
							} finally {
								signal.removeEventListener("abort", abort);
								gate.stoppedAt = Date.now();
							}
							return {
								content: [
									{
										type: "text",
										text: signal.aborted
											? "cancelled and cleaned up"
											: "released; inspect your subagent mail",
									},
								],
								details: {},
							};
						},
					},
					"read-only",
				),
			];
			const tools: ToolDefinition[] = createSubagentTools(
				() => coordinator!,
				() => {
					return coordinator!.callerFor(root!.subagents!.scope.assertActive().runId);
				},
			).map((tool) =>
				withSubagentToolPermission<ToolDefinition>(
					{
						...tool,
						async execute(callId, input, signal, onUpdate, context) {
							if (tool.name === "send_message" || tool.name === "interrupt_agent") {
								const gate = gates.get(tool.name === "send_message" ? "mail" : "cancel")!;
								await new Promise<void>((resolve, reject) => {
									const abort = () => reject(new Error("real_gate_not_exercised"));
									if (controller.signal.aborted) abort();
									else controller.signal.addEventListener("abort", abort, { once: true });
									void gate.entered.then(() => {
										controller.signal.removeEventListener("abort", abort);
										resolve();
									});
								});
							}
							const result = await tool.execute(callId, input, signal, onUpdate, context);
							toolCalls.push({
								name: tool.name,
								at: Date.now(),
								result: result.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
							});
							if (tool.name === "send_message") gates.get("mail")!.release();
							return result;
						},
					},
					"read-only",
				),
			);
			async function openRoot(sessionManager: SessionManager) {
				const session = (
					await createAgentSession({
						cwd: workspace,
						agentDir,
						modelRuntime,
						model,
						thinkingLevel,
						settingsManager: settings,
						resourceLoader: await resources(settings),
						sessionManager,
						customTools: tools,
						tools: tools.map((tool) => tool.name),
						subagents: {
							permission: () => permission,
							recover: async () => {},
							resources: (_agent, ownSettings) => resources(ownSettings),
							tools: childTools,
						},
					})
				).session;
				await session.bindExtensions({});
				return session;
			}
			root = await openRoot(manager);
			coordinator = root.subagents!.coordinator;
			let rootStopping: Promise<void> | undefined;
			const abortRoot = () => {
				rootStopping ??= root!.dispose();
				void rootStopping.catch(() => {});
			};
			controller.signal.addEventListener("abort", abortRoot, { once: true });
			const marker = "copper-lantern-729";
			const childTask = `You are agent A. Remember marker ${marker}. Call spawn_agent exactly once to create YOUR DIRECT CHILD B with context="none", permission=${JSON.stringify(permission)}, and task exactly "Reply LEAF_OK. Do not call any tools or delegate." Wait for B's run to complete successfully, then reply A_READY. Do not delegate this instruction: YOU call spawn_agent; B only replies. Do not give B the marker.`;
			await root.prompt(`Perform this exact integration-test sequence using tools:
1. Call spawn_agent exactly once with context="none", permission=${JSON.stringify(permission)}, and task copied verbatim from this JSON string: ${JSON.stringify(childTask)}. This creates A; A directly creates B. There must be exactly two new agent identities in total.
2. wait_agent for A's run. If timedOut, continue waiting. A must complete successfully.
3. followup_task on the SAME agentId A, asking it to return the remembered marker. Do NOT repeat the marker in this followup task. Wait for that new run to complete.
4. Query list_agents and get_agent_info to verify the identities and completed runs. Finish with ROOT_OK and the marker returned by A. Never create additional agents. Do not simulate tool results.`);
			const outcome = root.agent.state.runState;
			const completed = outcome.status === "idle" && outcome.lastOutcome?.type === "completed";
			if (!completed) throw new Error("real_root_model_failed");
			const events = [...manager.readSubagentControl()].map((record) => record.control);
			const created = events.filter((event) => event.kind === "agent_created");
			const finished = events
				.filter((event) => event.kind === "run_finished")
				.filter((event) => event.run.agentId !== manager.getSessionId());
			expect(created).toHaveLength(2);
			expect(finished).toHaveLength(3);
			expect(finished.every((event) => event.run.state === "completed")).toBe(true);
			const parent = created.find((event) => event.agent.creatorAgentId === manager.getSessionId())!;
			expect(created.some((event) => event.agent.creatorAgentId === parent.agent.agentId)).toBe(true);
			const followup = finished.find(
				(event) => event.run.agentId === parent.agent.agentId && event.run.runId !== parent.run.runId,
			)!;
			expect(followup.run.task).not.toContain(marker);
			expect(followup.run.resultSummary).toContain(marker);
			expect(requests.every((request) => request.pid === process.pid)).toBe(true);
			expect(requests.every((request) => request.model === modelId && request.reasoning === thinkingLevel)).toBe(
				true,
			);
			expect(new Set(requests.map((request) => request.sessionId)).size).toBe(3);
			expect(fetchAttempts).toBeGreaterThanOrEqual(requests.length);
			await root.prompt(`Use only the existing agent A (${parent.agent.agentId}) for this test, in this exact order:
1. followup_task with task exactly: "Call controlled_wait once with mode=mail. After it returns, read the subagent message in your context and reply with its marker. Do not delegate."
2. wait_agent on that new run with timeoutMs=1. It must time out; this does not cancel the run.
3. send_message to A and that exact runId with message "Mailbox marker: amber-mail-384". Then wait_agent again with timeoutMs=30000 until that run completes. Check that its result contains amber-mail-384.
4. followup_task on A with task exactly: "Call controlled_wait once with mode=cancel and wait. Do not delegate."
5. interrupt_agent that new run with scope=subtree. Then wait_agent with condition=subtree_stopped and timeoutMs=30000 until actual cleanup finishes.
6. Only after subtreeStopped is true, followup_task on A with task "Reply RESUMED_OK. Do not call any tools." Wait for that run to complete.
7. get_agent_info with section=updates, paging if needed. Finish with CONTROL_OK. Never create another agent.`);
			const controlOutcome = root.agent.state.runState;
			const controlCompleted = controlOutcome.status === "idle" && controlOutcome.lastOutcome?.type === "completed";
			if (!controlCompleted) throw new Error("real_control_model_failed");
			const controlEvents = [...manager.readSubagentControl()].map((record) => record.control);
			const childResults = controlEvents
				.filter((event) => event.kind === "run_finished")
				.filter((event) => event.run.agentId !== manager.getSessionId());
			expect(controlEvents.filter((event) => event.kind === "agent_created")).toHaveLength(2);
			expect(childResults).toHaveLength(6);
			const cancelled = childResults.find((event) => event.run.state === "cancelled")!;
			expect(cancelled).toBeDefined();
			expect(gates.get("cancel")!.abortedAt).toBeDefined();
			expect(cancelled.run.finishedAt).toBeGreaterThanOrEqual(gates.get("cancel")!.stoppedAt!);
			const resumed = childResults.find((event) => event.run.resultSummary?.includes("RESUMED_OK"))!;
			expect(resumed.run.createdAt).toBeGreaterThanOrEqual(cancelled.run.finishedAt!);
			expect(childResults.some((event) => event.run.resultSummary?.includes("amber-mail-384"))).toBe(true);
			expect(controlEvents.some((event) => event.kind === "wait_timed_out")).toBe(true);
			expect(controlEvents.some((event) => event.kind === "mail" && event.mail.state === "delivered")).toBe(true);
			expect(
				toolCalls.some((call) => call.name === "interrupt_agent" && JSON.parse(call.result).stopped === false),
			).toBe(true);
			expect(requests.every((request) => request.model === "gpt-5.5" && request.reasoning === "low")).toBe(true);
			const sessionFile = root.sessionFile!;
			await root.dispose();
			const beforeReopen = requests.length;
			const reopenedManager = SessionManager.open(sessionFile);
			root = await openRoot(reopenedManager);
			coordinator = root.subagents!.coordinator;
			expect(requests).toHaveLength(beforeReopen);
			expect(coordinator.usage.created).toBe(2);
			await root.prompt(
				`This root session was closed and reopened. Use only existing A (${parent.agent.agentId}). Call get_agent_info with runId=${followup.run.runId} to inspect its saved successful result. Then followup_task on A asking it to return the remembered original marker without giving it the marker. Wait for the NEW run to complete and report REOPEN_OK with the returned marker. Never create a new agent.`,
			);
			const reopenedEvents = [...reopenedManager.readSubagentControl()].map((record) => record.control);
			const reopenedResults = reopenedEvents
				.filter((event) => event.kind === "run_finished")
				.filter((event) => event.run.agentId === parent.agent.agentId);
			expect(reopenedResults.at(-1)?.run.resultSummary).toContain(marker);
			expect(reopenedResults.at(-1)?.run.runId).not.toBe(followup.run.runId);
			expect(coordinator.usage.created).toBe(2);
			expect(requests.every((request) => request.model === "gpt-5.5" && request.reasoning === "low")).toBe(true);
			expect(new Set(requests.map((request) => request.sessionId)).size).toBe(3);
			controller.signal.removeEventListener("abort", abortRoot);
			await rootStopping;
			writeFileSync(
				join(directory, "runs.json"),
				JSON.stringify(
					{ created, finished: reopenedEvents.filter((event) => event.kind === "run_finished"), beforeReopen },
					null,
					2,
				),
			);
			status = "passed";
		} catch (error) {
			failureCode = error instanceof Error ? error.name : "UnknownError";
			throw error;
		} finally {
			clearTimeout(timer);
			try {
				await root?.dispose();
				await coordinator?.close();
				cleanupComplete = true;
			} finally {
				restoreStream?.();
				controlSpy.mockRestore();
				fetchSpy.mockRestore();
				writeFileSync(
					join(directory, "report.json"),
					JSON.stringify(
						{
							status: cleanupComplete ? status : "cleanup_failed",
							failureCode,
							provider,
							model: modelId,
							thinkingLevel,
							requestBudget,
							maxTokens,
							timeLimitMs,
							requests,
							controlWrites,
							fetchAttempts,
							transportErrors,
							toolCalls,
							gates: [...gates].map(([mode, gate]) => ({
								mode,
								enteredAt: gate.enteredAt,
								abortedAt: gate.abortedAt,
								stoppedAt: gate.stoppedAt,
							})),
							cleanupComplete,
							scope: "SDK root prompt/dispose/reopen; nested same-process delegation, explicit followup, wait timeout, safe-point mail and cooperative tracked-tool interruption. Capability and default-entry checks are separate; no OS isolation or arbitrary process-tree stop guarantee.",
						},
						null,
						2,
					),
				);
			}
		}
	}, 630_000);
});
