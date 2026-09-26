import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMaintenance } from "../../src/core/context-maintenance.ts";
import { History } from "../../src/core/history.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const controlTools = ["history", "context_note", "todo_write", "get_context_remaining", "new_context"];

function pages(context: Context): Record<string, unknown>[] {
	return context.messages.flatMap((message) =>
		message.role !== "toolResult"
			? []
			: message.content.flatMap((block) => {
					if (block.type !== "text") return [];
					try {
						const value: unknown = JSON.parse(block.text);
						return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
					} catch {
						return [];
					}
				}),
	);
}

function seedHistory(h: Harness, toolOutput: boolean): string {
	h.sessionManager.ensureContextWindow();
	h.sessionManager.appendMessage({ role: "user", content: "Earlier inspection", timestamp: 1 });
	let source: string;
	if (toolOutput) {
		const call = fauxToolCall("inspect", {});
		h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		source = h.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "ARCHIVED_OUTPUT ".repeat(6800) }],
			isError: false,
			timestamp: 2,
		});
		// Keep a recent workset beyond Shake's protected suffix.
		h.sessionManager.appendMessage(fauxAssistantMessage("recent work ".repeat(6200)));
	} else {
		source = h.sessionManager.appendMessage(fauxAssistantMessage("old analysis ".repeat(9800)));
		h.sessionManager.appendMessage({ role: "user", content: "Recent checkpoint", timestamp: 3 });
		h.sessionManager.appendMessage(fauxAssistantMessage("Recent verified findings. ".repeat(120)));
	}
	h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
	return source;
}

