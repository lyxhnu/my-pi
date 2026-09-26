import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Context,
	estimateTextTokens,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextRemaining } from "../../src/core/context-budget.ts";
import {
	type ContextRecoveryReferences,
	contextRecoveryCoverage,
	currentContextRecoveryReferences,
} from "../../src/core/context-rollover.ts";
import { currentContextWindow } from "../../src/core/context-window.ts";
import { History, type HistoryPage } from "../../src/core/history.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTaskScopeId } from "../../src/core/task-note-projection.ts";
import { queryTaskNotes } from "../../src/core/task-note-query.ts";
import { type ContextNoteToolInput, createContextNoteToolDefinition } from "../../src/core/tools/context-note.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("context window memory", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0).reverse()) await h.cleanup();
	});
	async function setup(options: Parameters<typeof createHarness>[0] = {}) {
		const h = await createHarness(options);
		harnesses.push(h);
		return h;
	}
	const longTask = `Never publish. Review the implementation.\n${"Saved original task context. ".repeat(1400)}`;
	const shortTask = "Never publish. Review the implementation and report the next concrete verification step.";

	it("accepts the documented minimal first context note", async () => {
		const h = await setup();
		h.setResponses([fauxAssistantMessage("ready")]);
		await h.session.prompt("Preserve the deployment constraint.");
		const source = new History(h.sessionManager).getItems().find((item) => item.role === "user");
		if (!source) throw new Error("missing task source");
		const tool = createContextNoteToolDefinition({
			sessionManager: h.sessionManager,
			getPromptGeneration: () => h.sessionManager.getLatestContextCoordinates().promptGeneration,
			getContextEpoch: () => h.sessionManager.getLatestContextCoordinates().contextEpoch,
		});
		const result = await tool.execute(
			"note-call",
			{
				operation: "upsert",
				kind: "constraint",
				key: "deployment",
				text: "Preserve the deployment constraint.",
				sourceRefs: [{ entryId: source.entryId, blockIndex: 0 }],
			},
			undefined,
			undefined,
			h.session.extensionRunner.createContext(),
		);

		expect(result.details).toMatchObject({ operation: "upsert", kind: "constraint", key: "deployment" });
		expect(tool.promptGuidelines?.join("\n")).toContain("evidenceRefs and resume are optional");
		expect(tool.promptGuidelines?.join("\n")).toContain("Never send an empty supersedesEventId");
	});

	function saveContinuation(
		h: Harness,
		text = "Read the saved requirements, then review the implementation.",
		withBudget = false,
	) {
		return (context: Context) => {
			expect(context.tools?.map((tool) => tool.name).sort()).toEqual([
				"context_note",
				"get_context_remaining",
				"history",
				"new_context",
				...(h.session.getActiveToolNames().includes("todo_write") ? ["todo_write"] : []),
			]);
			const saveStateMessage = h.session.messages.find(
				(message) => message.role === "custom" && message.customType === "context-save-state",
			);
			if (saveStateMessage?.role !== "custom") throw new Error("missing save-state control message");
			expect(saveStateMessage.content).toContain("No resumeRef exists yet");
			expect(saveStateMessage.content).toContain('{"operation":"list_items","role":"user"}');
			expect(saveStateMessage.content).toContain("list_windows is insufficient");
			expect(saveStateMessage.content).toContain('{"operation":"query"} and no resumeRef');
			expect(saveStateMessage.content).toContain('{"operation":"upsert","kind":"next_action","key":"current"');
			expect(saveStateMessage.content).toContain('"evidenceRefs":[]');
			expect(saveStateMessage.content).toContain("include supersedesEventId set exactly to that item's eventId");
			expect(saveStateMessage.content).toContain(
				"choose exactly one immediate action that can finish within one context window",
			);
			expect(saveStateMessage.content).toContain("completed required Memory or external reads");
			expect(saveStateMessage.content).toContain(
				"Do not turn completed inspection, retrieval, or known failed attempts back into future work",
			);
			expect(saveStateMessage.content).toContain('key must be exactly "current"');
			const task = new History(h.sessionManager).getItems().find((item) => item.role === "user");
			if (!task) throw new Error("missing task source");
			const block = task.blocks.find((item) => item.type === "text");
			const reference = {
				entryId: task.entryId,
				...(block && block.blockIndex >= 0 ? { blockIndex: block.blockIndex } : {}),
			};
			const note = fauxToolCall("context_note", {
				operation: "upsert",
				kind: "next_action",
				key: "current",
				text,
				sourceRefs: [reference],
				evidenceRefs: [],
				resume: {
					relatedNotes: [],
					requiredHistoryRefs: [],
					requirementSourceRefs: [reference],
					todoIds: [],
					subagentContinuations: [],
				},
			});
			return fauxAssistantMessage([...(withBudget ? [fauxToolCall("get_context_remaining", {})] : []), note], {
				stopReason: "toolUse",
			});
		};
	}

	function parsedToolPages(context: Context): Record<string, unknown>[] {
		return context.messages.flatMap((message) => {
			if (message.role !== "toolResult") return [];
			return message.content.flatMap((block): Record<string, unknown>[] => {
				if (block.type !== "text") return [];
				try {
					const value: unknown = JSON.parse(block.text);
					return value !== null && typeof value === "object" ? [value as Record<string, unknown>] : [];
				} catch {
					return [];
				}
			});
		});
	}

	function recoveryResponses(finalText = "Review completed from recovered sources."): FauxResponseStep[] {
		return [
			(context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing visible resume reference");
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const records = parsedToolPages(context).flatMap((page) =>
					Array.isArray(page.items)
						? page.items.filter(
								(item): item is Record<string, unknown> => item !== null && typeof item === "object",
							)
						: [],
				);
				const nextAction = records.find((item) => item.type === "next_action");
				if (typeof nextAction?.eventId !== "string") throw new Error("missing visible next action reference");
				const references = records.filter(
					(item) => item.type === "requirement_source" || item.type === "required_history",
				);
				const seen = new Set<string>();
				const reads = references.flatMap((reference) => {
					if (typeof reference.entryId !== "string") return [];
					const key = `${reference.entryId}:${reference.blockIndex ?? ""}`;
					if (seen.has(key)) return [];
					seen.add(key);
					return [
						fauxToolCall("history", {
							operation: "read_item",
							entryId: reference.entryId,
							...(typeof reference.blockIndex === "number" ? { blockIndex: reference.blockIndex } : {}),
						}),
					];
				});
				return fauxAssistantMessage(
					[
						fauxToolCall("context_note", { operation: "query", item: nextAction.eventId }),
						...reads,
						...records
							.filter((item) => item.type === "todo")
							.map((item) =>
								fauxToolCall("history", {
									operation: "read_item",
									entryId: item.entryId,
									todoId: item.todoId,
								}),
							),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("The required source bodies are loaded."),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Required continuation sources");
				return fauxAssistantMessage(finalText);
			},
		];
	}

	it("persists an initial window before the provider request and completes the batch before switching", async () => {
		const h = await setup({ persistSession: true });
		let firstWindow = "";
		h.setResponses([
			(context) => {
				firstWindow = h.sessionManager.ensureContextWindow().windowId;
				expect(readFileSync(h.session.sessionFile!, "utf8")).toContain(firstWindow);
				expect(JSON.stringify(context.messages)).toContain(firstWindow);
				return fauxAssistantMessage(
					[
						fauxToolCall("new_context", { reason: "Continue with recovered requirements" }),
						fauxToolCall("get_context_remaining", {}),
					],
					{ stopReason: "toolUse" },
				);
			},
			saveContinuation(h),
			...recoveryResponses(),
		]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(6);
		expect(h.session.contextRolloverState.dispatchState).toBe("finished");
		expect(h.sessionManager.getLatestContextCoordinates().promptGeneration).toBe(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.sessionManager.getBranch().filter((e) => e.type === "context_rollover")).toHaveLength(1);
	});

	it("reconfirms a Note written before a business result in the same new-context batch", async () => {
		const mutationTool: AgentTool = {
			name: "mutate",
			label: "mutate",
			description: "persist a late business fact",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				return { content: [{ type: "text", text: "late business result" }], details: {} };
			},
		};
		const h = await setup({
			tools: [mutationTool],
			initialActiveToolNames: ["mutate", "history", "context_note", "get_context_remaining", "new_context"],
		});
		h.setResponses([
			() => {
				const task = new History(h.sessionManager).getItems().find((item) => item.role === "user");
				if (!task) throw new Error("missing task source");
				const source = { entryId: task.entryId, blockIndex: task.blocks[0].blockIndex };
				return fauxAssistantMessage(
					[
						fauxToolCall("new_context", { reason: "continue after the late business result" }),
						fauxToolCall("context_note", {
							operation: "upsert",
							kind: "next_action",
							key: "current",
							text: "Continue from the state before the business result.",
							sourceRefs: [source],
							evidenceRefs: [],
							resume: {
								relatedNotes: [],
								requiredHistoryRefs: [],
								requirementSourceRefs: [source],
								todoIds: [],
								subagentContinuations: [],
							},
						}),
						fauxToolCall("mutate", {}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				fauxToolCall("context_note", { operation: "query", kind: "next_action", key: "current" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const current = parsedToolPages(context)
					.flatMap((page) => (Array.isArray(page.items) ? page.items : []))
					.find(
						(item): item is Record<string, unknown> =>
							item !== null && typeof item === "object" && typeof item.eventId === "string",
					);
				if (typeof current?.eventId !== "string") throw new Error("missing stale continuation event");
				const history = new History(h.sessionManager).getItems();
				const task = history.find((item) => item.role === "user");
				const mutation = history.find((item) => item.toolName === "mutate");
				if (!task || !mutation) throw new Error("missing post-batch sources");
				const requirement = { entryId: task.entryId, blockIndex: task.blocks[0].blockIndex };
				const result = { entryId: mutation.entryId, blockIndex: mutation.blocks[0].blockIndex };
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "next_action",
						key: "current",
						text: "Inspect the late business result, then continue.",
						sourceRefs: [requirement, result],
						evidenceRefs: [result],
						supersedesEventId: current.eventId,
						resume: {
							relatedNotes: [],
							requiredHistoryRefs: [result],
							requirementSourceRefs: [requirement],
							todoIds: [],
							subagentContinuations: [],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			...recoveryResponses("continued after the complete mixed batch"),
		]);
		await h.session.prompt(shortTask);
		const branch = h.sessionManager.getBranch();
		const operations = branch.filter((entry) => entry.type === "context_operation");
		expect(new Set(operations.map((entry) => entry.operationId)).size).toBe(1);
		expect(branch.filter((entry) => entry.type === "context_rollover")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(7);
		const page = queryTaskNotes(h.sessionManager, 1, {
			operation: "query",
			kind: "next_action",
		});
		const current = (Array.isArray(page.items) ? page.items : []).find(
			(item: unknown): item is { type: "note"; eventId: string } =>
				item !== null &&
				typeof item === "object" &&
				"type" in item &&
				item.type === "note" &&
				"eventId" in item &&
				typeof item.eventId === "string",
		);
		if (!current) throw new Error("missing active continuation note");
		expect(
			JSON.stringify(
				queryTaskNotes(h.sessionManager, 1, { operation: "query", item: current.eventId, verify: true }),
			),
		).toContain("Inspect the late business result");
	});

	it("recovers requirements without injecting a history suffix or a Note catalog", async () => {
		const h = await setup();
		h.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("new_context", { reason: "Read the effective requirements" }), {
					stopReason: "toolUse",
				}),
			saveContinuation(h),
			...recoveryResponses("Review can continue with the original constraint."),
		]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(6);
		expect(h.eventsOfType("tool_execution_end").every((e) => !e.isError)).toBe(true);
		expect(JSON.stringify(h.session.messages)).not.toContain("Task Note reference catalog");
	});

	it.each(["inactive", "denied"])("blocks transition when recovery is %s", async (mode) => {
		const h = await setup({
			initialActiveToolNames: mode === "inactive" ? ["new_context"] : undefined,
			settings: mode === "denied" ? { permissions: { deny: [{ pattern: "history:*" }] } } : {},
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not send"),
		]);
		await h.session.prompt(longTask);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.sessionManager.getBranch().some((e) => e.type === "context_rollover")).toBe(false);
	});

	it("stops a failed automatic transition instead of looping on a queued Todo reminder", async () => {
		const h = await setup({
			models: [{ id: "missing-save-tool", contextWindow: 24000, maxTokens: 1000 }],
			initialActiveToolNames: ["todo_write", "context_note", "get_context_remaining", "new_context"],
			settings: {
				compaction: { autoCompactThresholdPercent: 50 },
				reminder: { todoGate: { enabled: true } },
			},
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						if (
							!event.messages.some(
								(message) => message.role === "toolResult" && message.toolName === "todo_write",
							)
						)
							return undefined;
						return {
							messages: [
								...event.messages,
								{
									role: "custom" as const,
									customType: "test-existing-context",
									content: "existing context ".repeat(10000),
									display: false,
									timestamp: 1,
								},
							],
						};
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("todo_write", { todos: [{ id: "inspect", content: "Inspect the task", status: "pending" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("must not send"),
		]);

		await h.session.prompt(shortTask);

		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "recovery_unavailable: missing save-state tool" },
		});
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
	});

	it("keeps the old window when commit persistence fails", async () => {
		const h = await setup({ persistSession: true });
		const persist = h.sessionManager._persist.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "_persist").mockImplementation((entry) => {
			if (entry.type === "context_rollover") throw new Error("disk failure");
			persist(entry);
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			saveContinuation(h),
		]);
		await h.session.prompt(shortTask);
		expect(h.sessionManager.getBranch().some((e) => e.type === "context_rollover")).toBe(false);
		expect(JSON.stringify(h.session.messages)).toContain("Never publish");
		expect(h.faux.state.callCount).toBe(2);
	});

	it("persists unknown dispatch without replaying an ambiguous provider failure", async () => {
		const h = await setup({ persistSession: true });
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			saveContinuation(h),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection lost" }),
		]);
		await h.session.prompt(shortTask);
		expect(h.session.contextRolloverState.dispatchState).toBe("outcome_unknown");
		const reopened = SessionManager.open(h.session.sessionFile!);
		expect(reopened.getContextRolloverState().dispatchState).toBe("outcome_unknown");
		expect(h.faux.state.callCount).toBe(3);
		const restored = await setup({ sessionFile: h.session.sessionFile!, fauxApi: h.getModel().api });
		restored.setResponses([fauxAssistantMessage("must not replay")]);
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(0);
	});

	it("restores only the selected branch's authoritative Todo state", async () => {
		const h = await setup({ initialActiveToolNames: ["todo_write"] });
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("todo_write", { todos: [{ id: "a", content: "read", status: "pending" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("first branch"),
			fauxAssistantMessage(
				fauxToolCall("todo_write", { todos: [{ id: "b", content: "sibling only", status: "pending" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("second branch"),
		]);
		await h.session.prompt("first task");
		const firstLeaf = h.sessionManager.getLeafId()!;
		await h.session.prompt("extend the task");
		expect(h.session.todoStateStore.get("b")).toBeDefined();
		await h.session.navigateTree(firstLeaf, { summarize: false });
		expect(h.session.todoStateStore.get("a")).toBeDefined();
		expect(h.session.todoStateStore.get("b")).toBeUndefined();
		expect(new History(h.sessionManager).query({ operation: "search", text: "sibling only" }).items).toEqual([]);
	});

	it("creates an independent branch window and keeps its resume reference queryable", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			saveContinuation(h),
			...recoveryResponses("done"),
		]);
		await h.session.prompt(shortTask);
		const before = currentContextWindow(h.sessionManager.getBranch())!;
		const rollover = h.sessionManager.getBranch().find((e) => e.type === "context_rollover")!;
		if (rollover.type !== "context_rollover") throw new Error("missing rollover");
		h.sessionManager.branch(h.sessionManager.getLeafId()!);
		const after = currentContextWindow(h.sessionManager.getBranch())!;
		expect(after.windowId).not.toBe(before.windowId);
		expect(after.previousWindowId).toBe(before.windowId);
		expect(JSON.stringify(h.sessionManager.buildSessionContext().messages)).toContain(after.windowId);
		expect(
			queryTaskNotes(h.sessionManager, 1, { operation: "query", resumeRef: rollover.rolloverId }).items,
		).not.toEqual([]);
	});

	it("history applies one visibility policy and excludes sibling, reasoning, Memory and recursive query results", async () => {
		const h = await setup();
		const m = h.sessionManager;
		m.ensureContextWindow();
		const root = m.appendMessage({ role: "user", content: "visible request", timestamp: 1 });
		m.appendMessage(
			fauxAssistantMessage([
				{ type: "thinking", thinking: "hidden reasoning" },
				{ type: "text", text: "visible answer" },
			]),
		);
		for (const toolName of ["memory_get", "memory_search", "history", "context_note"])
			m.appendMessage({
				role: "toolResult",
				toolCallId: toolName,
				toolName,
				content: [{ type: "text", text: "invisible recursive content" }],
				isError: false,
				timestamp: 2,
			});
		const history = new History(m);
		expect(JSON.stringify(history.getItems())).not.toMatch(/hidden reasoning|invisible recursive/);
		const sibling = m.appendMessage({ role: "user", content: "sibling only", timestamp: 3 });
		m.branch(root);
		expect(() => history.query({ operation: "read_item", entryId: sibling })).toThrow("not visible");
		expect(history.query({ operation: "search", text: "sibling" }).items).toEqual([]);
	});

	it("bounds Unicode pages and resumes scans with zero matches", async () => {
		const h = await setup();
		h.sessionManager.ensureContextWindow();
		const body = `${"中😀a".repeat(20000)}needle`;
		const id = h.sessionManager.appendMessage({ role: "user", content: body, timestamp: 1 });
		const history = new History(h.sessionManager);
		let page = history.query({ operation: "read_item", entryId: id });
		let text = "";
		for (let i = 0; i < 40; i++) {
			expect(estimateTextTokens(JSON.stringify(page))).toBeLessThanOrEqual(2048);
			const fragment = page.items[0] as { text: string };
			expect(Buffer.from(fragment.text, "utf8").toString("utf8")).toBe(fragment.text);
			text += fragment.text;
			if (page.exhausted) break;
			page = history.query({ operation: "read_item", entryId: id, cursor: page.cursor! });
		}
		expect(text).toBe(body);
		const first = history.query({ operation: "search", text: "needle" });
		expect(first).toMatchObject({ items: [], exhausted: false });
		const second = history.query({ operation: "search", text: "needle", cursor: first.cursor! });
		expect(second.items).toHaveLength(1);
		h.sessionManager.startContextWindow("branch");
		expect(() => history.query({ operation: "search", text: "needle", cursor: first.cursor! })).toThrow("cursor");
	});

	it("deduplicates readback from current-window results and allows explicit verification", async () => {
		const h = await setup();
		const m = h.sessionManager;
		m.ensureContextWindow();
		const id = m.appendMessage({ role: "user", content: "short source", timestamp: 1 });
		const history = new History(m);
		const first = history.query({ operation: "read_item", entryId: id });
		const readbackId = m.appendMessage({
			role: "toolResult",
			toolCallId: "readback",
			toolName: "history",
			content: [{ type: "text", text: JSON.stringify(first) }],
			details: first,
			isError: false,
			timestamp: 2,
		});
		expect(history.query({ operation: "read_item", entryId: id }).items[0]).toMatchObject({
			text: "",
			alreadyReadThrough: 12,
		});
		expect(history.query({ operation: "read_item", entryId: id, verify: true }).items[0]).toMatchObject({
			text: "short source",
		});
		m.appendShake([{ kind: "toolResult", targetId: readbackId, text: "[shaken: readback removed]" }], 100, "manual");
		expect(history.query({ operation: "read_item", entryId: id }).items[0]).toMatchObject({ text: "short source" });
	});

	it.each([1, 2])("reassembles at most once when the source changes %i times during preparation", async (changes) => {
		const h = await setup();
		const prepare = h.session.agent.prepareContinuation.bind(h.session.agent);
		let attempts = 0;
		vi.spyOn(h.session.agent, "prepareContinuation").mockImplementation(async (...args) => {
			const result = await prepare(...args);
			if (++attempts <= changes) h.sessionManager.appendCustomEntry("source-change", { attempts });
			return result;
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			saveContinuation(h),
			...recoveryResponses("continued"),
		]);
		await h.session.prompt(shortTask);
		expect(attempts).toBe(2);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover")).toHaveLength(
			changes === 1 ? 1 : 0,
		);
		expect(h.faux.state.callCount).toBe(changes === 1 ? 6 : 2);
	});

	it("reconfirms a finished continuation in the same operation when Todo changes during prepare", async () => {
		const h = await setup();
		const prepare = h.session.agent.prepareContinuation.bind(h.session.agent);
		let changed = false;
		vi.spyOn(h.session.agent, "prepareContinuation").mockImplementation(async (...args) => {
			const result = await prepare(...args);
			if (!changed) {
				changed = true;
				h.sessionManager.appendCustomEntry("todo-state", [
					{ id: "late-check", content: "Check the late fact", priority: "medium", status: "pending" },
				]);
			}
			return result;
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "revalidate concurrent facts" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			fauxAssistantMessage(
				fauxToolCall("context_note", { operation: "query", kind: "next_action", key: "current" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const current = parsedToolPages(context)
					.flatMap((page) => (Array.isArray(page.items) ? page.items : []))
					.find(
						(item): item is Record<string, unknown> =>
							item !== null && typeof item === "object" && typeof item.eventId === "string",
					);
				if (typeof current?.eventId !== "string") throw new Error("missing current continuation event");
				const task = new History(h.sessionManager).getItems().find((item) => item.role === "user");
				if (!task) throw new Error("missing task source");
				const reference = { entryId: task.entryId, blockIndex: task.blocks[0].blockIndex };
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "next_action",
						key: "current",
						text: "Reconfirm the late Todo, then continue.",
						sourceRefs: [reference],
						evidenceRefs: [],
						supersedesEventId: current.eventId,
						resume: {
							relatedNotes: [],
							requiredHistoryRefs: [],
							requirementSourceRefs: [reference],
							todoIds: [],
							subagentContinuations: [],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			...recoveryResponses("continued after reconfirmation"),
		]);
		await h.session.prompt(shortTask);
		const operations = h.sessionManager.getBranch().filter((entry) => entry.type === "context_operation");
		expect(new Set(operations.map((entry) => entry.operationId)).size).toBe(1);
		expect(operations.map((entry) => entry.state)).toEqual(
			expect.arrayContaining(["finished", "started", "finished"]),
		);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(8);
	});

	it("re-prepares a changed steering queue and delivers the reserved message exactly once", async () => {
		const h = await setup({ persistSession: true });
		const prepare = h.session.agent.prepareContinuation.bind(h.session.agent);
		let attempts = 0;
		vi.spyOn(h.session.agent, "prepareContinuation").mockImplementation(async (...args) => {
			const result = await prepare(...args);
			if (++attempts === 1) await h.session.steer("Keep all changes local.");
			return result;
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			saveContinuation(h),
			...recoveryResponses("continued"),
		]);
		await h.session.prompt(shortTask);
		expect(attempts).toBe(2);
		expect(h.session.pendingMessageCount).toBe(0);
		expect(
			JSON.stringify(SessionManager.open(h.session.sessionFile!).buildSessionContext().messages).match(
				/Keep all changes local/g,
			),
		).toHaveLength(1);
	});

	it("waits for background work before committing a requested window", async () => {
		const h = await setup();
		let release = () => {};
		const task = h.session.taskManager.start({
			kind: "bash",
			description: "pending evidence",
			run: () =>
				new Promise((resolve) => {
					release = () => resolve({ status: "completed", exitCode: 0 });
				}),
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch after task completion" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			...recoveryResponses("continued"),
		]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_transition" } });
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		release();
		await h.session.taskManager.awaitSettled(task.taskId);
		await vi.waitFor(() => expect(h.session.contextRolloverState.dispatchState).toBe("finished"));
		expect(h.faux.state.callCount).toBe(6);
	});

	it("does not commit an empty read-only continuation", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "continue reading" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("I did not save a continuation."),
			fauxAssistantMessage("Still missing the continuation."),
			fauxAssistantMessage("No continuation."),
		]);
		await h.session.prompt(shortTask);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover")).toHaveLength(0);
		expect(h.faux.state.callCount).toBe(4);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "continuation_state_missing" },
		});
		expect(h.sessionManager.getLatestContextCoordinates().promptGeneration).toBe(1);
	});

	it("asks the model after provider rejection and never infers a window request", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
			fauxAssistantMessage("The current window cannot continue; no new window requested."),
		]);
		await h.session.prompt(shortTask);
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(2);
	});

	it("re-measures pressure from the final transform before deciding whether further maintenance is needed", async () => {
		let inflateNextNormalRequest = true;
		const h = await setup({
			models: [{ id: "automatic-threshold", contextWindow: 24000, maxTokens: 1000 }],
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						if (!inflateNextNormalRequest) return undefined;
						inflateNextNormalRequest = false;
						return {
							messages: [
								...event.messages,
								{
									role: "custom" as const,
									customType: "test-existing-context",
									content: "existing context ".repeat(10000),
									display: false,
									timestamp: 1,
								},
							],
						};
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage("The transient context is gone; complete in the original window.")]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("saves state once with restricted tools and reports the actual final request budget", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "inspect measured save budget" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h, "Read the requirements, then continue the measured task.", true),
			...recoveryResponses("Recovered"),
		]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(6);
		const budget = h.sessionManager.getEntries().find((e) => e.type === "trace" && e.event.type === "context/budget");
		if (budget?.type !== "trace" || budget.event.type !== "context/budget") throw new Error("missing budget");
		const operation = h.sessionManager.getBranch().filter((e) => e.type === "context_operation");
		expect(operation.map((entry) => entry.state)).toContain("finished");
		expect(
			h.eventsOfType("tool_execution_end").find((event) => event.toolName === "get_context_remaining")?.result
				.details,
		).toMatchObject({ phase: "save_state", remainingWorkTokens: 0 });
		const unknown = contextRemaining(
			{ ...budget.event.data.budget, unknownFields: ["contextWindow"], decision: "unknown" },
			{ windowId: "unknown", measuredAtEntryId: null, requestConfigRevision: "config" },
			85,
		);
		expect(unknown).toMatchObject({ remainingInputTokens: null, remainingWorkTokens: null, measurement: "unknown" });
	});

	it("continues the same save operation when the first control sample only queries history", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "save after discovery" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("history", { operation: "list_items", role: "user" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
				const page = parsedToolPages(context).find((item) => item.source === "session_history");
				const task = Array.isArray(page?.items)
					? page.items.find(
							(item): item is Record<string, unknown> =>
								item !== null && typeof item === "object" && item.role === "user",
						)
					: undefined;
				const block = Array.isArray(task?.blocks)
					? task.blocks.find(
							(item): item is Record<string, unknown> =>
								item !== null && typeof item === "object" && item.type === "text",
						)
					: undefined;
				if (typeof task?.entryId !== "string" || typeof block?.blockIndex !== "number")
					throw new Error("missing provider-visible task reference");
				const reference = {
					entryId: task.entryId,
					...(block.blockIndex >= 0 ? { blockIndex: block.blockIndex } : {}),
				};
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "next_action",
						key: "current",
						text: "Continue after provider-visible discovery.",
						sourceRefs: [reference],
						evidenceRefs: [],
						resume: {
							relatedNotes: [],
							requiredHistoryRefs: [],
							requirementSourceRefs: [reference],
							todoIds: [],
							subagentContinuations: [],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			...recoveryResponses("continued after a discovery-only save sample"),
		]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(7);
		const operations = h.sessionManager.getBranch().filter((entry) => entry.type === "context_operation");
		expect(new Set(operations.map((entry) => entry.operationId)).size).toBe(1);
		expect(operations.at(-1)).toMatchObject({ state: "finished", samplesUsed: 2 });
	});

	it("shares one save-stage read budget across parallel history queries", async () => {
		const h = await setup();
		h.sessionManager.ensureContextWindow();
		for (let index = 0; index < 120; index++) {
			h.sessionManager.appendMessage({
				role: "user",
				content: `Archived requirement ${index}: ${"detail ".repeat(30)}`,
				timestamp: index,
			});
		}
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "discover references in parallel" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("history", { operation: "list_items", role: "user", budgetTokens: 2048 }),
					fauxToolCall("history", { operation: "list_items", role: "user", budgetTokens: 2048 }),
				],
				{ stopReason: "toolUse" },
			),
			saveContinuation(h),
			...recoveryResponses("continued after bounded parallel discovery"),
		]);
		await h.session.prompt(shortTask);
		const pages = h
			.eventsOfType("tool_execution_end")
			.filter((event) => event.toolName === "history")
			.slice(0, 2);
		expect(pages).toHaveLength(2);
		expect(pages.every((event) => !event.isError)).toBe(true);
		expect(
			pages.reduce((total, event) => total + estimateTextTokens(JSON.stringify(event.result.details)), 0),
		).toBeLessThanOrEqual(3072);
	});

	it("blocks a business tool requested in the same recovery batch as required reads", async () => {
		let mutations = 0;
		const mutationTool: AgentTool = {
			name: "mutate",
			label: "mutate",
			description: "perform a business mutation",
			parameters: Type.Object({}),
			execute: async () => {
				mutations++;
				return { content: [{ type: "text", text: "mutated" }], details: {} };
			},
		};
		const h = await setup({
			tools: [mutationTool],
			initialActiveToolNames: ["mutate", "history", "context_note", "get_context_remaining", "new_context"],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "recover before mutation" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			(context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing resume reference");
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const records = parsedToolPages(context).flatMap((page) =>
					Array.isArray(page.items)
						? page.items.filter(
								(item): item is Record<string, unknown> => item !== null && typeof item === "object",
							)
						: [],
				);
				const next = records.find((item) => item.type === "next_action");
				const requirement = records.find((item) => item.type === "requirement_source");
				if (typeof next?.eventId !== "string" || typeof requirement?.entryId !== "string")
					throw new Error("missing recovery references");
				return fauxAssistantMessage(
					[
						fauxToolCall("context_note", { operation: "query", item: next.eventId }),
						fauxToolCall("history", {
							operation: "read_item",
							entryId: requirement.entryId,
							...(typeof requirement.blockIndex === "number" ? { blockIndex: requirement.blockIndex } : {}),
						}),
						fauxToolCall("mutate", {}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Recovery reads are complete."),
			fauxAssistantMessage("Business work can now continue."),
		]);
		await h.session.prompt(shortTask);
		expect(mutations).toBe(0);
		expect(h.eventsOfType("tool_execution_end").find((event) => event.toolName === "mutate")).toMatchObject({
			isError: true,
		});
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("adds a steering constraint delivered during recovery to the required source coverage", async () => {
		let mutations = 0;
		const mutationTool: AgentTool = {
			name: "mutate",
			label: "mutate",
			description: "perform work that depends on the recovered constraint",
			parameters: Type.Object({}),
			execute: async () => {
				mutations++;
				return { content: [{ type: "text", text: "mutated after recovery" }], details: {} };
			},
		};
		const h = await setup({
			tools: [mutationTool],
			initialActiveToolNames: ["mutate", "history", "context_note", "get_context_remaining", "new_context"],
		});
		const steeringConstraint = "New constraint: inspect recovered sources before mutation.";
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "recover before constrained work" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			(context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing resume reference");
				void h.session.steer(steeringConstraint);
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const effective = parsedToolPages(context)
					.flatMap((page) => (Array.isArray(page.items) ? page.items : []))
					.find(
						(item): item is Record<string, unknown> =>
							item !== null && typeof item === "object" && item.type === "effective_requirements",
					);
				if (typeof effective?.startEntryId !== "string") throw new Error("missing requirements start");
				return fauxAssistantMessage(
					fauxToolCall("history", {
						operation: "list_items",
						role: "user",
						startEntryId: effective.startEntryId,
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const records = parsedToolPages(context).flatMap((page) =>
					Array.isArray(page.items)
						? page.items.filter(
								(item): item is Record<string, unknown> => item !== null && typeof item === "object",
							)
						: [],
				);
				const next = records.find((item) => item.type === "next_action");
				if (typeof next?.eventId !== "string") throw new Error("missing next action");
				const userReferences = records.flatMap((item) => {
					if (item.role !== "user" || typeof item.entryId !== "string" || !Array.isArray(item.blocks)) return [];
					return item.blocks.flatMap((block) => {
						if (
							block === null ||
							typeof block !== "object" ||
							!("blockIndex" in block) ||
							typeof block.blockIndex !== "number"
						)
							return [];
						return [{ entryId: item.entryId, blockIndex: block.blockIndex }];
					});
				});
				expect(userReferences).toHaveLength(2);
				return fauxAssistantMessage(
					[
						fauxToolCall("context_note", { operation: "query", item: next.eventId }),
						...userReferences.map((reference) =>
							fauxToolCall("history", { operation: "read_item", ...reference }),
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("All current requirement sources are loaded."),
			(context) => {
				expect(context.tools?.some((tool) => tool.name === "mutate")).toBe(true);
				expect(JSON.stringify(context.messages)).toContain(steeringConstraint);
				return fauxAssistantMessage(fauxToolCall("mutate", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Constrained work completed."),
		]);
		await h.session.prompt(shortTask);
		expect(mutations).toBe(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("does not credit recovery pages removed by the final context transform", async () => {
		let replacementRuns = 0;
		const replacementTool: AgentTool = {
			name: "replace_task",
			label: "replace_task",
			description: "execute the replacement user task",
			parameters: Type.Object({}),
			execute: async () => {
				replacementRuns++;
				return { content: [{ type: "text", text: "replacement task executed" }], details: {} };
			},
		};
		const h = await setup({
			tools: [replacementTool],
			initialActiveToolNames: ["replace_task", "history", "context_note", "get_context_remaining", "new_context"],
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: JSON.stringify(event.messages).includes("resume_ref:")
							? event.messages.filter(
									(message) =>
										message.role !== "toolResult" || !["history", "context_note"].includes(message.toolName),
								)
							: event.messages,
					}));
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "test final request coverage" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			...Array.from({ length: 3 }, () => (context: Context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing resume reference");
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			}),
		]);
		await h.session.prompt(shortTask);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "recovery_no_progress" },
		});
		expect(
			h.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "context-recovery-complete"),
		).toBe(false);
		h.setResponses([
			(context) => {
				expect(context.tools?.some((tool) => tool.name === "replace_task")).toBe(true);
				return fauxAssistantMessage(fauxToolCall("replace_task", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Replacement task completed."),
		]);
		await h.session.prompt("Replace the interrupted task and execute the replacement tool.");
		expect(replacementRuns).toBe(1);
		expect(h.sessionManager.getLatestContextCoordinates().promptGeneration).toBe(2);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("can re-read a recovery page removed from one final provider request", async () => {
		let removedOnce = false;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						const removable = event.messages.filter(
							(message) =>
								message.role === "toolResult" && ["history", "context_note"].includes(message.toolName),
						);
						if (removedOnce || removable.length === 0 || !JSON.stringify(event.messages).includes("resume_ref:"))
							return undefined;
						removedOnce = true;
						return {
							messages: event.messages.filter((message) => !removable.includes(message)),
						};
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "re-read transformed recovery pages" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			(context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing resume reference");
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(parsedToolPages(context)).toHaveLength(0);
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing resume reference after transform");
				return fauxAssistantMessage(
					fauxToolCall("context_note", { operation: "query", resumeRef: match[1], verify: true }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const records = parsedToolPages(context).flatMap((page) =>
					Array.isArray(page.items)
						? page.items.filter(
								(item): item is Record<string, unknown> => item !== null && typeof item === "object",
							)
						: [],
				);
				const next = records.find((item) => item.type === "next_action");
				const requirement = records.find((item) => item.type === "requirement_source");
				if (typeof next?.eventId !== "string" || typeof requirement?.entryId !== "string")
					throw new Error("missing re-read references");
				return fauxAssistantMessage(
					[
						fauxToolCall("context_note", { operation: "query", item: next.eventId, verify: true }),
						fauxToolCall("history", {
							operation: "read_item",
							entryId: requirement.entryId,
							...(typeof requirement.blockIndex === "number" ? { blockIndex: requirement.blockIndex } : {}),
							verify: true,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("The re-read source bodies are loaded."),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Required continuation sources are present");
				return fauxAssistantMessage("Continued after the final-request transform.");
			},
		]);
		await h.session.prompt(shortTask);
		expect(removedOnce).toBe(true);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("rejects a rollover before commit when the transformed recovery workset cannot fit", async () => {
		const h = await setup({
			models: [{ id: "recovery-unlock", contextWindow: 12000, maxTokens: 1000 }],
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: JSON.stringify(event.messages).includes("context-recovery-complete")
							? [
									...event.messages,
									{
										role: "user" as const,
										content: "required transformed input ".repeat(10000),
										timestamp: 1,
									},
								]
							: event.messages,
					}));
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "verify unlock capacity" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			...recoveryResponses("must not consume"),
		]);
		await h.session.prompt(shortTask);
		expect(h.getPendingResponseCount()).toBe(4);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "recovery_workset_too_large" },
		});
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover")).toHaveLength(0);
	});

	it("uses the actual new-window capacity for recovery bodies larger than the save budget", async () => {
		const h = await setup();
		let requirementEntryId = "";
		const continueRecovery = (context: Context) => {
			if (JSON.stringify(context.messages).includes("Required continuation sources are present"))
				return fauxAssistantMessage("Continued after reading the long requirement.");
			const page = parsedToolPages(context)
				.filter(
					(candidate) =>
						candidate.source === "session_history" &&
						Array.isArray(candidate.items) &&
						candidate.items.some(
							(item) => item !== null && typeof item === "object" && item.entryId === requirementEntryId,
						),
				)
				.at(-1);
			if (typeof page?.cursor !== "string") return fauxAssistantMessage("The complete long requirement is loaded.");
			return fauxAssistantMessage(
				fauxToolCall("history", { operation: "read_item", entryId: requirementEntryId, cursor: page.cursor }),
				{ stopReason: "toolUse" },
			);
		};
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "recover a long authoritative requirement" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h, "Read the complete long requirement before continuing."),
			(context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing resume reference");
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const records = parsedToolPages(context).flatMap((page) =>
					Array.isArray(page.items)
						? page.items.filter(
								(item): item is Record<string, unknown> => item !== null && typeof item === "object",
							)
						: [],
				);
				const next = records.find((item) => item.type === "next_action");
				const requirement = records.find((item) => item.type === "requirement_source");
				if (typeof next?.eventId !== "string" || typeof requirement?.entryId !== "string")
					throw new Error("missing recovery references");
				requirementEntryId = requirement.entryId;
				return fauxAssistantMessage(
					[
						fauxToolCall("context_note", { operation: "query", item: next.eventId }),
						fauxToolCall("history", { operation: "read_item", entryId: requirementEntryId }),
					],
					{ stopReason: "toolUse" },
				);
			},
			...Array.from({ length: 5 }, () => continueRecovery),
		]);
		await h.session.prompt(`${shortTask}\n${"detail ".repeat(2200)}`);
		const recoveryHistoryTokens = h
			.eventsOfType("tool_execution_end")
			.filter((event) => event.toolName === "history" && !event.isError)
			.reduce((total, event) => total + estimateTextTokens(JSON.stringify(event.result.details)), 0);
		expect(recoveryHistoryTokens).toBeGreaterThan(3072);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("queries an older task Note scope explicitly and reads tool and Todo identities exactly", async () => {
		const h = await setup();
		const manager = h.sessionManager;
		manager.ensureContextWindow();
		manager.appendCustomEntry("context-prompt-generation", { promptGeneration: 1, contextEpoch: 0 });
		const firstTask = manager.appendMessage({ role: "user", content: "First task requirement.", timestamp: 1 });
		const noteTool = createContextNoteToolDefinition({
			sessionManager: manager,
			getPromptGeneration: () => 1,
			getContextEpoch: () => 0,
		});
		const noteInput: ContextNoteToolInput = {
			operation: "upsert",
			kind: "constraint",
			key: "first.requirement",
			text: "First task requirement.",
			sourceRefs: [{ entryId: firstTask }],
			evidenceRefs: [],
		};
		const noteCall = fauxToolCall("context_note", noteInput);
		manager.appendMessage(fauxAssistantMessage(noteCall, { stopReason: "toolUse" }));
		await noteTool.execute(noteCall.id, noteInput, undefined, undefined, h.session.extensionRunner.createContext());
		manager.appendCustomEntry("context-prompt-generation", { promptGeneration: 2, contextEpoch: 0 });
		manager.appendMessage({ role: "user", content: "Second task requirement.", timestamp: 2 });
		const oldScope = queryTaskNotes(manager, 2, { operation: "query", taskSourceEntryId: firstTask });
		expect(oldScope).toMatchObject({ scope: { promptGeneration: 1, historical: true } });
		expect(JSON.stringify(oldScope)).toContain("first.requirement");

		const toolCall = fauxToolCall("inspect", { target: "alpha" });
		manager.appendMessage(fauxAssistantMessage(toolCall, { stopReason: "toolUse" }));
		const sourceId = manager.appendToolResultSource(
			toolCall.id,
			"inspect",
			[{ type: "text", text: "authoritative inspection result" }],
			{ internalToken: "do-not-expose" },
			false,
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: "inspect",
			content: [{ type: "text", text: "bounded projection" }],
			details: {},
			isError: false,
			timestamp: 3,
		});
		const todoId = manager.appendCustomEntry("todo-state", [
			{ id: "verify-alpha", content: "Verify alpha", priority: "medium", status: "pending" },
		]);
		const history = new History(manager);
		expect(JSON.stringify(history.query({ operation: "list_items", entryId: sourceId }))).not.toContain(
			"do-not-expose",
		);
		expect(history.query({ operation: "search", text: "do-not-expose" }).items).toHaveLength(0);
		expect(history.query({ operation: "list_items", toolCallId: toolCall.id }).items).toContainEqual(
			expect.objectContaining({ entryId: sourceId, toolCallId: toolCall.id }),
		);
		expect(history.query({ operation: "read_item", entryId: sourceId, blockIndex: 0 }).items[0]).toMatchObject({
			text: "authoritative inspection result",
		});
		expect(history.query({ operation: "read_item", entryId: todoId, todoId: "verify-alpha" }).items[0]).toMatchObject(
			{ todoId: "verify-alpha", text: expect.stringContaining("Verify alpha") },
		);
		expect(JSON.stringify(history.query({ operation: "list_items", entryId: todoId }))).not.toContain("Verify alpha");
	});

	it("credits only exact current Note, History, and Todo source bodies", async () => {
		const h = await setup();
		const manager = h.sessionManager;
		manager.ensureContextWindow();
		manager.appendCustomEntry("context-prompt-generation", { promptGeneration: 1, contextEpoch: 0 });
		const taskId = manager.appendMessage({ role: "user", content: "Authoritative task body.", timestamp: 1 });
		const noteTool = createContextNoteToolDefinition({
			sessionManager: manager,
			getPromptGeneration: () => 1,
			getContextEpoch: () => 0,
		});
		const noteInput: ContextNoteToolInput = {
			operation: "upsert",
			kind: "next_action",
			key: "current",
			text: "continue",
			sourceRefs: [{ entryId: taskId }],
			evidenceRefs: [],
			resume: {
				relatedNotes: [],
				requiredHistoryRefs: [],
				requirementSourceRefs: [{ entryId: taskId }],
				todoIds: ["todo-1"],
				subagentContinuations: [],
			},
		};
		const noteCall = fauxToolCall("context_note", noteInput);
		manager.appendMessage(fauxAssistantMessage(noteCall, { stopReason: "toolUse" }));
		const noteResult = await noteTool.execute(
			noteCall.id,
			noteInput,
			undefined,
			undefined,
			h.session.extensionRunner.createContext(),
		);
		if (
			noteResult.details === null ||
			typeof noteResult.details !== "object" ||
			!("eventId" in noteResult.details) ||
			typeof noteResult.details.eventId !== "string"
		)
			throw new Error("missing Note event ID");
		const nextActionEventId = noteResult.details.eventId;
		const todoStateEntryId = manager.appendCustomEntry("todo-state", [
			{
				id: "todo-1",
				content: `Verify exact Todo ${"with all saved acceptance detail. ".repeat(400)}`,
				priority: "medium",
				status: "pending",
			},
		]);
		const history = new History(manager);
		const todoItem = history.getItems().find((item) => item.entryId === todoStateEntryId);
		if (!todoItem?.todoRevision) throw new Error("missing Todo revision");
		const notePage = queryTaskNotes(manager, 1, { operation: "query", item: nextActionEventId });
		const recovery: ContextRecoveryReferences = {
			subagentTasks: [],
			requiredTaskIds: [],
			subagentNoteEventId: null,
			saveStateOperationId: "save",
			nextActionEventId,
			relatedNoteEventIds: [],
			noteFreshness: [{ eventId: nextActionEventId, freshness: "not_applicable" }],
			requiredHistoryRefs: [],
			requirementSourceRefs: [{ entryId: taskId }],
			todoIds: ["todo-1"],
			taskSourceEntryId: taskId,
			requirementsStartEntryId: taskId,
			historyCutoffEntryId: "cutoff",
			historyStartEntryId: taskId,
			todoStateEntryId,
			todoStateFingerprint: todoItem.todoRevision,
			taskNoteProjectionRevision: String(notePage.revision),
			taskScopeId: createTaskScopeId(taskId),
		};
		const pageMessage = (toolName: string, page: Record<string, unknown>): Message => ({
			role: "toolResult",
			toolCallId: `${toolName}-call`,
			toolName,
			content: [{ type: "text", text: JSON.stringify(page) }],
			details: page,
			isError: false,
			timestamp: 1,
		});
		const note = pageMessage("context_note", notePage);
		const resume = pageMessage("context_note", {
			source: "task_notes",
			revision: notePage.revision,
			items: [{ type: "next_action", eventId: nextActionEventId }],
			exhausted: true,
			cursor: null,
		});
		const task = pageMessage("history", { ...history.query({ operation: "read_item", entryId: taskId }) });
		const exactTodoPages: HistoryPage[] = [];
		let todoCursor: string | undefined;
		do {
			const page = history.query({
				operation: "read_item",
				entryId: todoStateEntryId,
				todoId: "todo-1",
				budgetTokens: 512,
				verify: true,
				...(todoCursor === undefined ? {} : { cursor: todoCursor }),
			});
			exactTodoPages.push(page);
			todoCursor = typeof page.cursor === "string" ? page.cursor : undefined;
		} while (todoCursor !== undefined);
		expect(exactTodoPages.length).toBeGreaterThan(1);
		const todoPages = (revision: string) =>
			exactTodoPages.map((page) =>
				pageMessage("history", {
					...page,
					items: page.items.map((item) => ({ ...(item as Record<string, unknown>), revision })),
				}),
			);
		expect(
			contextRecoveryCoverage(manager, [resume, note, task, ...todoPages("stale-revision")], recovery),
		).toMatchObject({
			complete: false,
			missing: ["todo:todo-1"],
		});
		const tamperedNote = pageMessage("context_note", {
			...notePage,
			items: (notePage.items as Record<string, unknown>[]).map((item) => ({ ...item, text: "" })),
		});
		expect(
			contextRecoveryCoverage(manager, [resume, tamperedNote, task, ...todoPages(todoItem.todoRevision)], recovery),
		).toMatchObject({ complete: false, missing: [`note:${nextActionEventId}`] });
		const complete = contextRecoveryCoverage(
			manager,
			[resume, note, task, ...todoPages(todoItem.todoRevision)],
			recovery,
		);
		expect(complete.complete).toBe(true);
		const duplicate = contextRecoveryCoverage(
			manager,
			[resume, note, task, ...todoPages(todoItem.todoRevision), note, task, ...todoPages(todoItem.todoRevision)],
			recovery,
		);
		expect(duplicate.coveredUnits).toBe(complete.coveredUnits);
		expect(duplicate.progressFingerprint).toBe(complete.progressFingerprint);
		for (let index = 0; index < 600; index++)
			manager.appendMessage(fauxAssistantMessage(`searchable history row ${index}`));
		const searchInput = { operation: "search" as const, role: "assistant", text: "absent recovery needle" };
		const firstSearchPage = history.query(searchInput);
		if (typeof firstSearchPage.cursor !== "string") throw new Error("expected a paged History search");
		manager.appendCustomEntry("cursor-snapshot-change", {});
		const repeatedFirstPage = history.query(searchInput);
		if (typeof repeatedFirstPage.cursor !== "string") throw new Error("expected a repeated paged History search");
		expect(repeatedFirstPage.cursor).not.toBe(firstSearchPage.cursor);
		const nextSearchPage = history.query({ ...searchInput, cursor: firstSearchPage.cursor });
		const searchMessages = (page: HistoryPage, cursor?: string): Message[] => {
			const call = fauxToolCall("history", { ...searchInput, ...(cursor === undefined ? {} : { cursor }) });
			return [
				fauxAssistantMessage(call, { stopReason: "toolUse" }),
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "history",
					content: [{ type: "text", text: JSON.stringify(page) }],
					details: page,
					isError: false,
					timestamp: 1,
				},
			];
		};
		const firstSearch = contextRecoveryCoverage(manager, searchMessages(firstSearchPage), recovery);
		const repeatedSearch = contextRecoveryCoverage(manager, searchMessages(repeatedFirstPage), recovery);
		expect(repeatedSearch.coveredUnits).toBe(firstSearch.coveredUnits);
		expect(repeatedSearch.progressFingerprint).toBe(firstSearch.progressFingerprint);
		const progressedSearch = contextRecoveryCoverage(
			manager,
			[...searchMessages(firstSearchPage), ...searchMessages(nextSearchPage, firstSearchPage.cursor)],
			recovery,
		);
		expect(progressedSearch.coveredUnits).toBeGreaterThan(firstSearch.coveredUnits);
		expect(progressedSearch.progressFingerprint).not.toBe(firstSearch.progressFingerprint);
	});

	it("resolves superseded continuation Notes from the current effective projection", async () => {
		const h = await setup();
		const manager = h.sessionManager;
		manager.ensureContextWindow();
		manager.appendCustomEntry("context-prompt-generation", { promptGeneration: 1, contextEpoch: 0 });
		const taskId = manager.appendMessage({ role: "user", content: "Current task requirement.", timestamp: 1 });
		const noteTool = createContextNoteToolDefinition({
			sessionManager: manager,
			getPromptGeneration: () => 1,
			getContextEpoch: () => 1,
		});
		const writeNote = async (input: ContextNoteToolInput): Promise<string> => {
			const call = fauxToolCall("context_note", input);
			manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			const result = await noteTool.execute(
				call.id,
				input,
				undefined,
				undefined,
				h.session.extensionRunner.createContext(),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "context_note",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			});
			if (
				result.details === null ||
				typeof result.details !== "object" ||
				!("eventId" in result.details) ||
				typeof result.details.eventId !== "string"
			)
				throw new Error("missing Note event ID");
			return result.details.eventId;
		};
		const originalConstraint = await writeNote({
			operation: "upsert",
			kind: "constraint",
			key: "scope",
			text: "Original constraint.",
			sourceRefs: [{ entryId: taskId }],
			evidenceRefs: [],
		});
		const originalNextAction = await writeNote({
			operation: "upsert",
			kind: "next_action",
			key: "current",
			text: "Original next action.",
			sourceRefs: [{ entryId: taskId }],
			evidenceRefs: [],
			resume: {
				relatedNotes: [{ kind: "constraint", key: "scope" }],
				requiredHistoryRefs: [],
				requirementSourceRefs: [{ entryId: taskId }],
				todoIds: [],
				subagentContinuations: [],
			},
		});
		const originalProjection = queryTaskNotes(manager, 1, { operation: "query" });
		const cutoffId = manager.getLeafId();
		if (!cutoffId) throw new Error("missing recovery cutoff");
		const committed: ContextRecoveryReferences = {
			subagentTasks: [],
			requiredTaskIds: [],
			subagentNoteEventId: null,
			saveStateOperationId: "save",
			nextActionEventId: originalNextAction,
			relatedNoteEventIds: [originalConstraint],
			noteFreshness: [originalNextAction, originalConstraint].map((eventId) => ({
				eventId,
				freshness: "not_applicable",
			})),
			requiredHistoryRefs: [],
			requirementSourceRefs: [{ entryId: taskId }],
			todoIds: [],
			taskSourceEntryId: taskId,
			requirementsStartEntryId: taskId,
			historyCutoffEntryId: cutoffId,
			historyStartEntryId: taskId,
			todoStateEntryId: null,
			todoStateFingerprint: "committed-empty-todo",
			taskNoteProjectionRevision: String(originalProjection.revision),
			taskScopeId: createTaskScopeId(taskId),
		};
		await writeNote({
			operation: "upsert",
			kind: "decision",
			key: "unrelated",
			text: "An unrelated Note update.",
			sourceRefs: [{ entryId: taskId }],
			evidenceRefs: [],
		});
		const currentConstraint = await writeNote({
			operation: "upsert",
			kind: "constraint",
			key: "scope",
			text: "Updated constraint.",
			sourceRefs: [{ entryId: taskId }],
			evidenceRefs: [],
			supersedesEventId: originalConstraint,
		});
		const currentNextAction = await writeNote({
			operation: "upsert",
			kind: "next_action",
			key: "current",
			text: "Updated next action.",
			sourceRefs: [{ entryId: taskId }],
			evidenceRefs: [],
			resume: {
				relatedNotes: [{ kind: "constraint", key: "scope" }],
				requiredHistoryRefs: [{ entryId: taskId }],
				requirementSourceRefs: [{ entryId: taskId }],
				todoIds: [],
				subagentContinuations: [],
			},
			supersedesEventId: originalNextAction,
		});
		const current = currentContextRecoveryReferences(manager, committed);
		expect(current).toMatchObject({
			nextActionEventId: currentNextAction,
			relatedNoteEventIds: [currentConstraint],
			requiredHistoryRefs: [{ entryId: taskId }],
		});
		expect(current.taskNoteProjectionRevision).not.toBe(committed.taskNoteProjectionRevision);

		await writeNote({
			operation: "retract",
			kind: "next_action",
			key: "current",
			sourceRefs: [{ entryId: taskId }],
			supersedesEventId: currentNextAction,
		});
		expect(() => currentContextRecoveryReferences(manager, committed)).toThrow("recovery_reference_invalid");
	});

	it("finishes a fully persisted save operation after restart without another save-state model call", async () => {
		const h = await setup({ persistSession: true });
		const append = h.sessionManager.appendContextOperation.bind(h.sessionManager);
		const interrupted = vi.spyOn(h.sessionManager, "appendContextOperation").mockImplementation((entry) => {
			if (entry.state === "finished") throw new Error("interrupted before finished persisted");
			return append(entry);
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "restart after complete save batch" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
		]);
		await h.session.prompt(shortTask);
		expect(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_operation")
				.at(-1),
		).toMatchObject({
			state: "started",
		});
		interrupted.mockRestore();
		const restored = await setup({ sessionFile: h.session.sessionFile!, fauxApi: h.getModel().api });
		restored.setResponses(recoveryResponses("resumed without re-saving"));
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(4);
		expect(
			restored.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_operation")
				.at(-1),
		).toMatchObject({
			state: "finished",
		});
	});

	it("does not replay an incomplete persisted save-state tool transaction after restart", async () => {
		const h = await setup({ persistSession: true });
		const append = h.sessionManager.appendMessage.bind(h.sessionManager);
		const interrupted = vi.spyOn(h.sessionManager, "appendMessage").mockImplementation((message) => {
			if (message.role === "toolResult" && message.toolName === "history") {
				throw new Error("interrupted before the history result was persisted");
			}
			return append(message);
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "restart after a partial save batch" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const continuation = saveContinuation(h)(context);
				return fauxAssistantMessage(
					[
						...continuation.content.filter((block) => block.type === "toolCall"),
						fauxToolCall("history", { operation: "list_items", role: "user" }),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);
		await h.session.prompt(shortTask);
		interrupted.mockRestore();
		expect(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_operation")
				.at(-1),
		).toMatchObject({ state: "started" });
		const restored = await setup({ sessionFile: h.session.sessionFile!, fauxApi: h.getModel().api });
		restored.setResponses([fauxAssistantMessage("must not replay")]);
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(0);
		expect(restored.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover")).toHaveLength(0);
	});

	it("does not restore a save-state sampling attempt that was consumed before restart", async () => {
		const h = await setup({ persistSession: true, settings: { retry: { enabled: false } } });
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "exhaust save sampling" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("No continuation yet."),
			fauxAssistantMessage("Still no continuation."),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }),
		]);
		await h.session.prompt(shortTask);
		expect(h.faux.state.callCount).toBe(4);
		const restored = await setup({ sessionFile: h.session.sessionFile!, fauxApi: h.getModel().api });
		restored.setResponses([fauxAssistantMessage("must not receive a fourth save sample")]);
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(0);
		expect(restored.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "continuation_state_missing" },
		});
		expect(
			restored.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_operation")
				.at(-1),
		).toMatchObject({ state: "started", samplesUsed: 3 });
	});

	it("continues after a fully persisted recovery query is interrupted between provider requests", async () => {
		const h = await setup({ persistSession: true });
		const afterTurn = h.session.agent.afterTurnControl;
		if (!afterTurn) throw new Error("missing context turn controller");
		const append = h.sessionManager.appendMessage.bind(h.sessionManager);
		const omitLocalInterruption = vi.spyOn(h.sessionManager, "appendMessage").mockImplementation((message) => {
			if (
				message.role === "assistant" &&
				message.stopReason === "error" &&
				message.errorMessage === "simulated process interruption"
			)
				return h.sessionManager.getLeafId() ?? "";
			return append(message);
		});
		let interrupted = false;
		h.session.agent.afterTurnControl = async (turn) => {
			const control = await afterTurn(turn);
			if (
				!interrupted &&
				h.sessionManager
					.getBranch()
					.some((entry) => entry.type === "context_rollover_dispatch" && entry.state === "started")
			) {
				interrupted = true;
				throw new Error("simulated process interruption");
			}
			return control;
		};
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "resume persisted recovery" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h),
			recoveryResponses()[0],
		]);
		await h.session.prompt(shortTask);
		omitLocalInterruption.mockRestore();
		expect(interrupted).toBe(true);
		expect(SessionManager.open(h.session.sessionFile!).getContextRolloverState().dispatchState).toBe(
			"outcome_unknown",
		);
		const restored = await setup({ sessionFile: h.session.sessionFile!, fauxApi: h.getModel().api });
		restored.setResponses(recoveryResponses("continued from the persisted recovery boundary").slice(1));
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(3);
		expect(restored.session.contextRolloverState.dispatchState).toBe("finished");
		expect(restored.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("exports the conversation timeline with saved Note bodies and recovery pages", async () => {
		const h = await setup({ persistSession: true });
		const firstRecovery = recoveryResponses();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "export evidence" }), {
				stopReason: "toolUse",
			}),
			saveContinuation(h, "Exported continuation body."),
			...firstRecovery.slice(0, 3),
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "export a second window boundary" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("context_note", { operation: "query", kind: "next_action", key: "current" }),
				{ stopReason: "toolUse" },
			),
			...recoveryResponses("export completed"),
		]);
		await h.session.prompt(shortTask);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover")).toHaveLength(2);
		const output = await h.session.exportToHtml(`${h.tempDir}/context-window.html`);
		const html = readFileSync(output, "utf8");
		expect(html).toContain("Context window switch");
		expect(html).toContain("Saved continuation Notes (original bodies)");
		expect(html).toContain('<div class="message-role user-role">用户</div>');
		expect(html).toContain('<div class="message-role llm-role">LLM</div>');
		expect(html).toContain("Pages actually read in the new window");
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		if (!encoded) throw new Error("missing exported session data");
		const sessionData = Buffer.from(encoded, "base64").toString("utf8");
		expect(sessionData).toContain("Exported continuation body.");
		expect(sessionData).toContain('"noteFreshness"');
		expect(sessionData.match(/"type":"context_rollover"/g)).toHaveLength(2);
		const exported: unknown = JSON.parse(sessionData);
		if (
			exported === null ||
			typeof exported !== "object" ||
			!("entries" in exported) ||
			!Array.isArray(exported.entries)
		)
			throw new Error("invalid exported Session data");
		const rolloverIds = exported.entries.flatMap((entry) =>
			entry !== null &&
			typeof entry === "object" &&
			"type" in entry &&
			entry.type === "context_rollover" &&
			"rolloverId" in entry &&
			typeof entry.rolloverId === "string"
				? [entry.rolloverId]
				: [],
		);
		for (const rolloverId of rolloverIds) {
			const observedPages = exported.entries.flatMap((entry) => {
				if (
					entry === null ||
					typeof entry !== "object" ||
					!("type" in entry) ||
					entry.type !== "trace" ||
					!("event" in entry) ||
					entry.event === null ||
					typeof entry.event !== "object" ||
					!("type" in entry.event) ||
					entry.event.type !== "context/recovery" ||
					!("data" in entry.event) ||
					entry.event.data === null ||
					typeof entry.event.data !== "object" ||
					!("rolloverId" in entry.event.data) ||
					entry.event.data.rolloverId !== rolloverId ||
					!("pages" in entry.event.data) ||
					!Array.isArray(entry.event.data.pages)
				)
					return [];
				return entry.event.data.pages;
			});
			expect(observedPages.length).toBeGreaterThan(0);
		}
	});

	it("resumes a committed but unstarted dispatch exactly once", async () => {
		const h = await setup({ persistSession: true });
		const append = h.sessionManager.appendContextRolloverDispatch.bind(h.sessionManager);
		const fault = vi.spyOn(h.sessionManager, "appendContextRolloverDispatch").mockImplementation((entry) => {
			if (entry.state === "started") throw new Error("interrupted before dispatch");
			return append(entry);
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { reason: "switch" }), { stopReason: "toolUse" }),
			saveContinuation(h),
		]);
		await h.session.prompt(shortTask);
		expect(h.session.contextRolloverState.dispatchState).toBe("prepared");
		fault.mockRestore();
		const restored = await setup({ sessionFile: h.session.sessionFile!, fauxApi: h.getModel().api });
		const saved = restored.sessionManager.getBranch().find((e) => e.type === "context_rollover");
		const probe = await restored.session.agent.prepareContinuation(
			restored.sessionManager.buildSessionContext().messages,
			{ toolNames: ["history", "context_note", "get_context_remaining"], maxTokens: 2048 },
		);
		restored.session.agent.releasePreparedContinuation(probe);
		if (saved?.type !== "context_rollover") throw new Error("missing saved rollover");
		expect({
			fingerprint: probe.requestFingerprint,
			base: probe.baseContextFingerprint,
			tokens: probe.budget.tokens,
		}).toEqual({
			fingerprint: saved.preparedRequestFingerprint,
			base: saved.preparationBaseFingerprint,
			tokens: saved.preparedTokens,
		});
		restored.setResponses(recoveryResponses("resumed once"));
		await restored.session.bindExtensions({});
		await restored.session.bindExtensions({});
		expect(restored.faux.state.callCount).toBe(4);
		expect(restored.session.contextRolloverState.dispatchState).toBe("finished");
	});

	it("allows more than 256 note updates while bounding the active projection", async () => {
		const h = await setup();
		await h.session.prompt("Keep the next action accurate.");
		const m = h.sessionManager;
		const source = new History(m).getItems().find((e) => e.role === "user")!.entryId;
		const tool = createContextNoteToolDefinition({
			sessionManager: m,
			getPromptGeneration: () => 1,
			getContextEpoch: () => 0,
		});
		let previous: string | undefined;
		for (let i = 0; i < 260; i++) {
			const input: ContextNoteToolInput = {
				operation: "upsert",
				kind: "next_action",
				key: "next",
				text: `Inspect task step ${i}.`,
				sourceRefs: [{ entryId: source }],
				evidenceRefs: [],
				...(previous ? { supersedesEventId: previous } : {}),
			};
			const call = fauxToolCall("context_note", input);
			m.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			const result = await tool.execute(
				call.id,
				input,
				undefined,
				undefined,
				h.session.extensionRunner.createContext(),
			);
			previous = (result.details as { eventId: string }).eventId;
			m.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "context_note",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: i,
			});
		}
		const page = queryTaskNotes(m, 1, { operation: "query" });
		expect(page.items).toHaveLength(1);
		expect(JSON.stringify(page)).not.toContain("Inspect task step");
		expect(JSON.stringify(queryTaskNotes(m, 1, { operation: "query", item: previous }))).toContain(
			"Inspect task step 259",
		);
	});

	it("preserves complete non-newline JSONL tails and rejects incomplete final records", async () => {
		const h = await setup({ persistSession: true });
		await h.session.prompt("first");
		const file = h.session.sessionFile!;
		writeFileSync(file, readFileSync(file, "utf8").trimEnd());
		const reopened = SessionManager.open(file);
		reopened.appendMessage({ role: "user", content: "second", timestamp: 2 });
		expect(
			new History(SessionManager.open(file))
				.getItems()
				.some((e) => e.role === "user" && e.blocks.some((b) => b.text === "second")),
		).toBe(true);
		appendFileSync(file, '{"type":"context_rollover"');
		expect(() => SessionManager.open(file)).toThrow("incomplete record");
	});
});
