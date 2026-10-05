import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SubagentPermissionMode } from "../../src/core/subagents/types.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(options: Partial<CreateAgentSessionOptions> = {}) {
	const h = await createHarness({
		settings: {
			retry: { enabled: false },
			compaction: { enabled: false },
			permissions: { mode: "bypassPermissions" },
		},
	});
	cleanups.push(h.cleanup);
	const settings: CreateAgentSessionOptions = {
		cwd: h.tempDir,
		agentDir: h.tempDir,
		model: h.getModel(),
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		thinkingLevel: "off",
		resourceLoader: createTestResourceLoader(),
		sessionManager: SessionManager.create(h.tempDir, join(h.tempDir, "managed")),
		...options,
	};
	const root = (await createAgentSession(settings)).session;
	cleanups.push(() => root.dispose());
	return { h, root, settings };
}

describe("default SDK entry and actual subagent capabilities", () => {
	it.each(["switch", "import"].flatMap((entry) => [false, true].map((alias) => ({ entry, alias }))))(
		"keeps the current owned root usable through $entry (path alias: $alias)",
		async ({ entry, alias }) => {
			const { h, root } = await fixture();
			let recreated = 0;
			const runtime = new AgentSessionRuntime(
				root,
				{
					cwd: h.tempDir,
					agentDir: h.tempDir,
					settingsManager: h.settingsManager,
					modelRuntime: root.modelRuntime,
					resourceLoader: root.resourceLoader,
					diagnostics: [],
				},
				async () => {
					recreated++;
					throw new Error("current_session_must_not_be_recreated");
				},
			);
			cleanups.push(() => runtime.dispose());
			const file = alias && process.platform === "win32" ? root.sessionFile!.toUpperCase() : root.sessionFile!;
			const result = entry === "switch" ? await runtime.switchSession(file) : await runtime.importFromJsonl(file);
			expect(result.cancelled).toBe(false);
			expect(runtime.session).toBe(root);
			expect(root.subagents!.coordinator.phase).toBe("open");
			expect(recreated).toBe(0);
			h.setResponses([fauxAssistantMessage("still usable")]);
			await runtime.session.prompt("continue after selecting current session");
			expect(getMessageText(root.messages.at(-1))).toBe("still usable");
		},
	);
	it.each(["switch", "import"])("releases the current owner before changing its cwd through %s", async (entry) => {
		const { h, root, settings } = await fixture();
		const destination = join(h.tempDir, "changed-cwd");
		mkdirSync(destination);
		const services = {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			settingsManager: h.settingsManager,
			modelRuntime: root.modelRuntime,
			resourceLoader: root.resourceLoader,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(root, services, async ({ cwd, sessionManager }) => ({
			...(await createAgentSession({ ...settings, cwd, sessionManager })),
			services: { ...services, cwd },
			diagnostics: [],
		}));
		cleanups.push(() => runtime.dispose());
		const file = root.sessionFile!;
		const result =
			entry === "switch"
				? await runtime.switchSession(file, { cwdOverride: destination })
				: await runtime.importFromJsonl(file, destination);
		expect(result.cancelled).toBe(false);
		expect(runtime.session).not.toBe(root);
		expect(runtime.session.sessionId).toBe(root.sessionId);
		expect(runtime.cwd).toBe(destination);
		expect(root.subagents!.coordinator.phase).toBe("closed");
		expect(runtime.session.subagents!.coordinator.phase).toBe("open");
		h.setResponses([fauxAssistantMessage("new cwd usable")]);
		await runtime.session.prompt("continue in new cwd");
		expect(getMessageText(runtime.session.messages.at(-1))).toBe("new cwd usable");
	});
	it.each(["switch", "import"])(
		"releases a rejected destination owner and keeps the current root through %s",
		async (entry) => {
			const { h, root, settings } = await fixture();
			const other = (
				await createAgentSession({
					...settings,
					sessionManager: SessionManager.create(h.tempDir, root.sessionManager.getSessionDir()),
				})
			).session;
			const file = other.sessionFile!;
			await other.dispose();
			const runtime = new AgentSessionRuntime(
				root,
				{
					cwd: h.tempDir,
					agentDir: h.tempDir,
					settingsManager: h.settingsManager,
					modelRuntime: root.modelRuntime,
					resourceLoader: root.resourceLoader,
					diagnostics: [],
				},
				async () => {
					throw new Error("invalid_cwd_must_not_recreate_runtime");
				},
			);
			cleanups.push(() => runtime.dispose());
			const invalidCwd = join(h.tempDir, "missing");
			await expect(
				entry === "switch"
					? runtime.switchSession(file, { cwdOverride: invalidCwd })
					: runtime.importFromJsonl(file, invalidCwd),
			).rejects.toThrow("working directory");
			expect(runtime.session).toBe(root);
			expect(root.subagents!.coordinator.phase).toBe("open");
			const reopened = SessionManager.open(file);
			reopened.closeOwnership();
		},
	);
	it.each([undefined, "builtin", "all"] as const)("respects default tool suppression (%s)", async (noTools) => {
		const { root } = await fixture({ noTools });
		expect(root.subagents).toBeDefined();
		expect(root.getAllTools().map((tool) => tool.name)).not.toContain("task");
		expect(root.getActiveToolNames().includes("spawn_agent")).toBe(noTools === undefined);
	});
	it.each(["read-only", "read-write", "full"] as const)("executes only the tools permitted by %s", async (mode) => {
		const { h, root } = await fixture();
		writeFileSync(join(h.tempDir, "input.txt"), "private-input-481");
		let childPhase = 0,
			rootPhase = 0;
		const errors: boolean[] = [];
		const names: string[][] = [];
		const router: FauxResponseFactory = (context) => {
			const child = context.messages.some(
				(message) => message.role === "user" && getMessageText(message) === "CHILD",
			);
			if (!child) {
				if (++rootPhase === 1)
					return fauxAssistantMessage(
						fauxToolCall("spawn_agent", { task: "CHILD", permission: { mode }, context: "none" }),
						{ stopReason: "toolUse" },
					);
				if (rootPhase === 2) {
					const result = JSON.parse(
						getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)),
					);
					return fauxAssistantMessage(fauxToolCall("wait_agent", { runId: result.run.runId, timeoutMs: 2000 }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("root done");
			}
			names.push(context.tools?.map((tool) => tool.name) ?? []);
			const result = context.messages.filter((m) => m.role === "toolResult").at(-1);
			if (result?.role === "toolResult") errors.push(result.isError === true);
			if (++childPhase === 1)
				return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" });
			if (childPhase === 2) {
				expect(getMessageText(result)).toContain("private-input-481");
				return fauxAssistantMessage(fauxToolCall("write", { path: "output.txt", content: mode }), {
					stopReason: "toolUse",
				});
			}
			if (childPhase === 3)
				return fauxAssistantMessage(fauxToolCall("bash", { command: "echo subagent-command-351", timeout: 5000 }), {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage("child done");
		};
		h.setResponses(Array.from({ length: 7 }, () => router));
		await root.prompt("ROOT");
		expect(errors).toEqual([false, mode === "read-only", mode !== "full"]);
		expect(names.every((names) => names.includes("bash") === (mode === "full"))).toBe(true);
		expect(existsSync(join(h.tempDir, "output.txt"))).toBe(mode !== "read-only");
		if (mode !== "read-only") expect(readFileSync(join(h.tempDir, "output.txt"), "utf8")).toBe(mode);
		const child = [...root.sessionManager.readSubagentControl()].find(
			(r) => r.control.kind === "run_finished" && r.control.run.agentId !== root.sessionId,
		)!;
		expect(child.control.kind === "run_finished" && child.control.run.effectsUnknown === true).toBe(mode === "full");
	});
	it("checks a tightened root ceiling again at execution and rejects a custom read-name override", async () => {
		let mode: SubagentPermissionMode = "full";
		let calls = 0;
		const { h, root } = await fixture({
			subagents: { permission: () => ({ mode }), resources: async () => createTestResourceLoader() },
			customTools: [
				{
					name: "read",
					label: "read",
					description: "custom external command",
					parameters: Type.Object({}),
					async execute() {
						calls++;
						return { content: [{ type: "text", text: "executed" }], details: {} };
					},
				},
			],
		});
		h.setResponses([
			() => {
				mode = "read-only";
				return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await root.prompt("tighten before execution");
		expect(calls).toBe(0);
		expect(getMessageText(root.messages.filter((m) => m.role === "toolResult").at(-1))).toContain(
			"tool_permission_denied",
		);
	});
	it("keeps effectsUnknown through completion and a later read-only followup cannot reuse a full tool", async () => {
		let invoked = 0;
		const { h, root } = await fixture({
			subagents: {
				resources: async () => createTestResourceLoader(),
				tools: () => [
					{
						name: "external",
						label: "external",
						description: "external effect",
						parameters: Type.Object({}),
						async execute() {
							invoked++;
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					},
				],
			},
		});
		await root.subagents!.run(async () => {
			const host = root.subagents!,
				caller = host.coordinator.callerFor(host.scope.assertActive().runId);
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("external", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("first"),
			]);
			const first = await host.coordinator.spawn(
				caller,
				{ task: "first", context: "none", permission: { mode: "full" } },
				"one",
			);
			expect((await host.coordinator.wait(caller, first.runId, { timeoutMs: 2000 })).run.effectsUnknown).toBe(true);
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("external", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("second"),
			]);
			const next = host.coordinator.followup(
				caller,
				{ agentId: first.agentId, task: "second", permission: { mode: "read-only" } },
				"two",
			);
			await host.coordinator.wait(caller, next.runId, { timeoutMs: 2000 });
			expect(invoked).toBe(1);
		});
	});
	it("opens a fresh managed root when the runtime creates or forks a session", async () => {
		const { h, root, settings } = await fixture();
		h.setResponses([fauxAssistantMessage("before fork")]);
		await root.prompt("first");
		const runtime = new AgentSessionRuntime(
			root,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				settingsManager: h.settingsManager,
				modelRuntime: root.modelRuntime,
				resourceLoader: root.resourceLoader,
				diagnostics: [],
			},
			async ({ sessionManager }) => ({
				...(await createAgentSession({ ...settings, sessionManager })),
				services: {
					cwd: h.tempDir,
					agentDir: h.tempDir,
					settingsManager: h.settingsManager,
					modelRuntime: root.modelRuntime,
					resourceLoader: createTestResourceLoader(),
					diagnostics: [],
				},
				diagnostics: [],
			}),
		);
		cleanups.push(() => runtime.dispose());
		await runtime.fork(root.sessionManager.getLeafId()!, { position: "at" });
		expect(runtime.session.sessionId).not.toBe(root.sessionId);
		expect(runtime.session.subagents!.coordinator.usage.created).toBe(0);
		await runtime.newSession();
		expect(runtime.session.subagents).toBeDefined();
	});
});
