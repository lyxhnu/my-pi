import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("memory_search / memory_get (M5)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("is omitted when memory is disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).not.toContain("memory_search");
		expect(allToolNames).not.toContain("memory_get");
	});

	it("registers and activates memory tools when enabled with the default tool set", async () => {
		const harness = await createHarness({ settings: { memory: { enabled: true } } });
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).toContain("memory_search");
		expect(allToolNames).toContain("memory_get");
		expect(harness.session.getActiveToolNames()).toContain("memory_search");
		expect(harness.session.getActiveToolNames()).toContain("memory_get");
	});

	it("stores writes under a workspace-hashed project directory, never the real home directory", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			initialActiveToolNames: ["memory_search", "memory_get"],
		});
		harnesses.push(harness);
		expect(harness.session.memoryStore.rootDir).toContain(harness.tempDir);
		expect(harness.session.memoryStore.rootDir).not.toContain("/.pi/agent/memory");
	});

	it("finds an active project record and reads it back by memory ID", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			initialActiveToolNames: ["memory_search", "memory_get"],
		});
		harnesses.push(harness);
		harness.session.memoryAuthority.startRun({ rootPromptId: "seed-run", sessionId: harness.session.sessionId });
		harness.session.memoryAuthority.recordEvidence({
			sourceId: "user-build-rule",
			rootPromptId: "seed-run",
			sessionId: harness.session.sessionId,
			origin: "user",
			content: "The build command is npm run build.",
			contentHash: "test-hash",
			visibility: "project_rule",
			completeness: "complete",
			sequence: 0,
		});
		const record = harness.session.memoryAuthority.commitRecord({
			candidateKey: "build-command",
			kind: "user_rule",
			subject: "build",
			text: "The build command is `npm run build`.",
			scope: { project: true },
			status: "active",
			sourceRefs: [
				{
					sourceId: "user-build-rule",
					origin: "user",
					contentHash: "test-hash",
					completeness: "complete",
				},
			],
			verification: { level: "user_asserted", checkedAt: new Date().toISOString(), validatedSourceRevision: 1 },
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_search", { query: "build command" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("found it"),
		]);
		await harness.session.prompt("how do I build this repo?");
		const searchResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		const searchText = getMessageText(searchResult);
		expect(searchText).toContain("npm run build");
		expect(searchText).toContain(record.memoryId);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_get", { memoryId: record.memoryId }), { stopReason: "toolUse" }),
			fauxAssistantMessage("read it"),
		]);
		await harness.session.prompt("read that file");
		const getResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(getMessageText(getResult)).toContain("npm run build");
	});

	it("discards (does not write) a candidate that looks like a secret", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const result = harness.session.memoryStore.appendProject(harness.tempDir, [
			"API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
		]);
		expect(result.written).toBe(0);
		expect(result.skipped).toBe(1);
		const hits = await harness.session.memoryStore.search("API_KEY", "project", harness.tempDir, 10);
		expect(hits).toHaveLength(0);
	});

	it("memory_get has no path input and rejects unknown record IDs", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			initialActiveToolNames: ["memory_get"],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_get", { memoryId: "mem-from-another-project" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read an unavailable memory id");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
	});

	it("undo() tombstones a global memory entry so it no longer surfaces in search", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const result = harness.session.memoryStore.appendGlobal(["Always run tests before committing."]);
		expect(result.written).toBe(1);
		expect(await harness.session.memoryStore.search("committing", "global", harness.tempDir, 10)).toHaveLength(1);

		const undone = harness.session.memoryStore.undo("global", undefined, result.ids[0]!);
		expect(undone).toBe(true);
		expect(await harness.session.memoryStore.search("committing", "global", harness.tempDir, 10)).toHaveLength(0);
	});
});
