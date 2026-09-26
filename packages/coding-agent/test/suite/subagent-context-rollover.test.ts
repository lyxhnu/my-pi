import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Context,
	estimateTextTokens,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import {
	type ContextRecoveryReferences,
	contextRecoveryCoverage,
	fingerprintContextRolloverValue,
	validateCommittedRecovery,
} from "../../src/core/context-rollover.ts";
import { History } from "../../src/core/history.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { captureSubagentHandoff, subagentRecoveryRecords } from "../../src/core/subagent-continuation.ts";
import { buildTaskNoteProjectionFromBranch, resolveTaskNoteScope } from "../../src/core/task-note-projection.ts";
import { queryTaskNotes } from "../../src/core/task-note-query.ts";
import { type ContextNoteToolInput, createContextNoteToolDefinition } from "../../src/core/tools/context-note.ts";
import { createGetTaskOutputToolDefinition } from "../../src/core/tools/get-task-output.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const tools = [
	"task",
	"get_task_output",
	"kill_task",
	"write",
	"read",
	"history",
	"context_note",
	"get_context_remaining",
	"new_context",
];
const delegatedPrompt = "Inspect input.txt without editing it. Report CHECKSUM-73; parent owns final.txt.";
const relation = "Child supplies the evidence for final.txt. Writing independent.txt is independent.";
const onResult = "Check CHECKSUM-73, then write final.txt once. Never apply a child patch or change input.txt.";

function pages(context: Context): Record<string, unknown>[] {
	return context.messages.flatMap((message) =>
		message.role !== "toolResult"
			? []
			: message.content.flatMap((block) => {
					if (block.type !== "text") return [];
					try {
						const page: unknown = JSON.parse(block.text);
						return page && typeof page === "object" ? [page as Record<string, unknown>] : [];
					} catch {
						return [];
					}
				}),
	);
}

function recoveryResponse(context: Context) {
	const resumeRef = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i)?.[1];
	if (!resumeRef) throw new Error("Missing visible recovery reference");
	const visible = pages(context);
	const resumePages = visible.filter(
		(page) =>
			page.source === "task_notes" &&
			Array.isArray(page.items) &&
			page.items.some((item) => item && typeof item === "object" && "type" in item && item.type !== "note"),
	);
	const latest = resumePages.at(-1);
	if (!latest || typeof latest.cursor === "string")
		return fauxAssistantMessage(
			fauxToolCall("context_note", { operation: "query", resumeRef, ...(latest ? { cursor: latest.cursor } : {}) }),
			{ stopReason: "toolUse" },
		);
	const records = resumePages.flatMap((page) => page.items as Record<string, unknown>[]);
	const read = visible
		.flatMap((page) => (Array.isArray(page.items) ? (page.items as Record<string, unknown>[]) : []))
		.filter((item) => typeof item.text === "string");
	const missing = records.filter((item) =>
		item.type === "next_action"
			? !read.some((part) => part.eventId === item.eventId)
			: (item.type === "requirement_source" || item.type === "required_history") &&
				!read.some((part) => part.entryId === item.entryId),
	);
	return missing.length === 0
		? fauxAssistantMessage("The recovery bodies are loaded.")
		: fauxAssistantMessage(
				missing.map((item) =>
					item.type === "next_action"
						? fauxToolCall("context_note", { operation: "query", item: item.eventId })
						: fauxToolCall("history", {
								operation: "read_item",
								entryId: item.entryId,
								blockIndex: item.blockIndex,
							}),
				),
				{ stopReason: "toolUse" },
			);
}

function continuation(h: Harness, taskIds: string[]) {
	const user = new History(h.sessionManager)
		.getItems()
		.filter((item) => item.role === "user")
		.at(-1)!;
	const ref = { entryId: user.entryId, blockIndex: user.blocks[0].blockIndex };
	return fauxToolCall("context_note", {
		operation: "upsert",
		kind: "next_action",
		key: "current",
		text: "Write independent.txt, then inspect the original child result and write final.txt once.",
		sourceRefs: [ref],
		evidenceRefs: [],
		resume: {
			relatedNotes: [],
			requiredHistoryRefs: [],
			requirementSourceRefs: [ref],
			todoIds: [],
			subagentContinuations: taskIds.map((taskId) => ({ taskId, parentRelation: relation, onResult })),
		},
	});
}

