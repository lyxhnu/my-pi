import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact } from "../../src/core/compaction/compaction.ts";
import { projectSessionsDir } from "../../src/core/memory/memory-store.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("memory-context-integrity: cross-module boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) await h.cleanup();
	});
	it("C02/C03 passes inherited constraints into three consecutive normal summaries", async () => {
		const h = await createHarness();
		harnesses.push(h);
		let previousSummary = "Constraint: never publish without approval.";
		for (let round = 0; round < 3; round++) {
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context)).toContain(JSON.stringify(previousSummary).slice(1, -1));
					return fauxAssistantMessage(`${previousSummary}\nPending step ${round}`);
				},
			]);
			const preparation: CompactionPreparation = {
				firstKeptEntryId: "kept",
				previousSummary,
				isSplitTurn: false,
				tokensBefore: 1000,
				messagesToSummarize: [{ role: "user", content: `next ${round}`, timestamp: round }],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
			};
			const result = await compact(
				preparation,
				h.getModel(),
				"faux-key",
				undefined,
				undefined,
				undefined,
				undefined,
				streamSimple,
			);
			previousSummary = result.summary;
			expect(previousSummary).toContain("never publish without approval");
		}
	});

	it.each(["empty", "boundary", "changed"])(
		"C07/E04 rejects invalid extension commit (%s) without notes",
		async (kind) => {
			const h = await createHarness({
				tools: [],
				settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							if (kind === "changed")
								h.sessionManager.appendMessage({ role: "user", content: "branch changed", timestamp: 2 });
							return {
								compaction: {
									summary: kind === "empty" ? " " : "valid summary",
									firstKeptEntryId: kind === "boundary" ? "missing-id" : event.preparation.firstKeptEntryId,
									tokensBefore: 10,
								},
							};
						});
					},
				],
			});
			harnesses.push(h);
			await h.session.prompt("first");
			await h.session.prompt("second");
			await expect(h.session.compact()).rejects.toThrow("Invalid or stale compaction result");
			expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(existsSync(projectSessionsDir(h.session.memoryStore.rootDir, h.tempDir))).toBe(false);
		},
	);

	it("C04 manual compaction commits once and does not create archive evidence", async () => {
		const h = await createHarness({
			tools: [],
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Approved project convention",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 10,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		await h.session.prompt("first");
		await h.session.prompt("second");
		await h.session.compact();
		const before = h.faux.state.callCount;
		await expect(h.session.compact()).rejects.toThrow("Already compacted");
		expect(h.faux.state.callCount).toBe(before);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(existsSync(projectSessionsDir(h.session.memoryStore.rootDir, h.tempDir))).toBe(false);
	});
	it("C05/E04 rolls back a failed compaction entry write without replacing context or writing notes", async () => {
		const h = await createHarness({
			persistSession: true,
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(h);
		await h.session.prompt("first constraint");
		await h.session.prompt("next step");
		const originalFile = readFileSync(h.session.sessionFile!, "utf8");
		const messages = JSON.stringify(h.session.messages);
		const leaf = h.sessionManager.getLeafId();
		const persist = h.sessionManager._persist.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "_persist").mockImplementation((entry) => {
			if (entry.type === "compaction") throw new Error("simulated disk failure");
			persist(entry);
		});
		h.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("turn summary")]);
		await expect(h.session.compact()).rejects.toThrow("simulated disk failure");
		expect(h.sessionManager.getLeafId()).toBe(leaf);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(h.session.messages)).toBe(messages);
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(originalFile);
		expect(existsSync(projectSessionsDir(h.session.memoryStore.rootDir, h.tempDir))).toBe(false);
	});

	it.each(["steer", "followUp"] as const)("B03 enforces queued %s input exactly once", async (queue) => {
		let h: Harness;
		let executions = 0;
		const queuedText = "queued constraint ".repeat(20000);
		const tool: AgentTool = {
			name: "queue",
			label: "queue",
			description: "queue",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				await h.session[queue](queuedText);
				return { content: [{ type: "text", text: "queued" }], details: {} };
			},
		};
		h = await createHarness({
			tools: [tool],
			models: [{ id: "small", contextWindow: 20000, maxTokens: 1000 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("queue", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("not sent"),
		]);
		await h.session.prompt("queue input");
		expect(executions).toBe(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
		expect(
			h.session.messages.filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("queued constraint"),
			),
		).toHaveLength(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "delivery_receipt")).toHaveLength(1);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("B02 persists and bounds every parallel tool result before sending the next request", async () => {
		const runs: string[] = [];
		const tools: AgentTool[] = ["first", "second"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => {
				runs.push(name);
				return { content: [{ type: "text" as const, text: "stored result\n".repeat(1700) }], details: {} };
			},
		}));
		const h = await createHarness({
			tools,
			models: [{ id: "small", contextWindow: 16000, maxTokens: 1000 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not send"),
		]);
		await h.session.prompt("both");
		expect(runs.sort()).toEqual(["first", "second"]);
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "tool_result_source")).toHaveLength(2);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});

	it("B10 cancels during final transform without provider work", async () => {
		const h = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("context", () => {
						h.session.agent.abort();
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("not sent")]);
		await h.session.prompt("cancel");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "aborted" } });
	});

	it("D13 keeps compaction independent from archive persistence", async () => {
		const h = await createHarness({
			tools: [],
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Durable project convention",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 10,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		await h.session.prompt("first");
		await h.session.prompt("second");
		await h.session.compact();
		expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({
			aborted: false,
			result: { summary: "Durable project convention" },
		});
		expect(h.session.messages[1].role).toBe("compactionSummary");
		expect(
			h.sessionManager.getEntries().some((entry) => entry.type === "trace" && entry.event.type === "memory/archive"),
		).toBe(false);
	});
});
