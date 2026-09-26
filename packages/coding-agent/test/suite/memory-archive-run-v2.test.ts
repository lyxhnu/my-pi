import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryArchiveService } from "../../src/core/memory/archive-service.ts";

describe("long-term memory archive runs", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.useRealTimers();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createService() {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-archive-"));
		roots.push(root);
		return new MemoryArchiveService(root, join(root, "workspace"), {
			extract: async (sources) => ({
				checkedSourceIds: sources.map((source) => source.sourceId),
				uncheckedSourceIds: [],
				candidates: [
					{
						candidateKey: "project-test-rule",
						kind: "user_rule" as const,
						subject: "testing",
						text: "Run targeted tests after code changes.",
						scope: { project: true as const },
						sourceIds: [sources[0]!.sourceId],
					},
				],
			}),
		});
	}

	it("archives a settled run once without requiring compaction", async () => {
		const service = createService();
		service.startRun({ rootPromptId: "run-1", sessionId: "session-1" });
		service.recordEvidence("run-1", {
			sourceId: "user-1",
			origin: "user",
			content: "For this project, run targeted tests after code changes.",
			visibility: "project_rule",
		});
		service.settleRun("run-1", "completed");

		expect(service.checkArchiveEligibility("run-1")).toMatchObject({ status: "ready" });
		const first = service.sealRun("run-1");
		const second = service.sealRun("run-1");
		expect(second.jobId).toBe(first.jobId);

		expect(await service.processNext()).toMatchObject({ status: "completed", accepted: 1 });
		expect(service.authority.getEffectiveMemoryView({})).toEqual([
			expect.objectContaining({ text: "Run targeted tests after code changes.", status: "active" }),
		]);
	});

	it("waits for the persisted hourly model budget without counting a failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-budget-"));
		roots.push(root);
		const service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
			{ maxModelCallsPerProjectHour: 1 },
		);
		for (const index of [1, 2]) {
			const runId = `run-${index}`;
			service.startRun({ rootPromptId: runId, sessionId: "session-1" });
			service.recordEvidence(runId, {
				sourceId: `source-${index}`,
				origin: "user",
				content: `rule ${index}`,
				visibility: "session",
			});
			service.settleRun(runId, "completed");
			service.sealRun(runId);
		}

		expect(await service.processNext()).toMatchObject({ status: "completed" });
		const waiting = await service.processNext();
		expect(waiting).toMatchObject({ status: "budget_wait" });
		expect(service.authority.getJob(waiting.jobId!)).toMatchObject({
			status: "waiting_budget",
			failureCount: 0,
		});
		expect(service.authority.getStatus()).toMatchObject({
			jobs: { waiting_budget: 1 },
			nextSchedulableAt: waiting.retryAt,
			technicalFailures: 0,
		});
	});

	it("does not treat reaching the candidate limit as complete extraction", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-candidate-limit-"));
		roots.push(root);
		const service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [
						{
							candidateKey: "at-limit",
							kind: "user_rule",
							subject: "candidate limit",
							text: "Do not swallow a full candidate page.",
							scope: { project: true },
							sourceIds: [sources[0]!.sourceId],
						},
					],
				}),
			},
			{ maxCandidatesPerBatch: 1 },
		);
		service.startRun({ rootPromptId: "run-limit", sessionId: "session-1" });
		service.recordEvidence("run-limit", {
			sourceId: "source-limit",
			origin: "user",
			content: "candidate limit evidence",
			visibility: "session",
		});
		service.settleRun("run-limit", "completed");
		const job = service.sealRun("run-limit");

		expect(await service.processNext()).toMatchObject({ status: "needs_review", jobId: job.jobId });
		expect(service.authority.getJob(job.jobId)).toMatchObject({
			status: "needs_review",
			reasonCode: "memory_candidate_limit_reached",
			accepted: 0,
			failureCount: 0,
		});
	});

	it("keeps assistant self-reports out of discovery but includes them in counterevidence validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-extraction-pages-"));
		roots.push(root);
		const extractionPages: string[][] = [];
		const validationPages: string[][] = [];
		const service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => {
					extractionPages.push(sources.map((source) => source.sourceId));
					return {
						checkedSourceIds: [sources[0]!.sourceId],
						uncheckedSourceIds: [],
						candidates: [
							{
								candidateKey: "paged-rule",
								kind: "user_rule",
								subject: "release checklist",
								text: "Start release checklists with COPPER-LANTERN.",
								scope: { project: true },
								sourceIds: [sources[0]!.sourceId],
							},
						],
					};
				},
				validate: async (candidate, sources) => {
					validationPages.push(sources.map((source) => source.sourceId));
					return {
						candidateKey: candidate.candidateKey,
						supportCheck: "passed",
						counterEvidenceCheck: "passed",
						checkedSourceIds: sources.map((source) => source.sourceId),
						conflictMemoryIds: [],
						reasonCode: "supported",
					};
				},
			},
			{ maxModelCallsPerProjectHour: 10 },
		);
		service.startRun({ rootPromptId: "run-pages", sessionId: "session-1" });
		service.recordEvidence("run-pages", {
			sourceId: "source-rule",
			origin: "user",
			content: "Use COPPER-LANTERN.",
			visibility: "session",
		});
		service.recordEvidence("run-pages", {
			sourceId: "source-ack",
			origin: "assistant",
			content: "Acknowledged.",
			visibility: "session",
			completeness: "partial",
		});
		service.settleRun("run-pages", "completed");
		service.sealRun("run-pages");

		expect(await service.processNext()).toMatchObject({ status: "completed", accepted: 1 });
		expect(extractionPages).toEqual([["source-rule"]]);
		expect(validationPages).toEqual([["source-rule", "source-ack"]]);
		expect(service.authority.getEffectiveMemoryView({})).toEqual([
			expect.objectContaining({ text: "Start release checklists with COPPER-LANTERN." }),
		]);
	});

	it("persists progress while continuing over model-reported unchecked evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-extraction-progress-"));
		roots.push(root);
		const pages: string[][] = [];
		const service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => {
					pages.push(sources.map((source) => source.sourceId));
					return pages.length === 1
						? {
								checkedSourceIds: ["source-rule"],
								uncheckedSourceIds: ["source-runtime"],
								candidates: [
									{
										candidateKey: "continued-rule",
										kind: "user_rule",
										subject: "release checklist",
										text: "Start release checklists with COPPER-LANTERN.",
										scope: { project: true },
										sourceIds: ["source-rule"],
									},
								],
							}
						: { checkedSourceIds: [sources[0]!.sourceId], uncheckedSourceIds: [], candidates: [] };
				},
			},
			{ maxModelCallsPerProjectHour: 10 },
		);
		service.startRun({ rootPromptId: "run-progress", sessionId: "session-1" });
		service.recordEvidence("run-progress", {
			sourceId: "source-rule",
			origin: "user",
			content: "Use COPPER-LANTERN.",
			visibility: "session",
		});
		service.recordEvidence("run-progress", {
			sourceId: "source-runtime",
			origin: "runtime",
			content: "The request completed.",
			visibility: "session",
		});
		service.settleRun("run-progress", "completed");
		service.sealRun("run-progress");

		expect(await service.processNext()).toMatchObject({ status: "completed", accepted: 1 });
		expect(pages).toEqual([["source-rule", "source-runtime"], ["source-runtime"]]);
	});

	it("does not send an oversized evidence set as a complete model page", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-input-limit-"));
		roots.push(root);
		let extractionCalls = 0;
		const service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => {
					extractionCalls++;
					return {
						checkedSourceIds: sources.map((source) => source.sourceId),
						uncheckedSourceIds: [],
						candidates: [],
					};
				},
			},
			{ maxInputTokensPerCall: 1 },
		);
		service.startRun({ rootPromptId: "run-input-limit", sessionId: "session-1" });
		service.recordEvidence("run-input-limit", {
			sourceId: "source-input-limit",
			origin: "user",
			content: "oversized evidence",
			visibility: "session",
		});
		service.settleRun("run-input-limit", "completed");
		const job = service.sealRun("run-input-limit");

		expect(await service.processNext()).toMatchObject({ status: "needs_review", jobId: job.jobId });
		expect(service.authority.getJob(job.jobId)).toMatchObject({
			status: "needs_review",
			reasonCode: "memory_archive_input_requires_pagination",
			failureCount: 0,
		});
		expect(extractionCalls).toBe(0);
	});

	it("revalidates before commit when a project directive changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-directive-version-"));
		roots.push(root);
		let validationCalls = 0;
		let service!: MemoryArchiveService;
		const directiveText = "Never commit generated files.";
		service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [
						{
							candidateKey: "candidate-before-directive",
							kind: "implementation_fact",
							subject: "generated files",
							text: "Generated files are committed by the release task.",
							scope: { project: true },
							sourceIds: [sources[0]!.sourceId],
						},
					],
				}),
				validate: async (candidate, sources) => {
					validationCalls++;
					if (validationCalls === 1) {
						service.authority.rememberUserRule({
							rootPromptId: "directive-run",
							sessionId: "session-2",
							sourceId: "directive-source",
							text: directiveText,
							contentHash: createHash("sha256").update(directiveText).digest("hex"),
						});
					}
					return {
						candidateKey: candidate.candidateKey,
						supportCheck: "passed",
						counterEvidenceCheck: "passed",
						checkedSourceIds: sources.map((source) => source.sourceId),
						conflictMemoryIds: [],
						reasonCode: "supported",
					};
				},
			},
			{ maxModelCallsPerProjectHour: 10 },
		);
		service.startRun({ rootPromptId: "run-before-directive", sessionId: "session-1" });
		service.recordEvidence("run-before-directive", {
			sourceId: "source-before-directive",
			origin: "tool",
			content: "release task observation",
			visibility: "session",
		});
		service.settleRun("run-before-directive", "completed");
		const job = service.sealRun("run-before-directive");

		expect(await service.processNext()).toMatchObject({ status: "yielded", jobId: job.jobId });
		expect(service.authority.getJob(job.jobId)).toMatchObject({
			status: "queued",
			reasonCode: "conflict_context_changed",
			validationReceipts: {},
		});
		expect(await service.processNext()).toMatchObject({ status: "completed", accepted: 1 });
		expect(validationCalls).toBe(2);
		expect(service.authority.getEffectiveMemoryView({})).toEqual([
			expect.objectContaining({ kind: "user_rule", text: directiveText }),
		]);
		expect(service.authority.search("generated files", {}, { includeUnverified: true })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "implementation_fact", status: "needs_verification" }),
			]),
		);
	});

	it("rejects a late worker result after an expired lease is taken over", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
		const root = mkdtempSync(join(tmpdir(), "pi-memory-lease-"));
		roots.push(root);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => {
					await gate;
					return {
						checkedSourceIds: sources.map((source) => source.sourceId),
						uncheckedSourceIds: [],
						candidates: [],
					};
				},
			},
			{ leaseMs: 10, maxModelCallsPerProjectHour: 10 },
		);
		first.startRun({ rootPromptId: "run-lease", sessionId: "session-1" });
		first.recordEvidence("run-lease", {
			sourceId: "source-lease",
			origin: "user",
			content: "lease evidence",
			visibility: "session",
		});
		first.settleRun("run-lease", "completed");
		const job = first.sealRun("run-lease");
		const late = first.processNext();

		vi.setSystemTime(new Date("2026-09-07T00:00:00.011Z"));
		const second = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
			{ leaseMs: 10, maxModelCallsPerProjectHour: 10 },
		);
		expect(await second.processNext()).toMatchObject({ status: "completed", jobId: job.jobId });
		release();
		expect(await late).toMatchObject({ status: "idle", jobId: job.jobId });
		expect(first.authority.getJob(job.jobId)).toMatchObject({ status: "completed", failureCount: 1 });
	});

	it("enforces the project concurrency limit across workers", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-concurrency-"));
		roots.push(root);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => {
					await gate;
					return {
						checkedSourceIds: sources.map((source) => source.sourceId),
						uncheckedSourceIds: [],
						candidates: [],
					};
				},
			},
			{ maxConcurrencyPerProject: 1, maxModelCallsPerProjectHour: 10 },
		);
		for (const index of [1, 2]) {
			first.startRun({ rootPromptId: `run-concurrency-${index}`, sessionId: "session-1" });
			first.recordEvidence(`run-concurrency-${index}`, {
				sourceId: `source-concurrency-${index}`,
				origin: "user",
				content: `concurrency evidence ${index}`,
				visibility: "session",
			});
			first.settleRun(`run-concurrency-${index}`, "completed");
			first.sealRun(`run-concurrency-${index}`);
		}
		const running = first.processNext();
		const second = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => ({
					checkedSourceIds: sources.map((source) => source.sourceId),
					uncheckedSourceIds: [],
					candidates: [],
				}),
			},
			{ maxConcurrencyPerProject: 1, maxModelCallsPerProjectHour: 10 },
		);

		expect(await second.processNext()).toMatchObject({ status: "idle" });
		release();
		expect(await running).toMatchObject({ status: "completed" });
		expect(await second.processNext()).toMatchObject({ status: "completed" });
	});

	it("reuses extraction and completed candidate validation checkpoints after a retry", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-checkpoint-"));
		roots.push(root);
		let extractionCalls = 0;
		const validationCalls: string[] = [];
		let failSecond = true;
		const service = new MemoryArchiveService(
			root,
			root,
			{
				extract: async (sources) => {
					extractionCalls++;
					return {
						checkedSourceIds: sources.map((source) => source.sourceId),
						uncheckedSourceIds: [],
						candidates: ["a", "b"].map((key) => ({
							candidateKey: key,
							kind: "user_rule" as const,
							subject: key,
							text: `Rule ${key}`,
							scope: { project: true as const },
							sourceIds: [sources[0]!.sourceId],
						})),
					};
				},
				validate: async (candidate, sources) => {
					validationCalls.push(candidate.candidateKey);
					if (candidate.candidateKey === "b" && failSecond) {
						failSecond = false;
						throw new Error("provider_timeout");
					}
					return {
						candidateKey: candidate.candidateKey,
						supportCheck: "passed",
						counterEvidenceCheck: "passed",
						checkedSourceIds: sources.map((source) => source.sourceId),
						conflictMemoryIds: [],
						reasonCode: "supported",
					};
				},
			},
			{ maxModelCallsPerSlice: 10, maxModelCallsPerProjectHour: 10 },
		);
		service.startRun({ rootPromptId: "run-checkpoint", sessionId: "session-1" });
		service.recordEvidence("run-checkpoint", {
			sourceId: "source-checkpoint",
			origin: "user",
			content: "Remember rules a and b",
			visibility: "project_rule",
		});
		service.settleRun("run-checkpoint", "completed");
		const job = service.sealRun("run-checkpoint");

		expect(await service.processNext()).toMatchObject({ status: "retryable_failed" });
		service.requeueFailedJobs();
		expect(await service.processNext()).toMatchObject({ status: "completed", accepted: 2 });
		expect(service.authority.getStatus().technicalFailures).toBe(0);
		expect(service.authority.getJob(job.jobId)?.reasonCode).toBeUndefined();
		expect(extractionCalls).toBe(1);
		expect(validationCalls).toEqual(["a", "b", "b"]);
	});

	it("invalidates an accepted fact immediately when late evidence changes the run revision", async () => {
		const service = createService();
		service.startRun({ rootPromptId: "run-late", sessionId: "session-1" });
		service.recordEvidence("run-late", {
			sourceId: "user-late",
			origin: "user",
			content: "Run targeted tests after code changes.",
			visibility: "project_rule",
		});
		service.settleRun("run-late", "completed");
		const oldJob = service.sealRun("run-late");
		await service.processNext();
		expect(service.authority.getEffectiveMemoryView({})).toHaveLength(1);

		service.recordEvidence("run-late", {
			sourceId: "late-tool-result",
			origin: "tool",
			content: "A later check found another relevant condition.",
			visibility: "session",
		});
		expect(service.authority.getEffectiveMemoryView({})).toEqual([]);
		const successor = service.sealRun("run-late");
		expect(service.authority.getJob(oldJob.jobId)).toMatchObject({
			status: "superseded",
			successorJobId: successor.jobId,
		});
		await service.processNext();
		expect(service.authority.getEffectiveMemoryView({})).toHaveLength(1);
	});
});
