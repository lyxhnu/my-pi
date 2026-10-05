import type { AgentRunState } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, evaluateContextBudget, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	taskManager: {
		list: ReturnType<typeof vi.fn>;
		awaitSettled: ReturnType<typeof vi.fn>;
	};
	state: { messages: AssistantMessage[]; runState: AgentRunState };
	contextRolloverState: { dispatchState: "none" };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	waitForIdle: ReturnType<typeof vi.fn>;
	getContextTransitionGate: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state: FakeSession["state"] = { messages: [assistantMessage], runState: { status: "idle" } };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		taskManager: {
			list: vi.fn(() => []),
			awaitSettled: vi.fn(async () => undefined),
		},
		state,
		contextRolloverState: { dispatchState: "none" },
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		getContextTransitionGate: vi.fn(() => ({
			status: "ready",
			subagentTasks: [],
			requiredTaskIds: [],
			subagentNoteEventId: null,
		})),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("waits for accepted session continuations before disposing", async () => {
		const host = createRuntimeHost(createAssistantMessage({ text: "waiting" }));
		host.session.state.runState = { status: "idle", lastOutcome: { type: "completed" } };
		host.session.waitForIdle.mockImplementation(async () => {
			expect(host.dispose).not.toHaveBeenCalled();
			host.session.state.messages = [createAssistantMessage({ text: "continuation received" })];
		});
		expect(await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" })).toBe(0);
		expect(host.session.waitForIdle).toHaveBeenCalledOnce();
		expect(host.dispose).toHaveBeenCalledOnce();
	});
	it.each(["text", "json"] as const)(
		"reports a blocked maintenance request without an assistant in %s mode",
		async (mode) => {
			const host = createRuntimeHost(createAssistantMessage());
			host.session.state.messages = [];
			host.session.state.runState = {
				status: "idle",
				lastOutcome: { type: "failed", message: "save_state_budget_exhausted" },
			};
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode })).toBe(1);
			expect(errors.mock.calls.flat().join(" ")).toContain("save_state_budget_exhausted");
		},
	);
	it("waits for a Task that deferred context rollover before deciding the print run is incomplete", async () => {
		const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
		host.session.state.runState = { status: "idle", lastOutcome: { type: "context_transition" } };
		let active = true;
		host.session.getContextTransitionGate.mockImplementation(() => ({ status: active ? "busy" : "ready" }));
		host.session.taskManager.list.mockImplementation(() => (active ? [{ taskId: "task-1", status: "running" }] : []));
		host.session.taskManager.awaitSettled.mockImplementation(async () => {
			active = false;
			host.session.state.runState = { status: "idle", lastOutcome: { type: "completed" } };
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" })).toBe(0);
		expect(host.session.taskManager.awaitSettled).toHaveBeenCalledWith("task-1");
		expect(host.session.waitForIdle).toHaveBeenCalledTimes(2);
		expect(errors).not.toHaveBeenCalled();
	});

	it.each(["text", "json"] as const)("reports an unfinished context transition in %s mode", async (mode) => {
		const host = createRuntimeHost(createAssistantMessage());
		host.session.state.runState = { status: "idle", lastOutcome: { type: "context_transition" } };
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode })).toBe(1);
		expect(errors.mock.calls.flat().join(" ")).toContain("context_transition");
	});
	it.each(["text", "json"] as const)("B09 reports context_limit without an assistant in %s mode", async (mode) => {
		const host = createRuntimeHost(createAssistantMessage());
		host.session.state.messages = [];
		host.session.state.runState = {
			status: "idle",
			lastOutcome: {
				type: "context_limit",
				budget: evaluateContextBudget(
					{ tokens: 20000, usageTokens: 0, trailingTokens: 20000, lastUsageIndex: null },
					{ contextWindow: 10000, maxTokens: 1000 },
				),
			},
		};
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode })).toBe(1);
		expect(errors.mock.calls.flat().join(" ")).toContain("context_limit");
	});
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	/**
	 * A run that ends on an output-limit truncation has failed, and print mode is the only thing that can
	 * say so: the agent loop leaves `length` as the final stop reason once its truncation retries are
	 * spent, and a reasoning model that spent its whole budget thinking emits no text at all. Before this,
	 * such a run printed nothing and exited 0 — indistinguishable from having completed the work, which is
	 * the hardest possible failure to notice in an automated harness.
	 */
	it("returns non-zero when the run ends on an output-limit truncation", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason: "length" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0][0]).toContain("maximum output token limit");
	});

	it("still prints partial text when a truncated run produced some output", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "partial answer", stopReason: "length" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		// Whatever the model did manage to say is still worth having; the failure is reported alongside it
		// on stderr rather than replacing it.
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("leaves a normal completion at exit code zero", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done", stopReason: "stop" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
