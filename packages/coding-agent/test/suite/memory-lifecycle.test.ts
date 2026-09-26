import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	MemoryStore,
	projectMemoryDir,
	projectMemoryFile,
	projectSessionsDir,
} from "../../src/core/memory/memory-store.ts";
import { checkMemoryCandidate } from "../../src/core/memory/secret-filter.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("memory-context-integrity: effective memory", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("M01 rejects unsafe session notes before persistence", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const result = h.session.memoryStore.writeSessionNote(
			h.tempDir,
			"note",
			"session",
			"API_KEY=dummy-test-value",
			"compact-test",
		);
		expect(result).toMatchObject({ written: 0, skipped: 1 });
		expect(await h.session.memoryStore.search("API_KEY", "project", h.tempDir)).toEqual([]);
	});

	it("M03 never includes the rejected value in reason metadata", () => {
		const secret = "abCDef0123xyZ456pqRS789tuvWX";
		const result = checkMemoryCandidate(secret);
		expect(result.safe).toBe(false);
		expect(result.reason).not.toContain(secret.slice(0, 8));
	});
	it("M02/M03 uses fixed errors for corrupt note metadata and consolidation JSON", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.memoryStore;
		const note = store.writeSessionNote(h.tempDir, "note", "session", "safe body", "compact");
		const notePath = join(store.rootDir, note.path!);
		const original = readFileSync(notePath, "utf8");
		const invalid = "API_KEY=simulated-parser-secret";
		writeFileSync(notePath, `<!-- memory-note:${invalid} -->\nsafe body`);
		expect(() => store.get(notePath)).toThrow(new Error("Invalid memory note metadata"));
		writeFileSync(notePath, original);
		const dir = projectMemoryDir(store.rootDir, h.tempDir);
		writeFileSync(join(dir, ".dream-state.json"), invalid);
		await expect(store.maybeConsolidate({ cwd: h.tempDir, summarize: () => ({ facts: [] }) })).rejects.toThrow(
			new Error("Invalid memory consolidation state"),
		);
		writeFileSync(join(dir, ".dream-state.json"), JSON.stringify({ lastConsolidatedAt: 0, processed: {} }));
		writeFileSync(join(dir, ".dream-commit.json"), invalid);
		await expect(store.maybeConsolidate({ cwd: h.tempDir, summarize: () => ({ facts: [] }) })).rejects.toThrow(
			new Error("invalid_memory_commit"),
		);
	});

	it("M05 direct reads and reopened stores honor tombstones without rewriting raw data", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.memoryStore;
		const { ids } = store.appendProject(h.tempDir, ["obsolete build instruction", "keep this instruction"]);
		const path = projectMemoryFile(store.rootDir, h.tempDir);
		const original = readFileSync(path, "utf8");
		expect(store.undo("project", h.tempDir, ids[0]!)).toBe(true);
		for (const reader of [store, new MemoryStore(store.rootDir)]) {
			expect(reader.get(path)).not.toContain("obsolete");
			expect(reader.get(path)).toContain("keep this instruction");
			expect(await reader.search("obsolete", "project", h.tempDir)).toEqual([]);
		}
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("M02/M08 filters unsafe disk content while preserving mixed manual Markdown", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.memoryStore;
		store.appendGlobal(["placeholder"]);
		writeFileSync(
			join(store.rootDir, "MEMORY.md"),
			"人工说明\r\n<!-- id:safe -->\r\n## Safe\r\n保留正文\r\n<!-- id:unsafe -->\r\nAPI_KEY=dummy-value\r\n",
		);
		expect(store.get("MEMORY.md")).toContain("人工说明");
		expect(store.get("MEMORY.md")).toContain("保留正文");
		expect(store.get("MEMORY.md")).not.toContain("API_KEY");
		expect(await store.search("API_KEY", "global", h.tempDir)).toEqual([]);
		writeFileSync(join(store.rootDir, "MEMORY.md"), "");
		expect(store.get("MEMORY.md")).toBe("");
		expect(await store.search("anything", "global", h.tempDir)).toEqual([]);
	});

	it("M09 corrupt tombstones fail closed", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.memoryStore;
		store.appendGlobal(["old entry"]);
		writeFileSync(join(store.rootDir, "MEMORY.md.tombstones.json"), "broken");
		expect(() => store.get("MEMORY.md")).toThrow();
		await expect(store.search("entry", "global", h.tempDir)).rejects.toThrow();
	});
	it("M09 rejects paths and directory links escaping the memory root", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.memoryStore;
		store.appendProject(h.tempDir, ["safe rule"]);
		const external = join(h.tempDir, "outside-memory");
		mkdirSync(external);
		writeFileSync(join(external, "note.md"), "external project rule");
		const sessions = projectSessionsDir(store.rootDir, h.tempDir);
		symlinkSync(external, sessions, "junction");
		expect(store.get(join(sessions, "note.md"))).toBeUndefined();
		expect(store.get(join("..", "outside-memory", "note.md"))).toBeUndefined();
		await expect(store.search("rule", "project", h.tempDir)).rejects.toThrow("outside scope");
	});

	it("M01/M04 applies write rules equally without rejecting ordinary paths or variable names", async () => {
		const h = await createHarness();
		harnesses.push(h);
		for (const append of [
			(text: string) => h.session.memoryStore.appendGlobal([text]),
			(text: string) => h.session.memoryStore.appendProject(h.tempDir, [text]),
		]) {
			expect(append("API_KEY=simulated-secret")).toMatchObject({
				written: 0,
				skipped: 1,
				reasons: ["secret_pattern"],
			});
			expect(append("Read src/config.ts; use the API_KEY variable from the environment.")).toMatchObject({
				written: 1,
				skipped: 0,
			});
		}
	});
	it("M01/M03 rejects manual flush and compaction output with safe result metadata", async () => {
		const simulatedSecret = "API_KEY=simulated-secret";
		const h = await createHarness({
			tools: [],
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
			memoryArchiveExtractor: {
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [
						{
							candidateKey: "unsafe",
							kind: "implementation_fact",
							subject: "unsafe",
							text: simulatedSecret,
							scope: { project: true },
							sourceIds: [sources[0]!.sourceId],
						},
					],
				}),
			},
		});
		harnesses.push(h);
		await h.session.prompt("keep project rules");
		await h.session.prompt("next rule");
		const result = await h.session.flushMemoryNow();
		expect(result).toMatchObject({
			attempted: true,
			status: "deferred",
			written: 0,
			reasons: ["unsafe_memory_record"],
		});
		expect(JSON.stringify(result)).not.toContain("simulated-secret");
		const archiveBeforeCompaction = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "trace" && entry.event.type === "memory/archive");
		h.setResponses([fauxAssistantMessage("turn summary")]);
		await h.session.compact();
		const archive = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "trace" && entry.event.type === "memory/archive");
		expect(archive.map((entry) => entry.id)).toEqual(archiveBeforeCompaction.map((entry) => entry.id));
		expect(JSON.stringify(archive)).not.toContain("simulated-secret");
		expect(await h.session.memoryStore.search("API_KEY", "project", h.tempDir)).toEqual([]);
	});

	it("M06/M07/K02 excludes revoked vectors during async search and caches unchanged document embeddings", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const inputs: string[][] = [];
		let onEmbed: (() => void) | undefined;
		const store = new MemoryStore(h.session.memoryStore.rootDir, {
			model: "fake-vector",
			embed: async (texts) => {
				inputs.push(texts);
				onEmbed?.();
				return texts.map(() => [1, 0]);
			},
		});
		const { ids } = store.appendProject(h.tempDir, ["obsolete atomic state", "current atomic state"]);
		await store.search("atomic", "project", h.tempDir);
		const documentCalls = inputs.filter((batch) => batch.some((text) => text.includes("state"))).length;
		await store.search("atomic", "project", h.tempDir);
		expect(inputs.filter((batch) => batch.some((text) => text.includes("state")))).toHaveLength(documentCalls);
		onEmbed = () => {
			onEmbed = undefined;
			store.undo("project", h.tempDir, ids[0]);
		};
		const hits = await store.search("atomic", "project", h.tempDir);
		expect(JSON.stringify(hits)).not.toContain("obsolete");
		expect(JSON.stringify(hits)).toContain("current");
		writeFileSync(
			projectMemoryFile(store.rootDir, h.tempDir),
			"<!-- id:unsafe -->\nAPI_KEY=simulated-secret\n<!-- id:safe -->\ncurrent atomic state",
		);
		inputs.length = 0;
		await store.search("atomic", "project", h.tempDir);
		expect(JSON.stringify(inputs)).not.toContain("API_KEY");
	});
});