describe("progressive short-term memory through user prompts", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0).reverse()) await h.cleanup();
	});
	async function setup(options: Parameters<typeof createHarness>[0] = {}) {
		const h = await createHarness({ initialActiveToolNames: controlTools, ...options });
		harnesses.push(h);
		return h;
	}

	it("Shakes saved output, remeasures the real request and continues without summarizing or switching", async () => {
		const h = await setup({ persistSession: true, models: [{ id: "shake", contextWindow: 48000, maxTokens: 1000 }] });
		const source = seedHistory(h, true);
		const window = h.sessionManager.ensureContextWindow().windowId;
		h.setResponses([
			(context) => {
				expect(context.tools?.some((tool) => tool.name === "new_context")).toBe(true);
				expect(JSON.stringify(context.messages)).toContain("[shaken:");
				expect(JSON.stringify(context.messages)).not.toContain("ARCHIVED_OUTPUT ARCHIVED_OUTPUT");
				return fauxAssistantMessage("Reviewed the local changes. Nothing published.");
			},
		]);
		await h.session.prompt("Review the local changes. Never publish.");
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.sessionManager.ensureContextWindow().windowId).toBe(window);
		expect(new History(h.sessionManager).query({ operation: "read_item", entryId: source }).items[0]).toMatchObject({
			text: expect.stringContaining("ARCHIVED_OUTPUT"),
		});
		expect(readFileSync(h.session.sessionFile!, "utf8")).toContain("ARCHIVED_OUTPUT ARCHIVED_OUTPUT");
	});

	it("compacts an older prefix in the same window and sends the retained requirements and Todo", async () => {
		const h = await setup({
			persistSession: true,
			models: [{ id: "compact", contextWindow: 42000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 512 } },
		});
		seedHistory(h, false);
		const window = h.sessionManager.ensureContextWindow().windowId;
		h.session.todoStateStore.applyMerge([{ id: "verify", content: "Verify local output", status: "in_progress" }]);
		h.sessionManager.appendCustomEntry("todo-state", h.session.todoStateStore.toJSON());
		const requirement = "Never publish. Verify local output and keep the original task IDs.";
		h.setResponses([
			(context) => {
				expect(context.tools?.length ?? 0).toBe(0);
				expect(JSON.stringify(context.messages)).toContain("old analysis");
				return fauxAssistantMessage(
					"Earlier inspection completed. Continue verifying the local output; publishing is forbidden.",
				);
			},
			fauxAssistantMessage("The recent checkpoint started verification; its findings remain in the kept suffix."),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(requirement);
				expect(JSON.stringify(context.messages)).toContain("in_progress");
				expect(JSON.stringify(context.messages)).toContain("Verify local output");
				expect(JSON.stringify(context.messages)).toContain("<summary>");
				expect(JSON.stringify(context.messages)).not.toContain("old analysis old analysis");
				return fauxAssistantMessage("Verification completed locally.");
			},
		]);
		await h.session.prompt(requirement);
		expect(
			h.session.state.runState,
			JSON.stringify({ state: h.session.state.runState, compaction: h.eventsOfType("compaction_end") }),
		).toMatchObject({ lastOutcome: { type: "completed" } });
		expect(h.faux.state.callCount).toBe(3);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(h.sessionManager.ensureContextWindow().windowId).toBe(window);
		expect(SessionManager.open(h.session.sessionFile!).ensureContextWindow().windowId).toBe(window);
		expect(new History(h.sessionManager).query({ operation: "list_windows" }).items).toHaveLength(1);
	});

	it("rejects a summary with no net savings and permits a final answer without new_context", async () => {
		const h = await setup({
			models: [{ id: "no-savings", contextWindow: 42000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 512 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "larger summary ".repeat(12000),
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		seedHistory(h, false);
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(
					"Only your explicit new_context call authorizes rollover",
				);
				return fauxAssistantMessage("I will stop here with the current findings.");
			},
		]);
		await h.session.prompt("Review the implementation locally.");
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
		expect(h.faux.state.callCount).toBe(1);
		expect(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction" || entry.type === "context_rollover"),
		).toHaveLength(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it("honors a compaction veto without entering saving or switching", async () => {
		const h = await setup({
			models: [{ id: "veto", contextWindow: 42000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 512 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		seedHistory(h, false);
		await h.session.prompt("Continue inspection.");
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "aborted" } });
		expect(h.faux.state.callCount).toBe(0);
		expect(
			h.sessionManager
				.getBranch()
				.some((entry) => entry.type === "context_operation" || entry.type === "context_rollover"),
		).toBe(false);
	});

	it("does not turn a valid Note into authorization, and exhausts one persisted decision allowance", async () => {
		const h = await setup({
			persistSession: true,
			models: [{ id: "bounded-decision", contextWindow: 43000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 512 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "larger summary ".repeat(12000),
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		seedHistory(h, false);
		h.setResponses([
			() => {
				const source = new History(h.sessionManager)
					.getItems()
					.filter((item) => item.role === "user")
					.at(-1)!;
				const ref = { entryId: source.entryId, blockIndex: source.blocks[0].blockIndex };
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "next_action",
						key: "current",
						text: "Continue the inspection.",
						sourceRefs: [ref],
						resume: {
							relatedNotes: [],
							requiredHistoryRefs: [],
							requirementSourceRefs: [ref],
							todoIds: [],
							subagentContinuations: [],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxToolCall("get_context_remaining", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("get_context_remaining", {}), { stopReason: "toolUse" }),
		]);
		await h.session.prompt("Inspect the remaining local work.");
		expect(h.faux.state.callCount, JSON.stringify(h.session.state.runState)).toBe(3);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "model_request_missing" },
		});
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		const restored = await setup({
			sessionFile: h.session.sessionFile!,
			fauxApi: h.getModel().api,
			models: [{ id: "bounded-decision", contextWindow: 43000, maxTokens: 1000 }],
		});
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(0);
	});

	it("preserves oversized user requirements and blocks when no legal saving request fits", async () => {
		const h = await setup({
			persistSession: true,
			models: [{ id: "huge-input", contextWindow: 14000, maxTokens: 1000 }],
		});
		const input = `<requirements>\n${"Never remove this requirement. ".repeat(6000)}\n</requirements>`;
		await h.session.prompt(input);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "save_state_budget_exhausted" },
		});
		expect(
			h.sessionManager.getBranch().some((entry) => entry.type === "shake" || entry.type === "context_rollover"),
		).toBe(false);
		expect(JSON.stringify(h.sessionManager.buildSessionContext().messages)).toContain(
			"Never remove this requirement.",
		);
	});

	it("does not regrant compression attempts for diagnostic traffic or process restart", async () => {
		const h = await setup({ persistSession: true });
		h.sessionManager.ensureContextWindow();
		h.sessionManager.appendMessage({ role: "user", content: "Inspect", timestamp: 1 });
		const maintenance = new ContextMaintenance(h.sessionManager);
		maintenance.begin(maintenance.next("config"));
		maintenance.begin(maintenance.next("config"));
		h.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("get_context_remaining", {}), { stopReason: "toolUse" }),
		);
		h.sessionManager.appendCustomMessageEntry("context-save-state", "Decide", false);
		const restored = new ContextMaintenance(SessionManager.open(h.session.sessionFile!));
		expect(restored.next("config").stage).toBe("decision");
	});

	it("keeps memory and disk at the old Todo revision when persistence fails", async () => {
		const h = await setup({ persistSession: true });
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("todo_write", { todos: [{ id: "verify", content: "Verify", status: "pending" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Todo recorded."),
		]);
		await h.session.prompt("Record a verification task.");
		const persist = h.sessionManager._persist.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "_persist").mockImplementation((entry) => {
			if (entry.type === "custom" && entry.customType === "todo-state") throw new Error("disk failure");
			persist(entry);
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "verify", status: "completed" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The update could not be saved."),
		]);
		await h.session.prompt("Mark verification complete.");
		expect(h.session.todoStateStore.get("verify")?.status).toBe("pending");
		const saved = SessionManager.open(h.session.sessionFile!)
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "todo-state")
			.at(-1);
		expect(saved?.type === "custom" ? saved.data : null).toMatchObject([{ id: "verify", status: "pending" }]);
		expect(
			h
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "todo_write")
				.at(-1)?.isError,
		).toBe(true);
	});

	it("recovers every unfinished Todo, including model-omitted IDs, before a real business action", async () => {
		let executions = 0;
		const verify: AgentTool = {
			name: "verify_local",
			label: "verify_local",
			description: "Verify the local artifact",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "Local artifact verified" }], details: {} };
			},
		};
		const h = await setup({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.registerTool(verify);
				},
			],
			initialActiveToolNames: [...controlTools, verify.name],
		});
		const todos = Array.from({ length: 12 }, (_, index) => ({
			id: `task-${index}`,
			content: `Verify part ${index}`,
			status: index === 0 ? "in_progress" : "pending",
		}));
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("todo_write", {
					todos: [...todos, { id: "done", content: "Already inspected", status: "completed" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("new_context", { reason: "Continue verification from Note and all unfinished tasks" }),
				{ stopReason: "toolUse" },
			),
			() => {
				const source = new History(h.sessionManager).getItems().find((item) => item.role === "user")!;
				const ref = { entryId: source.entryId, blockIndex: source.blocks[0].blockIndex };
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "next_action",
						key: "current",
						text: "Verify the local artifact. Preserve the remaining task IDs.",
						sourceRefs: [ref],
						evidenceRefs: [],
						resume: {
							relatedNotes: [],
							requiredHistoryRefs: [],
							requirementSourceRefs: [ref],
							todoIds: [],
							subagentContinuations: [],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const resumeRef = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i)?.[1];
				expect(resumeRef).toBeDefined();
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef }), {
					stopReason: "toolUse",
				});
			},
			...Array.from({ length: 20 }, () => (context: Context) => {
				if (JSON.stringify(context.messages).includes("Required continuation sources are present")) {
					for (const todo of todos) expect(JSON.stringify(context.messages)).toContain(todo.content);
					return executions === 0
						? fauxAssistantMessage(fauxToolCall("verify_local", {}), { stopReason: "toolUse" })
						: fauxAssistantMessage("Verification resumed from the saved task state.");
				}
				const readPages = pages(context);
				const resumePages = readPages.filter(
					(page) =>
						page.source === "task_notes" &&
						Array.isArray(page.items) &&
						page.items.some((item) => item && typeof item === "object" && "type" in item && item.type !== "note"),
				);
				const latestResume = resumePages.at(-1);
				if (typeof latestResume?.cursor === "string") {
					const resumeRef = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i)?.[1];
					return fauxAssistantMessage(
						fauxToolCall("context_note", { operation: "query", resumeRef, cursor: latestResume.cursor }),
						{ stopReason: "toolUse" },
					);
				}
				const records = resumePages.flatMap((page) => page.items as Record<string, unknown>[]);
				const todoRefs = records.filter((item) => item.type === "todo");
				expect(todoRefs).toHaveLength(12);
				expect(todoRefs.some((item) => item.todoId === "done")).toBe(false);
				const alreadyRead = readPages
					.flatMap((page) => (Array.isArray(page.items) ? (page.items as Record<string, unknown>[]) : []))
					.filter((item) => typeof item.text === "string");
				const missing = records.filter((item) => {
					if (item.type === "next_action") return !alreadyRead.some((read) => read.eventId === item.eventId);
					if (item.type === "todo") return !alreadyRead.some((read) => read.todoId === item.todoId);
					if (item.type === "requirement_source")
						return !alreadyRead.some(
							(read) => read.entryId === item.entryId && read.blockIndex === item.blockIndex,
						);
					return false;
				});
				if (!missing.length) return fauxAssistantMessage("All required sources have been read.");
				return fauxAssistantMessage(
					missing.slice(0, 4).map((item) =>
						item.type === "next_action"
							? fauxToolCall("context_note", { operation: "query", item: item.eventId })
							: fauxToolCall("history", {
									operation: "read_item",
									entryId: item.entryId,
									...(item.type === "todo" ? { todoId: item.todoId } : { blockIndex: item.blockIndex }),
								}),
					),
					{ stopReason: "toolUse" },
				);
			}),
		]);
		await h.session.prompt("Verify all twelve parts locally. Never publish. Retain any unfinished tasks.");
		expect(
			h.session.state.runState,
			JSON.stringify({
				state: h.session.state.runState,
				tools: h.eventsOfType("tool_execution_end").filter((event) => event.isError),
			}),
		).toMatchObject({ lastOutcome: { type: "completed" } });
		expect(executions).toBe(1);
		const rollover = h.sessionManager.getBranch().find((entry) => entry.type === "context_rollover");
		expect(rollover?.type === "context_rollover" ? rollover.recovery.todoIds : []).toEqual(
			todos.map((todo) => todo.id),
		);
		expect(h.session.todoStateStore.get("done")?.status).toBe("completed");
	});
});
