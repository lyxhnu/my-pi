import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { withSubagentToolPermission } from "../../src/core/subagents/permissions.ts";
import type { RootSubagentOptions } from "../../src/core/subagents/root-session.ts";
import type { SubagentPermissionMode } from "../../src/core/subagents/types.ts";

export function messageText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function rootToolResults(session: AgentSession, name: string) {
	return session.messages.filter((message) => message.role === "toolResult" && message.toolName === name);
}

export function controlEvents(session: AgentSession) {
	return [...session.sessionManager.readSubagentControl()].map((entry) => entry.control);
}

export function identities(session: AgentSession) {
	return controlEvents(session).filter((event) => event.kind === "agent_created");
}

export function finishedRuns(session: AgentSession) {
	return controlEvents(session)
		.filter((event) => event.kind === "run_finished")
		.map((event) => event.run);
}

export interface RealGate {
	entered: Promise<void>;
	release: (text?: string) => void;
	enteredAt?: number;
	abortedAt?: number;
	stoppedAt?: number;
}

interface RealRequest {
	at: number;
	pid: number;
	sessionId?: string;
	model: string;
	reasoning?: string;
	tools: string[];
	stopReason?: string;
	finishedAt?: number;
}

export interface RealSubagentFixture {
	root: AgentSession;
	directory: string;
	workspace: string;
	requests: RealRequest[];
	permission: { mode: SubagentPermissionMode };
	gates: Map<string, RealGate>;
	prompt: (text: string) => Promise<void>;
	reopen: () => Promise<void>;
}

