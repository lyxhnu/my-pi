import { createHash, randomUUID } from "node:crypto";
import { validateMemoryArchiveExtraction, validateMemoryCandidateValidation } from "./archive-extraction.ts";
import { MemoryAuthority } from "./memory-authority.ts";
import { checkMemoryCandidate } from "./secret-filter.ts";
import type {
	MemoryArchiveExtraction,
	MemoryArchiveJob,
	MemoryCandidateValidation,
	MemoryCandidateValidationReceipt,
	MemoryConflictContext,
	MemoryEvidenceInput,
	MemoryEvidenceSource,
	MemoryExtractionCandidate,
	MemoryRun,
	MemoryRunStart,
	MemorySourceManifest,
} from "./types.ts";

export interface MemoryArchiveExtractor {
	extract(sources: MemoryEvidenceSource[], signal?: AbortSignal): Promise<MemoryArchiveExtraction>;
	validate?(
		candidate: MemoryExtractionCandidate,
		sources: MemoryEvidenceSource[],
		conflicts: MemoryConflictContext,
		signal?: AbortSignal,
	): Promise<MemoryCandidateValidation>;
}

export interface MemoryArchiveServiceOptions {
	maxConcurrencyPerProject?: number;
	maxFailuresPerWorkItem?: number;
	leaseMs?: number;
	maxInputTokensPerCall?: number;
	maxModelCallsPerProjectHour?: number;
	maxCandidatesPerBatch?: number;
	maxModelCallsPerSlice?: number;
}

export type ArchiveEligibility =
	| { status: "ready" }
	| { status: "waiting_main" }
	| { status: "waiting_continuation" }
	| { status: "waiting_task_evidence"; taskIds: string[]; evidenceIds?: string[] }
	| { status: "no_new_sources" }
	| { status: "disabled" };

export interface ArchiveProcessResult {
	status: "idle" | "completed" | "retryable_failed" | "needs_review" | "budget_wait" | "yielded";
	jobId?: string;
	accepted?: number;
	rejected?: number;
	deferred?: number;
	retryAt?: string;
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mergeExtractionPages(
	previous: MemoryArchiveExtraction,
	next: MemoryArchiveExtraction,
	manifestSourceIds: ReadonlySet<string>,
): MemoryArchiveExtraction {
	const candidates = new Map(previous.candidates.map((candidate) => [candidate.candidateKey, candidate]));
	for (const candidate of next.candidates) {
		const existing = candidates.get(candidate.candidateKey);
		if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
			throw new Error("memory_candidate_key_conflict");
		}
		candidates.set(candidate.candidateKey, candidate);
	}
	return validateMemoryArchiveExtraction(
		{
			checkedSourceIds: [...new Set([...previous.checkedSourceIds, ...next.checkedSourceIds])],
			uncheckedSourceIds: next.uncheckedSourceIds,
			candidates: [...candidates.values()],
		},
		manifestSourceIds,
		Number.MAX_SAFE_INTEGER,
	);
}

/** Run-scoped evidence collection and recoverable archive scheduling. */
export class MemoryArchiveService {
	readonly authority: MemoryAuthority;
	private readonly extractor: MemoryArchiveExtractor;
	private readonly maxConcurrencyPerProject: number;
	private readonly maxFailuresPerWorkItem: number;
	private readonly workerId = randomUUID();
	private readonly leaseMs: number;
	private readonly maxInputTokensPerCall: number;
	private readonly maxModelCallsPerProjectHour: number;
	private readonly maxCandidatesPerBatch: number;
	private readonly maxModelCallsPerSlice: number;
	private activeController: AbortController | undefined;

