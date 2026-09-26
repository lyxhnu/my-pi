import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceHash } from "../../../src/core/memory/memory-store.ts";
import { createHarness, type Harness } from "../harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(harness: Harness, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(""),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

/** Seeds a session with history for an explicit manual summary. */
function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, 100);
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** Replaces the streamFn so compact()'s summary generation resolves immediately with `summary`. */
function useSummaryStreamFn(harness: Harness, summary: string): void {
	harness.session.agent.streamFunction = (model, context) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(
					context.systemPrompt?.includes("Extract durable")
						? JSON.stringify({
								facts: [
									{
										text: "Durable project decision",
										sourceNoteIds: (
											JSON.parse(context.messages[0].content as string) as Array<{ id: string }>
										).map((note) => note.id),
									},
								],
							})
						: summary,
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("manual compaction and Memory flush", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("manual flush seals the closed evidence run without compacting the session", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [
						{
							candidateKey: "manual-flush-rule",
							kind: "user_rule",
							subject: "manual flush",
							text: "Keep the durable project convention.",
							scope: { project: true },
							sourceIds: [sources.find((source) => source.origin === "user")!.sourceId],
						},
					],
				}),
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("recorded")]);
		await harness.session.prompt("Keep the durable project convention.");
		const messagesBefore = harness.session.agent.state.messages.length;

		const result = await harness.session.flushMemoryNow();

		expect(result.attempted).toBe(true);
		expect(result.written).toBe(1);
		expect(harness.session.agent.state.messages.length).toBe(messagesBefore);
		expect(harness.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(false);
		expect(harness.session.memoryAuthority.search("durable project", { cwd: harness.tempDir })).toHaveLength(1);
	});

	it("manual flush reports attempted:false (rather than throwing) when there is nothing new to summarize", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		// A brand-new session has no messages at all.
		const result = await harness.session.flushMemoryNow();
		expect(result.attempted).toBe(false);
		expect(result.written).toBe(0);
	});

	it("does nothing autoDream-related when memory.enabled is left at its default (false)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "unwitnessed summary");

		await harness.session.compact();

		expect(existsSync(harness.session.memoryStore.rootDir)).toBe(false);
	});

	it("manual compaction does not create or consolidate legacy session notes", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { memory: { enabled: true } },
		});
		harnesses.push(harness);
		// Existing legacy session notes stay untouched.
		harness.session.memoryStore.writeSessionNote(
			harness.tempDir,
			"earlier-a",
			"sidaaaaaaaa",
			"# earlier session a",
			"compact-a",
		);
		harness.session.memoryStore.writeSessionNote(
			harness.tempDir,
			"earlier-b",
			"sidbbbbbbbb",
			"# earlier session b",
			"compact-b",
		);

		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "dreamable summary");

		await harness.session.compact();

		const sessionsDir = join(harness.session.memoryStore.rootDir, workspaceHash(harness.tempDir), "sessions");
		const noteFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
		expect(noteFiles.length).toBe(2);

		const consolidated = await harness.session.memoryStore.search(
			"Consolidated memory",
			"project",
			harness.tempDir,
			10,
		);
		expect(consolidated).toHaveLength(0);
		const globalHits = await harness.session.memoryStore.search("Consolidated memory", "global", harness.tempDir, 10);
		expect(globalHits).toHaveLength(0); // never auto-writes global (spec 10.5)
	});
});