/** Opt-in, synthetic workspaces only. This never changes the user's provider defaults. */
export async function realSubagentScenario(
	name: string,
	options: { gates?: string[]; requestBudget?: number },
	work: (fixture: RealSubagentFixture) => Promise<void>,
): Promise<void> {
	const directory = resolve(
		"../../artifacts/subagent-acceptance",
		`${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`,
	);
	const workspace = join(directory, "workspace"),
		agentDir = join(directory, "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const requestBudget = options.requestBudget ?? 70;
	const requests: RealRequest[] = [];
	const permission = { mode: "full" as SubagentPermissionMode };
	const gates = new Map<string, RealGate>();
	const gateWaits = new Map<string, Promise<string>>();
	const gateEnters = new Map<string, () => void>();
	for (const label of options.gates ?? []) {
		let enter!: () => void;
		let release!: (text: string) => void;
		const entered = new Promise<void>((done) => {
			enter = done;
		});
		gateWaits.set(
			label,
			new Promise<string>((done) => {
				release = done;
			}),
		);
		gateEnters.set(label, enter);
		gates.set(label, { entered, release: (text = "released") => release(text) });
	}
	const controller = new AbortController();
	let root: AgentSession | undefined;
	let fixture: RealSubagentFixture | undefined;
	let status = "failed",
		cleanupComplete = false,
		fetches = 0;
	let failure: string | undefined;
	let restore: (() => void) | undefined;
	const timer = setTimeout(() => {
		controller.abort();
		for (const gate of gates.values()) gate.release("test deadline");
		void fixture?.root.dispose().catch(() => {});
	}, 600_000);
	const originalFetch = globalThis.fetch.bind(globalThis);
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		if (++fetches > requestBudget || controller.signal.aborted) throw new Error("real_request_budget_exhausted");
		return originalFetch(input, init);
	});
	try {
		const configDir = process.env.PI_SUBAGENT_REAL_CONFIG_DIR ?? join(homedir(), ".pi", "agent");
		const config: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
		if (
			!config ||
			typeof config !== "object" ||
			!("defaultProvider" in config) ||
			typeof config.defaultProvider !== "string" ||
			!("defaultModel" in config) ||
			typeof config.defaultModel !== "string"
		)
			throw new Error("real_model_not_configured");
		const provider = config.defaultProvider;
		const auth: unknown = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"));
		const credentials = new InMemoryCredentialStore();
		if (auth && typeof auth === "object" && provider in auth) {
			const credential = (auth as Record<string, unknown>)[provider];
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
		if (!modelRuntime.getModel(provider, "gpt-5.5")) {
			const configured = modelRuntime.getModel(provider, config.defaultModel);
			if (!configured) throw new Error("real_transport_not_configured");
			modelRuntime.registerProvider(provider, {
				models: [{ ...configured, id: "gpt-5.5", name: "gpt-5.5", reasoning: true }],
			});
			await modelRuntime.refresh({ allowNetwork: false });
		}
		const model = modelRuntime.getModel(provider, "gpt-5.5");
		if (!model) throw new Error("real_model_not_found");
		const stream = modelRuntime.streamSimple.bind(modelRuntime);
		const spy = vi.spyOn(modelRuntime, "streamSimple").mockImplementation((selected, context, settings) => {
			if (controller.signal.aborted || requests.length >= requestBudget) throw new Error("real_test_limit");
			const request: RealRequest = {
				at: Date.now(),
				pid: process.pid,
				sessionId: settings?.sessionId,
				model: selected.id,
				reasoning: settings?.reasoning,
				tools: context.tools?.map((tool) => tool.name) ?? [],
			};
			requests.push(request);
			const response = stream(selected, context, {
				...settings,
				maxTokens: 1800,
				maxRetries: 0,
				timeoutMs: 90_000,
				transport: "sse",
			});
			void response.result().then(
				(result) => {
					request.stopReason = result.stopReason;
					request.finishedAt = Date.now();
				},
				() => {},
			);
			return response;
		});
		restore = () => spy.mockRestore();
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
		async function resources(ownSettings: SettingsManager) {
			const loader = new DefaultResourceLoader({
				cwd: workspace,
				agentDir,
				settingsManager: ownSettings,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt:
					"You are running an authorized integration test in a synthetic workspace. Execute the requested tool sequence exactly. All agents use gpt-5.5 low. Keep replies brief. Do not invent tool results, substitute tasks, or delegate unless instructed. Tool errors requested by the test are expected; report them and continue the specified steps.",
			});
			await loader.reload();
			return loader;
		}
		const childTools: RootSubagentOptions["tools"] = options.gates
			? () => [
					withSubagentToolPermission<ToolDefinition>(
						{
							name: "test_gate",
							label: "Test gate",
							description:
								"Call with the exact label in your task. Wait for the test host; after return follow the returned test instruction.",
							parameters: Type.Object({ label: Type.String() }),
							async execute(_id, args, signal) {
								if (
									!args ||
									typeof args !== "object" ||
									!("label" in args) ||
									typeof args.label !== "string" ||
									!signal
								)
									throw new Error("invalid_gate");
								const gate = gates.get(args.label);
								if (!gate || gate.enteredAt) throw new Error("gate_missing_or_reused");
								gate.enteredAt = Date.now();
								gateEnters.get(args.label)!();
								const abort = () => {
									gate.abortedAt = Date.now();
									setTimeout(() => gate.release("cancelled"), 150);
								};
								signal.addEventListener("abort", abort, { once: true });
								if (signal.aborted) abort();
								try {
									return { content: [{ type: "text", text: await gateWaits.get(args.label)! }], details: {} };
								} finally {
									signal.removeEventListener("abort", abort);
									gate.stoppedAt = Date.now();
								}
							},
						},
						"read-only",
					),
				]
			: undefined;
		async function open(manager: SessionManager) {
			const session = (
				await createAgentSession({
					cwd: workspace,
					agentDir,
					modelRuntime,
					model,
					thinkingLevel: "low",
					settingsManager: settings,
					resourceLoader: await resources(settings),
					sessionManager: manager,
					subagents: {
						permission: () => permission,
						...(childTools
							? { tools: childTools, resources: (_agent, ownSettings) => resources(ownSettings) }
							: {}),
					},
				})
			).session;
			await session.bindExtensions({});
			return session;
		}
		root = await open(SessionManager.create(workspace, join(directory, "sessions")));
		fixture = {
			root,
			directory,
			workspace,
			requests,
			permission,
			gates,
			async prompt(text) {
				await fixture!.root.prompt(text);
				const state = fixture!.root.agent.state.runState;
				expect(
					state.status === "idle" && state.lastOutcome?.type === "completed",
					`root prompt failed: ${text.slice(0, 100)}`,
				).toBe(true);
			},
			async reopen() {
				const file = fixture!.root.sessionFile!;
				await fixture!.root.dispose();
				const before = requests.length;
				fixture!.root = await open(SessionManager.open(file));
				expect(requests).toHaveLength(before);
			},
		};
		await work(fixture);
		expect(requests.length).toBeGreaterThan(0);
		expect(
			requests.every(
				(request) => request.model === "gpt-5.5" && request.reasoning === "low" && request.pid === process.pid,
			),
		).toBe(true);
		status = "passed";
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		clearTimeout(timer);
		try {
			const active = fixture?.root ?? root;
			const closing = active?.dispose();
			for (const gate of gates.values()) gate.release("test cleanup");
			await closing;
			cleanupComplete = true;
			if (active?.sessionFile) {
				const records: unknown[] = readFileSync(active.sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				writeFileSync(
					join(directory, "control.json"),
					JSON.stringify(
						records.filter(
							(record) =>
								record && typeof record === "object" && "type" in record && record.type === "subagent_control",
						),
						null,
						2,
					),
				);
			}
		} finally {
			restore?.();
			fetchSpy.mockRestore();
			writeFileSync(
				join(directory, "report.json"),
				JSON.stringify(
					{
						name,
						status,
						failure,
						cleanupComplete,
						requestBudget,
						maxTokens: 1800,
						timeLimitMs: 600_000,
						requests,
						fetches,
						gates: [...gates].map(([label, gate]) => ({
							label,
							enteredAt: gate.enteredAt,
							abortedAt: gate.abortedAt,
							stoppedAt: gate.stoppedAt,
						})),
					},
					null,
					2,
				),
			);
		}
	}
}
