import { describe, expect, it } from "vitest";
import {
	memoryArchiveExtractionContext,
	validateMemoryArchiveExtraction,
} from "../../src/core/memory/archive-extraction.ts";

describe("memory archive extraction contract", () => {
	it("gives the model the complete strict candidate contract", () => {
		const context = memoryArchiveExtractionContext(
			[
				{
					sourceId: "source-1",
					origin: "user",
					content: "Use npm.",
					visibility: "session",
					rootPromptId: "root-1",
					sessionId: "session-1",
					contentHash: "hash-1",
					completeness: "complete",
					sequence: 0,
				},
			],
			12,
		);

		expect(context.systemPrompt).toContain('"candidateKey"');
		expect(context.systemPrompt).toContain('"kind"');
		expect(context.systemPrompt).toContain('"subject"');
		expect(context.systemPrompt).toContain('"scope"');
		expect(context.systemPrompt).toContain('"sourceIds"');
		expect(context.systemPrompt).toContain('"additionalProperties":false');
		expect(context.systemPrompt).toContain("even when it is irrelevant or not cited by a candidate");
		expect(context.systemPrompt).toContain("missing, filtered, or incomplete");
		expect(context.systemPrompt).toContain('"checkedSourceIds":["source-1"]');
		expect(context.systemPrompt).toContain('"uncheckedSourceIds":[]');
		expect(context.systemPrompt).toContain("release checklists or package management");
		expect(context.systemPrompt).toContain("is not a scene condition");
	});

	it("requires an exact checked/unchecked receipt for every supplied source", () => {
		expect(() =>
			validateMemoryArchiveExtraction(
				{ checkedSourceIds: ["a"], uncheckedSourceIds: [], candidates: [] },
				new Set(["a", "b"]),
				12,
			),
		).toThrow("invalid_memory_archive_extraction");
		expect(() =>
			validateMemoryArchiveExtraction(
				{ checkedSourceIds: ["a"], uncheckedSourceIds: ["a"], candidates: [] },
				new Set(["a"]),
				12,
			),
		).toThrow("invalid_memory_archive_extraction");
	});

	it("rejects extra fields, forged citations, and candidate overflow", () => {
		const candidate = {
			candidateKey: "rule",
			kind: "user_rule",
			subject: "testing",
			text: "Run the targeted test.",
			scope: { project: true },
			sourceIds: ["a"],
		};
		expect(() =>
			validateMemoryArchiveExtraction(
				{ checkedSourceIds: ["a"], uncheckedSourceIds: [], candidates: [{ ...candidate, extra: true }] },
				new Set(["a"]),
				12,
			),
		).toThrow("invalid_memory_archive_extraction");
		expect(() =>
			validateMemoryArchiveExtraction(
				{ checkedSourceIds: ["a"], uncheckedSourceIds: [], candidates: [{ ...candidate, sourceIds: ["b"] }] },
				new Set(["a"]),
				12,
			),
		).toThrow("invalid_memory_archive_extraction");
		expect(() =>
			validateMemoryArchiveExtraction(
				{ checkedSourceIds: ["a"], uncheckedSourceIds: [], candidates: [candidate, candidate] },
				new Set(["a"]),
				1,
			),
		).toThrow("memory_candidate_limit_exceeded");
	});

	it("accepts host-verifiable file and directory hash conditions", () => {
		expect(() =>
			validateMemoryArchiveExtraction(
				{
					checkedSourceIds: ["a"],
					uncheckedSourceIds: [],
					candidates: [
						{
							candidateKey: "hash-bounded-fact",
							kind: "implementation_fact",
							subject: "memory authority",
							text: "The authority uses an atomic state file.",
							scope: { project: true },
							sourceIds: ["a"],
							machineConditions: [
								{ kind: "file_hash", path: "src/memory.ts", hash: "abc" },
								{ kind: "directory_hash", path: "src", hash: "def" },
							],
						},
					],
				},
				new Set(["a"]),
				12,
			),
		).not.toThrow();
	});
});