	constructor(
		memoryRoot: string,
		cwd: string,
		extractor: MemoryArchiveExtractor,
		options: MemoryArchiveServiceOptions = {},
	) {
		this.authority = new MemoryAuthority(memoryRoot, cwd);
		this.extractor = extractor;
		this.maxConcurrencyPerProject = options.maxConcurrencyPerProject ?? 1;
		this.maxFailuresPerWorkItem = options.maxFailuresPerWorkItem ?? 3;
		this.leaseMs = options.leaseMs ?? 90_000;
		this.maxInputTokensPerCall = options.maxInputTokensPerCall ?? 16_000;
		this.maxModelCallsPerProjectHour = options.maxModelCallsPerProjectHour ?? 24;
		this.maxCandidatesPerBatch = options.maxCandidatesPerBatch ?? 12;
		this.maxModelCallsPerSlice = options.maxModelCallsPerSlice ?? 4;
	}

	startRun(input: MemoryRunStart): MemoryRun {
		return this.authority.startRun(input);
	}

	recordEvidence(rootPromptId: string, input: MemoryEvidenceInput): MemoryRun {
		const run = this.authority.getRun(rootPromptId);
		if (!run) throw new Error("memory_run_not_found");
		const safety = checkMemoryCandidate(input.content);
		this.authority.beginEvidence(rootPromptId, input.sourceId);
		return this.authority.recordEvidence({
			...input,
			content: safety.safe ? input.content : `[filtered:${safety.reason ?? "unsafe"}]`,
			rootPromptId,
			sessionId: run.sessionId,
			contentHash: hash(input.content),
			completeness: safety.safe ? (input.completeness ?? "complete") : "partial",
			sequence: run.sourceIds.length,
		});
	}

	settleRun(
		rootPromptId: string,
		outcome: MemoryRun["outcome"],
		continuationState: MemoryRun["continuationState"] = "none",
	): MemoryRun {
		return this.authority.settleRun(rootPromptId, outcome, continuationState);
	}

	registerTask(rootPromptId: string, taskId: string, archiveRole: "dependency" | "service"): MemoryRun {
		return this.authority.registerTask(rootPromptId, taskId, archiveRole);
	}

	recordTaskEvidence(rootPromptId: string, taskId: string, evidenceState: "durable" | "unavailable"): MemoryRun {
		return this.authority.recordTaskEvidence(rootPromptId, taskId, evidenceState);
	}

	checkArchiveEligibility(rootPromptId: string): ArchiveEligibility {
		const run = this.authority.getRun(rootPromptId);
		if (!run || run.mainState !== "quiescent") return { status: "waiting_main" };
		if (run.continuationState !== "none") return { status: "waiting_continuation" };
		if (run.pendingEvidenceIds.length > 0) {
			return { status: "waiting_task_evidence", taskIds: [], evidenceIds: [...run.pendingEvidenceIds] };
		}
		const pending = Object.entries(run.requiredTasks)
			.filter(([, task]) => task.archiveRole === "dependency" && task.evidenceState !== "durable")
			.map(([taskId]) => taskId);
		if (pending.length > 0) return { status: "waiting_task_evidence", taskIds: pending };
		if (run.sourceIds.length === 0) return { status: "no_new_sources" };
		return { status: "ready" };
	}

	sealRun(rootPromptId: string): MemoryArchiveJob {
		const eligibility = this.checkArchiveEligibility(rootPromptId);
		if (eligibility.status !== "ready") throw new Error(`memory_archive_${eligibility.status}`);
		const run = this.authority.getRun(rootPromptId)!;
		const manifestKey = { rootPromptId, sourceRevision: run.sourceRevision, sourceIds: run.sourceIds };
		const manifestId = `manifest-${hash(manifestKey).slice(0, 16)}`;
		const jobId = `archive-${hash({ manifestId }).slice(0, 16)}`;
		const now = new Date().toISOString();
		const manifest: MemorySourceManifest = {
			manifestId,
			rootPromptId,
			sourceRevision: run.sourceRevision,
			sourceIds: [...run.sourceIds],
			contentHash: hash(manifestKey),
			sealedAt: now,
		};
		return this.authority.sealRun(rootPromptId, manifest, {
			jobId,
			manifestId,
			rootPromptId,
			status: "queued",
			attemptToken: 0,
			failureCount: 0,
			failureCountByWorkItem: {},
			accepted: 0,
			rejected: 0,
			deferred: 0,
			createdAt: now,
			updatedAt: now,
			validationReceipts: {},
		});
	}

