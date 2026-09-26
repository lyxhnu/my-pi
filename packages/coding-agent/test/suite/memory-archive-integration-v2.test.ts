import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("memory archive AgentSession integration", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("archives a top-level run after settle without a compaction", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true, archive: { enabled: true } } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [
						{
							candidateKey: "project-package-manager",
							kind: "user_rule",
							subject: "package-manager",
							text: "Use npm for this project.",
							scope: { project: true },
							sourceIds: [sources.find((source) => source.origin === "user")!.sourceId],
						},
					],
				}),
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("I will use npm.")]);

		await harness.session.prompt("Always use npm for this project.");
		await harness.session.drainMemoryArchive();

		expect(harness.session.memoryAuthority.search("npm", { cwd: harness.tempDir })).toEqual([
			expect.objectContaining({ kind: "user_rule", text: "Use npm for this project." }),
		]);
	});

	it("persists raw evidence as log-only session entries", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true, archive: { enabled: true } } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("private evidence text");
		const evidenceEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "memory_evidence");
		expect(evidenceEntries).toEqual([
			expect.objectContaining({ origin: "user", content: "private evidence text", deliveryState: "pending" }),
			expect.objectContaining({ origin: "user", content: "private evidence text", deliveryState: "delivered" }),
			expect.objectContaining({ origin: "assistant", visibility: "session" }),
		]);
		const rootPromptId = evidenceEntries[0]!.rootPromptId;
		expect(harness.session.memoryAuthority.getRun(rootPromptId)?.sourceIds).toHaveLength(2);
		const delivered = evidenceEntries.find((entry) => entry.deliveryState === "delivered")!;
		expect(harness.session.memoryAuthority.getEvidenceSource(delivered.evidenceEventId)?.entryId).toBe(
			delivered.sourceEntryId,
		);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "memory_evidence")).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("reconciles a persisted evidence event left pending by a crash", async () => {
		const first = await createHarness({
			persistSession: true,
			settings: { memory: { enabled: true, archive: { enabled: true } } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
		});
		harnesses.push(first);
		first.setResponses([fauxAssistantMessage("initial")]);
		await first.session.prompt("initial request");
		const rootPromptId = "pending-crash-run";
		const evidenceEventId = "pending-crash-evidence";
		first.session.memoryAuthority.startRun({ rootPromptId, sessionId: first.session.sessionId });
		first.sessionManager.appendMemoryEvidence({
			evidenceEventId,
			rootPromptId,
			origin: "tool",
			content: "persisted before authority completion",
			visibility: "session",
		});
		first.session.memoryAuthority.beginEvidence(rootPromptId, evidenceEventId);
		expect(first.session.memoryAuthority.getRun(rootPromptId)?.pendingEvidenceIds).toEqual([evidenceEventId]);

		const second = await createHarness({
			sessionFile: first.session.sessionFile,
			memoryRootDir: join(first.tempDir, "memory"),
			settings: { memory: { enabled: true, archive: { enabled: true } } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
		});
		harnesses.push(second);
		expect(second.session.memoryAuthority.getRun(rootPromptId)).toMatchObject({
			pendingEvidenceIds: [],
			sourceIds: [evidenceEventId],
			continuationState: "outcome_unknown",
		});
	});

	it("uses separate strict extraction and validation model calls with no tools", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true, archive: { enabled: true } } },
		});
		harnesses.push(harness);
		let sourceIds: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("Recorded the convention."),
			(context) => {
				expect(context.tools ?? []).toEqual([]);
				const payload = JSON.parse(context.messages[0]!.content as string) as Array<{ sourceId: string }>;
				sourceIds = payload.map((source) => source.sourceId);
				return fauxAssistantMessage(
					JSON.stringify({
						checkedSourceIds: sourceIds,
						uncheckedSourceIds: [],
						candidates: [
							{
								candidateKey: "project-package-manager-model",
								kind: "user_rule",
								subject: "package-manager",
								text: "Use npm for package management.",
								scope: { project: true },
								sourceIds: [sourceIds[0]],
							},
						],
					}),
				);
			},
			(context) => {
				expect(context.tools ?? []).toEqual([]);
				const payload = JSON.parse(context.messages[0]!.content as string) as {
					sources: Array<{ sourceId: string }>;
				};
				return fauxAssistantMessage(
					JSON.stringify({
						candidateKey: "project-package-manager-model",
						supportCheck: "passed",
						counterEvidenceCheck: "passed",
						checkedSourceIds: payload.sources.map((source) => source.sourceId),
						conflictMemoryIds: [],
						reasonCode: "supported",
					}),
				);
			},
		]);

		await harness.session.prompt("Use npm for package management in this project.");
		await harness.session.drainMemoryArchive();

		expect(harness.session.memoryAuthority.search("package management", { cwd: harness.tempDir })).toEqual([
			expect.objectContaining({ text: "Use npm for package management." }),
		]);
	});

	it("binds background task ownership at spawn time and waits for durable terminal evidence", async () => {
		let harness: Harness;
		let release!: () => void;
		let taskId = "";
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool: AgentTool = {
			name: "start_diagnostic",
			label: "start_diagnostic",
			description: "start diagnostic",
			parameters: Type.Object({}),
			execute: async () => {
				const task = harness.session.taskManager.start({
					kind: "diagnostics",
					description: "diagnostic",
					run: async (context) => {
						await gate;
						context.appendOutput("diagnostic output");
						return { status: "completed", result: "done", exitCode: 0 };
					},
				});
				taskId = task.taskId;
				return { content: [{ type: "text", text: task.taskId }], details: {} };
			},
		};
		harness = await createHarness({
			tools: [tool],
			settings: { memory: { enabled: true, archive: { enabled: true } } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("start_diagnostic", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("diagnostic started"),
		]);

		await harness.session.prompt("start the diagnostic");
		expect(harness.session.taskManager.get(taskId)).toMatchObject({
			ownerSessionId: harness.session.sessionId,
			rootPromptId: expect.any(String),
			archiveRole: "dependency",
		});
		expect(harness.session.getMemoryStatus().jobs.completed).toBe(0);
		release();
		await harness.session.taskManager.awaitSettled(taskId);
		await harness.session.drainMemoryArchive();
		expect(harness.session.getMemoryStatus().jobs.completed).toBe(1);
	});
});