async function setup() {
	const h = await createHarness({
		persistSession: true,
		initialActiveToolNames: tools,
		settings: {
			permissions: { allow: [{ pattern: "task:*" }, { pattern: "kill_task:*" }] },
			retry: { enabled: false },
		},
	});
	execFileSync("git", ["init"], { cwd: h.tempDir, stdio: "ignore" });
	execFileSync(
		"git",
		["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "initial"],
		{ cwd: h.tempDir, stdio: "ignore" },
	);
	return h;
}

describe("subagent context rollover through Agent, Session, Coordinator and ChildRunner", () => {
	it.each([
		"sdk",
		"text",
		"json",
		"cancelled",
		"cancelling-before",
		"foreground-timeout",
		"twice",
		"completion-during-prepare",
		"stripped",
	] as const)(
		"preserves the real child lifecycle and verifies the first business request (%s)",
		async (mode) => {
			const h = await setup();
			const manager = h.session.taskManager;
			const gate = deferred();
			const childStarted = deferred();
			const cancellation = mode === "cancelled" || mode === "cancelling-before";
			const order: string[] = [];
			let stage = 0;
			let taskId = "";
			let recoveryRequest: Message[] = [];
			let firstRequestCovered = false;
			let preparationCount = 0;
			if (mode === "foreground-timeout") {
				const wait = manager.wait.bind(manager);
				vi.spyOn(manager, "wait").mockImplementation(async (ids, options) => {
					if (options?.timeoutMs !== 600000) return wait(ids, options);
					expect(h.session.getContextTransitionGate()).toEqual({ status: "busy" });
					const result = await wait(ids, { ...options, timeoutMs: 1 });
					expect(result.timedOut).toBe(true);
					return result;
				});
			}
			if (mode === "completion-during-prepare") {
				const prepare = h.session.agent.prepareContinuation.bind(h.session.agent);
				vi.spyOn(h.session.agent, "prepareContinuation").mockImplementation(async (...args) => {
					const result = await prepare(...args);
					if (++preparationCount === 1) {
						gate.resolve();
						await manager.awaitSettled(taskId);
						h.sessionManager.appendCustomEntry("child-terminal-observed", { taskId });
					}
					return result;
				});
			}
			if (mode === "stripped") {
				const transform = h.session.agent.transformContext;
				h.session.agent.transformContext = async (messages, signal) => {
					const transformed = transform ? await transform(messages, signal) : messages;
					if (
						!messages.some(
							(message) => message.role === "custom" && message.customType === "context-recovery-complete",
						)
					)
						return transformed;
					return transformed.map((message) =>
						message.role !== "toolResult"
							? message
							: {
									...message,
									content: message.content.map((block) =>
										block.type !== "text"
											? block
											: {
													...block,
													text: block.text.replaceAll(delegatedPrompt, "Only the task ID survived."),
												},
									),
								},
					);
				};
			}
			const stdout =
				mode === "json"
					? vi
							.spyOn(process.stdout, "write")
							.mockImplementation(
								(
									_chunk: string | Uint8Array,
									encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
									callback?: (error?: Error | null) => void,
								) => {
									if (typeof encodingOrCallback === "function") encodingOrCallback();
									else callback?.();
									return true;
								},
							)
					: undefined;
			const router = async (context: Context, options?: { signal?: AbortSignal }) => {
				if (context.tools?.some((tool) => tool.name === "submit_subagent_result")) {
					order.push("child-start");
					childStarted.resolve();
					if (mode !== "cancelling-before")
						options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true });
					await gate.promise;
					order.push("child-release");
					return fauxAssistantMessage(
						fauxToolCall("submit_subagent_result", {
							status: "completed",
							summary: "CHECKSUM-73",
							findings: [],
							changes: [],
							verification: [],
						}),
						{ stopReason: "toolUse" },
					);
				}
				const visible = JSON.stringify(context.messages);
				const savingSecondWindow =
					mode === "twice" &&
					stage === 6 &&
					h.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover").length === 1;
				if (
					visible.includes("resume_ref:") &&
					!context.tools?.some((tool) => tool.name === "task") &&
					!savingSecondWindow
				) {
					order.push("new-provider");
					expect(manager.get(taskId)?.status).toBe(
						mode === "completion-during-prepare"
							? "completed"
							: mode === "cancelling-before"
								? "cancelling"
								: "running",
					);
					return recoveryResponse(context);
				}
				if (stage++ === 0)
					return fauxAssistantMessage(
						fauxToolCall("task", {
							description: "Inspect checksum",
							prompt: delegatedPrompt,
							subagent_type: "explore",
							run_in_background: mode !== "foreground-timeout",
						}),
						{ stopReason: "toolUse" },
					);
				if (stage === 2) {
					taskId = manager.list()[0].taskId;
					if (mode === "cancelling-before") {
						await childStarted.promise;
						manager.cancel(taskId, "explicit test cancellation before rollover");
					}
					order.push("task-returned");
					return fauxAssistantMessage(continuation(h, [taskId]), { stopReason: "toolUse" });
				}
				if (stage === 3)
					return fauxAssistantMessage(
						fauxToolCall("new_context", { reason: "Continue independent work while checksum runs" }),
						{ stopReason: "toolUse" },
					);
				if (stage === 4)
					return fauxAssistantMessage(
						fauxToolCall("context_note", { operation: "query", kind: "next_action", key: "current" }),
						{ stopReason: "toolUse" },
					);
				if (stage === 5) {
					expect(visible).toContain("historicalChildInstructions");
					expect(visible).toContain(delegatedPrompt);
					expect(visible).toContain(relation);
					expect(visible).toContain(onResult);
					recoveryRequest = structuredClone(context.messages);
					const committed = h.sessionManager.getBranch().find((entry) => entry.type === "context_rollover")!;
					firstRequestCovered = contextRecoveryCoverage(
						h.sessionManager,
						recoveryRequest,
						committed.recovery,
					).complete;
					expect(manager).toBe(h.session.taskManager);
					expect(manager.get(taskId)?.status).toBe(
						mode === "completion-during-prepare"
							? "completed"
							: mode === "cancelling-before"
								? "cancelling"
								: "running",
					);
					order.push("independent");
					return fauxAssistantMessage(
						fauxToolCall("write", { path: "independent.txt", content: "parent proceeded" }),
						{ stopReason: "toolUse" },
					);
				}
				if (mode === "twice" && stage === 6)
					return fauxAssistantMessage(
						fauxToolCall("new_context", { reason: "Second window while the same child remains active" }),
						{ stopReason: "toolUse" },
					);
				if (mode === "twice" && stage === 7) {
					const call = continuation(h, [taskId]);
					const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
					const projection = buildTaskNoteProjectionFromBranch(h.sessionManager.getBranch(), scope);
					if (projection.status !== "valid") throw new Error("Invalid Note projection");
					const prior = projection.snapshot.items.find((item) => item.kind === "next_action")!;
					const write = new History(h.sessionManager)
						.getItems()
						.find((item) => item.toolName === "write" && item.role === "toolResult")!;
					const args = call.arguments as ContextNoteToolInput;
					if (args.operation !== "upsert" || !args.resume) throw new Error("Missing continuation");
					args.supersedesEventId = prior.eventId;
					args.text =
						"independent.txt was written; use the saved write result as evidence. Do not write it again. Await the original child and write final.txt once.";
					args.resume.requiredHistoryRefs = [{ entryId: write.entryId, blockIndex: write.blocks[0].blockIndex }];
					return fauxAssistantMessage(call, { stopReason: "toolUse" });
				}
				const businessStage = mode === "twice" && stage >= 8 ? stage - 2 : stage;
				if (mode === "twice" && stage === 8) {
					const committed = h.sessionManager
						.getBranch()
						.filter((entry) => entry.type === "context_rollover")
						.at(-1)!;
					expect(contextRecoveryCoverage(h.sessionManager, context.messages, committed.recovery).complete).toBe(
						true,
					);
					expect(visible).toContain(delegatedPrompt);
				}
				if (businessStage === 6) {
					expect(readFileSync(join(h.tempDir, "independent.txt"), "utf8")).toBe("parent proceeded");
					if (mode === "cancelled")
						return fauxAssistantMessage(fauxToolCall("kill_task", { task_id: taskId }), {
							stopReason: "toolUse",
						});
					gate.resolve();
					return fauxAssistantMessage(fauxToolCall("get_task_output", { task_ids: [taskId], timeout_ms: 5000 }), {
						stopReason: "toolUse",
					});
				}
				if (businessStage === 7) {
					if (cancellation) {
						expect(["cancelling", "cancelled"]).toContain(manager.get(taskId)?.status);
						gate.resolve();
					}
					await manager.awaitSettled(taskId);
					expect(manager.get(taskId)?.status).toBe(cancellation ? "cancelled" : "completed");
					order.push("terminal");
					return fauxAssistantMessage(fauxToolCall("get_task_output", { task_ids: [taskId] }), {
						stopReason: "toolUse",
					});
				}
				if (businessStage === 8) {
					if (!cancellation) expect(visible).toContain("CHECKSUM-73");
					return fauxAssistantMessage(
						fauxToolCall("write", {
							path: "final.txt",
							content: cancellation ? "cancelled; no child result applied" : "verified CHECKSUM-73",
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Parent completed after recovering the original delegation.");
			};
			h.setResponses(Array.from({ length: 60 }, () => router));
			try {
				const prompt =
					"Delegate a read-only checksum check, preserve its constraints, switch context and do independent work. Never publish. Use the original child result once.";
				if (mode === "text" || mode === "json") {
					const runtime = new AgentSessionRuntime(
						h.session,
						{
							cwd: h.tempDir,
							agentDir: h.tempDir,
							settingsManager: h.settingsManager,
							modelRuntime: h.session.modelRuntime,
							resourceLoader: h.session.resourceLoader,
							diagnostics: [],
						},
						async () => {
							throw new Error("No session replacement expected");
						},
					);
					expect(await runPrintMode(runtime, { mode, initialMessage: prompt })).toBe(0);
				} else await h.session.prompt(prompt);
				if (mode === "stripped") {
					expect(h.session.state.runState).toMatchObject({
						lastOutcome: { type: "failed", message: "recovery_request_incomplete" },
					});
					expect(stage).toBe(4);
					expect(h.eventsOfType("tool_execution_end").filter((event) => event.toolName === "write")).toHaveLength(
						0,
					);
					expect(manager.get(taskId)?.status).toBe("running");
					return;
				}
				expect(
					h.session.state.runState,
					JSON.stringify({
						state: h.session.state.runState,
						stage,
						order,
						lifecycle: h.sessionManager
							.getBranch()
							.filter(
								(entry) =>
									entry.type === "context_rollover_dispatch" ||
									entry.type === "context_operation" ||
									entry.type === "context_rollover",
							)
							.map((entry) =>
								entry.type === "context_rollover" ? { type: entry.type, id: entry.rolloverId } : entry,
							),
						errors: h.session.messages.filter(
							(message) => message.role === "assistant" && message.stopReason === "error",
						),
						tools: h.eventsOfType("tool_execution_end").filter((event) => event.isError),
					}),
				).toMatchObject({ lastOutcome: { type: "completed" } });
				const branch = h.sessionManager.getBranch();
				expect(branch.filter((entry) => entry.type === "context_rollover")).toHaveLength(mode === "twice" ? 2 : 1);
				const rollover = branch.find((entry) => entry.type === "context_rollover");
				if (rollover?.type !== "context_rollover") throw new Error("No rollover committed");
				expect(rollover.recovery.requiredTaskIds).toEqual([taskId]);
				expect(firstRequestCovered).toBe(true);
				const sourceIndex = branch.findIndex(
					(entry) => entry.id === rollover.recovery.subagentTasks[0].sourceEntryId,
				);
				expect(sourceIndex).toBeLessThan(branch.indexOf(rollover));
				expect(order.indexOf("new-provider")).toBeGreaterThan(order.indexOf("task-returned"));
				if (mode === "completion-during-prepare") {
					expect(preparationCount).toBe(2);
					expect(order.indexOf("child-release")).toBeLessThan(order.indexOf("new-provider"));
				} else expect(order.indexOf("child-release")).toBeGreaterThan(order.indexOf("independent"));
				expect(order.indexOf("terminal")).toBeGreaterThan(order.indexOf("child-release"));
				expect(h.eventsOfType("tool_execution_end").filter((event) => event.toolName === "task")).toHaveLength(1);
				expect(h.eventsOfType("tool_execution_end").filter((event) => event.toolName === "write")).toHaveLength(2);
				expect(readFileSync(join(h.tempDir, "final.txt"), "utf8")).toBe(
					cancellation ? "cancelled; no child result applied" : "verified CHECKSUM-73",
				);
				const reopened = SessionManager.open(h.session.sessionFile!);
				const latest = branch.filter((entry) => entry.type === "context_rollover").at(-1)!;
				expect(
					JSON.stringify(
						queryTaskNotes(reopened, 1, { operation: "query", resumeRef: latest.rolloverId, verify: true }),
					),
				).toContain(taskId);
				if (mode === "sdk") {
					await h.session.dispose();
					const restored = await createHarness({
						sessionFile: h.session.sessionFile!,
						fauxApi: h.faux.api,
						initialActiveToolNames: tools,
					});
					try {
						expect(restored.session.taskManager.list()).toEqual([]);
						expect(validateCommittedRecovery(restored.sessionManager, latest)).toBe(true);
						const result = await createGetTaskOutputToolDefinition(restored.session.taskManager).execute(
							"query-lost-handle",
							{ task_ids: [taskId] },
							undefined,
							undefined,
							restored.session.extensionRunner.createContext(),
						);
						expect(JSON.stringify(result)).toContain("not found");
						expect(restored.session.taskManager.list()).toEqual([]);
					} finally {
						await restored.cleanup();
					}
				}
			} finally {
				stdout?.mockRestore();
				gate.resolve();
				await Promise.all(manager.list().map((task) => manager.awaitSettled(task.taskId)));
				await h.cleanup();
			}
		},
		30000,
	);

	it.each([false, true])(
		"rejects a missing handoff without waiting or silently repairing it (same batch=%s)",
		async (sameBatch) => {
			const h = await setup();
			const gate = deferred();
			let parentCalls = 0;
			h.setResponses(
				Array.from({ length: 10 }, () => async (context: Context) => {
					if (context.tools?.some((tool) => tool.name === "submit_subagent_result")) {
						await gate.promise;
						return fauxAssistantMessage("released during cleanup");
					}
					parentCalls++;
					const rollover = fauxToolCall("new_context", { reason: "missing mapping" });
					return fauxAssistantMessage(
						parentCalls === 1
							? [
									fauxToolCall("task", {
										description: "held",
										prompt: delegatedPrompt,
										subagent_type: "explore",
									}),
									...(sameBatch ? [rollover] : []),
								]
							: [rollover],
						{ stopReason: "toolUse" },
					);
				}),
			);
			try {
				await h.session.prompt("Delegate and switch context.");
				expect(h.session.state.runState).toMatchObject({
					lastOutcome: { type: "failed", message: "subagent_handoff_invalid" },
				});
				expect(h.session.taskManager.list()[0].status).toBe("running");
				expect(parentCalls).toBe(sameBatch ? 1 : 2);
				expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
				expect(h.session.getContextTransitionGate()).toEqual({
					status: "invalid",
					reason: "subagent_handoff_invalid",
				});
			} finally {
				gate.resolve();
				await Promise.all(
					h.session.taskManager.list().map((task) => h.session.taskManager.awaitSettled(task.taskId)),
				);
				await h.cleanup();
			}
		},
	);
});

function seedDelegation(h: Harness, taskId: string, prompt = delegatedPrompt) {
	const call = fauxToolCall("task", {
		description: "inspect",
		prompt,
		subagent_type: "explore",
		capability_mode: "read-only",
		isolation: "none",
		run_in_background: true,
	});
	h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
	const content = [{ type: "text" as const, text: `Started task ${taskId}` }];
	const sourceEntryId = h.sessionManager.appendToolResultSource(call.id, "task", content, { taskId }, false);
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: "task",
		content,
		details: { taskId: "non-authoritative-projection" },
		isError: false,
		timestamp: 2,
	});
	return { taskId, toolCallId: call.id, sourceEntryId };
}

async function fixtureNote(h: Harness, taskIds: string[], generation = 1) {
	const call = continuation(h, taskIds);
	const currentScope = resolveTaskNoteScope(h.sessionManager.getBranch(), generation)!;
	const previous = buildTaskNoteProjectionFromBranch(h.sessionManager.getBranch(), currentScope);
	const prior =
		previous.status === "valid" ? previous.snapshot.items.find((item) => item.kind === "next_action") : undefined;
	if (prior) call.arguments.supersedesEventId = prior.eventId;
	h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
	const result = await createContextNoteToolDefinition({
		sessionManager: h.sessionManager,
		getPromptGeneration: () => generation,
		getContextEpoch: () => 0,
	}).execute(
		call.id,
		call.arguments as ContextNoteToolInput,
		undefined,
		undefined,
		h.session.extensionRunner.createContext(),
	);
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: "context_note",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: 3,
	});
	const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), generation)!;
	const projection = buildTaskNoteProjectionFromBranch(h.sessionManager.getBranch(), scope);
	if (projection.status !== "valid") throw new Error(projection.reason);
	return projection.snapshot.items.find((item) => item.kind === "next_action")!;
}