	async processNext(): Promise<ArchiveProcessResult> {
		this.authority.refreshBudgetWaits(this.maxModelCallsPerProjectHour);
		const claimed = this.authority.claimNextJob(
			this.workerId,
			this.leaseMs,
			this.maxFailuresPerWorkItem,
			this.maxConcurrencyPerProject,
		);
		if (!claimed) return { status: "idle" };
		const controller = new AbortController();
		this.activeController = controller;
		let workItemId = "extract";
		try {
			let modelCalls = 0;
			let extraction = claimed.job.extractionCheckpoint;
			const nonDiscoverySourceIds = claimed.sources
				.filter((source) => source.origin === "assistant")
				.map((source) => source.sourceId);
			while (!extraction || extraction.uncheckedSourceIds.length > 0) {
				if (modelCalls >= this.maxModelCallsPerSlice) {
					this.authority.yieldJob(claimed.job.jobId, claimed.job.attemptToken, "archive_slice_budget");
					return { status: "yielded", jobId: claimed.job.jobId };
				}
				const pageSourceIds = extraction?.uncheckedSourceIds;
				const pageSources = pageSourceIds
					? pageSourceIds.map((sourceId) => claimed.sources.find((source) => source.sourceId === sourceId)!)
					: claimed.sources.filter((source) => source.origin !== "assistant");
				if (Math.ceil(JSON.stringify(pageSources).length / 4) > this.maxInputTokensPerCall) {
					this.authority.markJobNeedsReview(
						claimed.job.jobId,
						claimed.job.attemptToken,
						"memory_archive_input_requires_pagination",
					);
					return { status: "needs_review", jobId: claimed.job.jobId };
				}
				const reservation = this.authority.reserveModelCall(
					claimed.job.jobId,
					claimed.job.attemptToken,
					this.maxModelCallsPerProjectHour,
				);
				if (!reservation.reserved) {
					return { status: "budget_wait", jobId: claimed.job.jobId, retryAt: reservation.retryAt };
				}
				modelCalls++;
				const extracted = validateMemoryArchiveExtraction(
					await this.extractor.extract(pageSources, controller.signal),
					new Set(pageSources.map((source) => source.sourceId)),
					this.maxCandidatesPerBatch,
				);
				if (extracted.candidates.some((candidate) => !checkMemoryCandidate(candidate.text).safe)) {
					throw new Error("unsafe_memory_record");
				}
				if (extraction && extracted.checkedSourceIds.length === 0) {
					this.authority.markJobNeedsReview(
						claimed.job.jobId,
						claimed.job.attemptToken,
						"memory_extraction_no_progress",
					);
					return { status: "needs_review", jobId: claimed.job.jobId };
				}
				extraction = extraction
					? mergeExtractionPages(extraction, extracted, new Set(claimed.manifest.sourceIds))
					: validateMemoryArchiveExtraction(
							{
								...extracted,
								checkedSourceIds: [...extracted.checkedSourceIds, ...nonDiscoverySourceIds],
							},
							new Set(claimed.manifest.sourceIds),
							this.maxCandidatesPerBatch,
						);
				this.authority.saveExtractionCheckpoint(claimed.job.jobId, claimed.job.attemptToken, extraction);
				if (extracted.candidates.length === this.maxCandidatesPerBatch) {
					this.authority.markJobNeedsReview(
						claimed.job.jobId,
						claimed.job.attemptToken,
						"memory_candidate_limit_reached",
					);
					return { status: "needs_review", jobId: claimed.job.jobId };
				}
			}
			for (const candidate of extraction.candidates) {
				if (claimed.job.validationReceipts[candidate.candidateKey]) continue;
				workItemId = `validate:${candidate.candidateKey}`;
				const conflicts = this.authority.getMemoryConflictContext({
					subject: candidate.subject,
					scope: candidate.scope,
				});
				if (
					Math.ceil(JSON.stringify({ candidate, sources: claimed.sources, conflicts }).length / 4) >
					this.maxInputTokensPerCall
				) {
					this.authority.markJobNeedsReview(
						claimed.job.jobId,
						claimed.job.attemptToken,
						"memory_validation_input_requires_pagination",
					);
					return { status: "needs_review", jobId: claimed.job.jobId };
				}
				let validation: MemoryCandidateValidation;
				if (this.extractor.validate) {
					if (modelCalls >= this.maxModelCallsPerSlice) {
						this.authority.yieldJob(claimed.job.jobId, claimed.job.attemptToken, "archive_slice_budget");
						return { status: "yielded", jobId: claimed.job.jobId };
					}
					const reservation = this.authority.reserveModelCall(
						claimed.job.jobId,
						claimed.job.attemptToken,
						this.maxModelCallsPerProjectHour,
					);
					if (!reservation.reserved) {
						return { status: "budget_wait", jobId: claimed.job.jobId, retryAt: reservation.retryAt };
					}
					modelCalls++;
					validation = await this.extractor.validate(candidate, claimed.sources, conflicts, controller.signal);
				} else {
					const userAsserted =
						candidate.kind === "user_rule" &&
						candidate.sourceIds.some(
							(sourceId) => claimed.sources.find((source) => source.sourceId === sourceId)?.origin === "user",
						);
					validation = {
						candidateKey: candidate.candidateKey,
						supportCheck: userAsserted ? "passed" : "deferred",
						counterEvidenceCheck: userAsserted ? "passed" : "deferred",
						checkedSourceIds: claimed.manifest.sourceIds,
						conflictMemoryIds: [],
						reasonCode: userAsserted ? "explicit_user_source" : "semantic_validation_unavailable",
					};
				}
				const checkedValidation = validateMemoryCandidateValidation(
					validation,
					candidate,
					new Set(claimed.manifest.sourceIds),
					new Set(conflicts.records.map((record) => record.memoryId)),
				);
				const receipt: MemoryCandidateValidationReceipt = {
					...checkedValidation,
					conflictRevision: conflicts.conflictRevision,
					projectDirectiveRevision: conflicts.projectDirectiveRevision,
				};
				this.authority.saveValidationCheckpoint(claimed.job.jobId, claimed.job.attemptToken, receipt);
			}
			const completed = this.authority.completeJob(claimed.job.jobId, claimed.job.attemptToken, extraction);
			if (completed.status === "queued") return { status: "yielded", jobId: completed.jobId };
			return {
				status: "completed",
				jobId: completed.jobId,
				accepted: completed.accepted,
				rejected: completed.rejected,
				deferred: completed.deferred,
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const current = this.authority.getJob(claimed.job.jobId);
			if (!current || current.status !== "running" || current.attemptToken !== claimed.job.attemptToken) {
				return { status: "idle", jobId: claimed.job.jobId };
			}
			if (controller.signal.aborted) {
				this.authority.yieldJob(claimed.job.jobId, claimed.job.attemptToken, "archive_cancelled");
				return { status: "yielded", jobId: claimed.job.jobId };
			}
			const failed = this.authority.failJob(
				claimed.job.jobId,
				claimed.job.attemptToken,
				workItemId,
				reason,
				this.maxFailuresPerWorkItem,
			);
			return { status: failed.status as "retryable_failed" | "needs_review", jobId: failed.jobId };
		} finally {
			if (this.activeController === controller) this.activeController = undefined;
		}
	}

	cancelCurrent(): void {
		this.activeController?.abort();
	}

	requeueFailedJobs(): void {
		this.authority.requeueFailedJobs();
	}
}