function beginFixture(h: Harness) {
	h.sessionManager.ensureContextWindow();
	h.sessionManager.appendCustomEntry("context-prompt-generation", { promptGeneration: 1, contextEpoch: 0 });
	return h.sessionManager.appendMessage({
		role: "user",
		content: "Preserve original child constraints. Do not repeat already handled results.",
		timestamp: 1,
	});
}

describe("subagent handoff boundaries", () => {
	it("keeps historical references separate and retains an older active task after it becomes terminal", async () => {
		const h = await createHarness();
		try {
			const originalUser = beginFixture(h);
			const old = seedDelegation(h, "older-task");
			h.sessionManager.appendCustomEntry("context-prompt-generation", { promptGeneration: 2, contextEpoch: 0 });
			h.sessionManager.appendMessage({
				role: "user",
				content:
					"Use only the newly allowed range. Earlier local child instructions do not override this requirement.",
				timestamp: 4,
			});
			const current = seedDelegation(h, "current-task");
			const note = await fixtureNote(h, [current.taskId], 2);
			const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 2)!;
			const directory = captureSubagentHandoff(h.sessionManager, scope, []);
			expect(directory.subagentTasks).toEqual([old, current]);
			expect(directory.requiredTaskIds).toEqual([current.taskId]);
			const records = subagentRecoveryRecords(h.sessionManager, directory, note);
			expect(JSON.parse(records[0].text)).toMatchObject({ taskId: old.taskId, required: false });
			expect(records[0].text).not.toContain("historicalChildInstructions");
			const active = {
				taskId: old.taskId,
				kind: "subagent" as const,
				description: "older",
				ownerSessionId: h.session.sessionId,
				archiveRole: "dependency" as const,
				status: "running" as const,
				startedAt: "now",
			};
			expect(() => captureSubagentHandoff(h.sessionManager, scope, [active])).toThrow("subagent_handoff_invalid");
			expect(() => captureSubagentHandoff(h.sessionManager, scope, [], [old.taskId])).toThrow(
				"subagent_handoff_invalid",
			);
			await fixtureNote(h, [old.taskId, current.taskId], 2);
			const captured = captureSubagentHandoff(h.sessionManager, scope, [active]);
			const terminal = { ...active, status: "completed" as const, completedAt: "later" };
			expect(
				captureSubagentHandoff(h.sessionManager, scope, [terminal], captured.requiredTaskIds).requiredTaskIds,
			).toEqual(captured.requiredTaskIds);
			h.sessionManager.branch(originalUser);
			const siblingScope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
			expect(captureSubagentHandoff(h.sessionManager, siblingScope, []).subagentTasks).toEqual([]);
			expect(() => captureSubagentHandoff(h.sessionManager, siblingScope, [active])).toThrow(
				"subagent_handoff_invalid",
			);
		} finally {
			await h.cleanup();
		}
	});

	it("paginates 21 original delegations and verifies complete semantic bodies rather than IDs", async () => {
		const h = await createHarness();
		try {
			const taskSourceEntryId = beginFixture(h);
			const ids = Array.from({ length: 21 }, (_, index) => `child-${index}`);
			const refs = ids.map((id, index) =>
				seedDelegation(
					h,
					id,
					index === 0 ? `${delegatedPrompt}\n${"中😀 constraints ".repeat(1500)}` : delegatedPrompt,
				),
			);
			const note = await fixtureNote(h, ids);
			const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
			const handoff = captureSubagentHandoff(h.sessionManager, scope, []);
			expect(handoff.subagentTasks).toEqual(refs);
			expect(handoff.requiredTaskIds).toEqual(ids);
			const records = subagentRecoveryRecords(h.sessionManager, handoff, note);
			const notePage = queryTaskNotes(h.sessionManager, 1, { operation: "query", item: note.eventId });
			expect(estimateTextTokens(JSON.stringify(notePage))).toBeLessThanOrEqual(2048);
			const recovery: ContextRecoveryReferences = {
				...handoff,
				saveStateOperationId: "save",
				nextActionEventId: note.eventId,
				relatedNoteEventIds: [],
				noteFreshness: [{ eventId: note.eventId, freshness: note.freshness }],
				requiredHistoryRefs: [],
				requirementSourceRefs: [{ entryId: taskSourceEntryId, blockIndex: -1 }],
				todoIds: [],
				taskSourceEntryId,
				requirementsStartEntryId: taskSourceEntryId,
				historyCutoffEntryId: h.sessionManager.getLeafId()!,
				historyStartEntryId: taskSourceEntryId,
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				taskNoteProjectionRevision: String(notePage.revision),
				taskScopeId: scope.taskScopeId,
			};
			const rolloverId = randomUUID();
			h.sessionManager.appendContextRollover({
				rolloverId,
				dispatchId: "dispatch",
				requestId: "request",
				cause: "model_requested",
				windowId: randomUUID(),
				previousWindowId: h.sessionManager.ensureContextWindow().windowId,
				promptGeneration: 1,
				sourceContextEpoch: 0,
				targetContextEpoch: 1,
				recovery,
				expectedRevisions: {
					sessionLeafId: h.sessionManager.getLeafId(),
					sourceFingerprint: "source",
					todoStateEntryId: null,
					todoStateFingerprint: recovery.todoStateFingerprint,
					queueRevision: "queue",
					progressRevision: "progress",
					requestConfigFingerprint: "config",
					taskNoteProjectionRevision: recovery.taskNoteProjectionRevision,
				},
				sourceTokens: 50000,
				preparedTokens: 2000,
				configuredContextWindow: 128000,
				sourceRequestFingerprint: "source",
				preparedRequestFingerprint: "prepared",
				preparationBaseFingerprint: "base",
				reservedDeliveryIds: [],
			});
			const readPages: Record<string, unknown>[] = [];
			let cursor: string | undefined;
			do {
				const page = queryTaskNotes(h.sessionManager, 1, {
					operation: "query",
					resumeRef: rolloverId,
					cursor,
					budgetTokens: 512,
					verify: true,
				});
				expect(estimateTextTokens(JSON.stringify(page))).toBeLessThanOrEqual(512);
				readPages.push(page);
				cursor = typeof page.cursor === "string" ? page.cursor : undefined;
				expect(readPages.length).toBeLessThan(120);
			} while (cursor);
			expect(readPages.length).toBeGreaterThan(21);
			const messages: Message[] = readPages.map((page, index) => ({
				role: "toolResult",
				toolCallId: `read-${index}`,
				toolName: "context_note",
				content: [{ type: "text", text: JSON.stringify(page) }],
				details: page,
				isError: false,
				timestamp: index,
			}));
			const coverage = contextRecoveryCoverage(h.sessionManager, messages, recovery);
			expect(coverage.missing.filter((item) => item.startsWith("subagent:"))).toEqual([]);
			const altered = messages.map((message) =>
				message.role !== "toolResult"
					? message
					: {
							...message,
							content: message.content.map((block) =>
								block.type !== "text"
									? block
									: { ...block, text: block.text.replace("Inspect input.txt", "Ignore input.txt") },
							),
						},
			);
			expect(contextRecoveryCoverage(h.sessionManager, altered, recovery).missing).toContain("subagent:child-0");
			expect(() =>
				subagentRecoveryRecords(h.sessionManager, { ...handoff, subagentTasks: refs.slice(1) }, note),
			).toThrow("subagent_handoff_invalid");
			expect(() =>
				subagentRecoveryRecords(
					h.sessionManager,
					{ ...handoff, subagentTasks: [{ ...refs[0], sourceEntryId: taskSourceEntryId }, ...refs.slice(1)] },
					note,
				),
			).toThrow("subagent_handoff_invalid");
			const reconstructed = readPages
				.flatMap((page) => page.items as Record<string, unknown>[])
				.filter((item) => item.type === "subagent_task" && item.taskId === ids[0])
				.map((item) => item.text)
				.join("");
			expect(reconstructed).toBe(records[0].text);
			const rollover = h.sessionManager.getBranch().find((entry) => entry.type === "context_rollover");
			if (rollover?.type !== "context_rollover") throw new Error("Missing record");
			expect(validateCommittedRecovery(h.sessionManager, rollover)).toBe(true);
			expect(
				validateCommittedRecovery(h.sessionManager, {
					...rollover,
					recovery: { ...recovery, subagentTasks: [], requiredTaskIds: [] },
				}),
			).toBe(false);
		} finally {
			await h.cleanup();
		}
	});

	it.each(["running", "cancelling", "completed", "blocked", "failed", "cancelled"] as const)(
		"uses provenance and Note semantics, not terminal status, for %s",
		async (status) => {
			const h = await createHarness();
			try {
				beginFixture(h);
				seedDelegation(h, "child");
				const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
				const base = {
					taskId: "child",
					kind: "subagent" as const,
					description: "inspect",
					ownerSessionId: h.session.sessionId,
					archiveRole: "dependency" as const,
					startedAt: "now",
				};
				const task =
					status === "running" || status === "cancelling"
						? { ...base, status }
						: status === "completed"
							? { ...base, status, completedAt: "now" }
							: status === "blocked"
								? { ...base, status, completedAt: "now", result: {}, errorMessage: "blocked" }
								: { ...base, status, completedAt: "now", errorMessage: status };
				expect(() => captureSubagentHandoff(h.sessionManager, scope, [task])).toThrow("subagent_handoff_invalid");
				await fixtureNote(h, ["child"]);
				expect(captureSubagentHandoff(h.sessionManager, scope, [task]).requiredTaskIds).toEqual(["child"]);
				expect(() =>
					captureSubagentHandoff(h.sessionManager, scope, [{ ...task, ownerSessionId: "another-session" }]),
				).toThrow("subagent_handoff_invalid");
			} finally {
				await h.cleanup();
			}
		},
	);

	it("gives the incomplete parent tool batch priority over missing semantic mappings", async () => {
		const h = await createHarness();
		try {
			beginFixture(h);
			const call = fauxToolCall("task", {
				description: "foreground",
				prompt: delegatedPrompt,
				subagent_type: "explore",
				run_in_background: false,
			});
			h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			expect(h.session.getContextTransitionGate()).toEqual({ status: "busy" });
			h.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "task",
				content: [{ type: "text", text: "still running task child" }],
				details: { taskId: "child" },
				isError: false,
				timestamp: 1,
			});
			expect(h.session.getContextTransitionGate()).toEqual({
				status: "invalid",
				reason: "subagent_handoff_invalid",
			});
			await fixtureNote(h, ["child"]);
			expect(h.session.getContextTransitionGate()).toMatchObject({ status: "ready", requiredTaskIds: ["child"] });
		} finally {
			await h.cleanup();
		}
	});
});
