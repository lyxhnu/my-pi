import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { isPathWithinScope } from "../permissions/path-inspector.ts";
import { projectMemoryDir } from "./memory-store.ts";
import { checkMemoryCandidate } from "./secret-filter.ts";
import type {
	EffectiveMemoryRecord,
	MemoryApplicability,
	MemoryArchiveExtraction,
	MemoryArchiveJob,
	MemoryArchiveStatus,
	MemoryAuthorityState,
	MemoryCandidateValidationReceipt,
	MemoryConflictContext,
	MemoryConflictQuery,
	MemoryEvidenceSource,
	MemoryMachineCondition,
	MemoryQueryContext,
	MemoryReadOptions,
	MemoryRecordInput,
	MemoryRecordRevision,
	MemoryRun,
	MemoryRunStart,
	MemorySourceManifest,
} from "./types.ts";

function initialState(): MemoryAuthorityState {
	return {
		schemaVersion: 2,
		revision: 0,
		records: [],
		jobs: {},
		runs: {},
		manifests: {},
		sources: {},
		sourceReceipts: {},
		conflicts: {},
		projectDirectives: {},
		conflictRevisions: {},
		projectDirectiveRevision: 0,
		modelCallReservations: [],
	};
}

function parseState(raw: string): MemoryAuthorityState {
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== "object" ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 2 ||
		!("revision" in value) ||
		typeof value.revision !== "number" ||
		!("records" in value) ||
		!Array.isArray(value.records)
	) {
		throw new Error("invalid_memory_authority_state");
	}
	const state = value as MemoryAuthorityState;
	state.modelCallReservations = Array.isArray(state.modelCallReservations) ? state.modelCallReservations : [];
	state.conflictRevisions ??= {};
	state.projectDirectiveRevision ??= 0;
	for (const job of Object.values(state.jobs ?? {})) {
		job.failureCountByWorkItem ??= {};
		job.validationReceipts ??= {};
	}
	return state;
}

function conflictKey(subject: string): string {
	return subject.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function advanceConflictRevision(state: MemoryAuthorityState, subject: string): void {
	const key = conflictKey(subject);
	state.conflictRevisions[key] = (state.conflictRevisions[key] ?? 0) + 1;
}

function createRecord(input: MemoryRecordInput, records: MemoryRecordRevision[]): MemoryRecordRevision {
	if (!input.text.trim() || !input.subject.trim() || input.sourceRefs.length === 0) {
		throw new Error("invalid_memory_record");
	}
	if (!checkMemoryCandidate(input.text).safe) throw new Error("unsafe_memory_record");
	const current = records.filter((record) => record.candidateKey === input.candidateKey).at(-1);
	return {
		...input,
		memoryId:
			current?.memoryId ?? `mem-${createHash("sha256").update(input.candidateKey).digest("hex").slice(0, 16)}`,
		revision: (current?.revision ?? 0) + 1,
		machineConditions: input.machineConditions ?? [],
		limitations: input.limitations ?? [],
		relations: input.relations ?? {},
		reasonCode: input.reasonCode ?? "accepted",
		createdAt: new Date().toISOString(),
	};
}

function writeAtomic(path: string, content: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function serializeActiveView(state: MemoryAuthorityState): string {
	const latest = new Map<string, MemoryRecordRevision>();
	for (const record of state.records) latest.set(record.memoryId, record);
	const records = [...latest.values()].filter((record) => record.status === "active");
	const body = records
		.map(
			(record) =>
				`<!-- id:${record.memoryId} revision:${record.revision} -->\n## ${record.kind}: ${record.subject}\n\n` +
				`Scope: \`${JSON.stringify(record.scope)}\`  \nConditions: \`${JSON.stringify(record.machineConditions)}\`  \n` +
				`Verification: \`${record.verification.level}\` at ${record.verification.checkedAt}\n\n${record.text}` +
				(record.limitations.length > 0 ? `\n\nLimitations: ${record.limitations.join("; ")}` : ""),
		)
		.join("\n\n");
	return `# Active project memory\n\nAuthority revision: ${state.revision}\n\n${body}${body ? "\n" : ""}`;
}

function activeViewIsStale(statePath: string, activeViewPath: string, state: MemoryAuthorityState): boolean {
	if (!existsSync(statePath)) return false;
	try {
		return readFileSync(activeViewPath, "utf8") !== serializeActiveView(state);
	} catch {
		return true;
	}
}

function scopeOverlaps(left: MemoryConflictQuery["scope"], right: MemoryConflictQuery["scope"]): boolean {
	if (left.scene !== undefined && right.scene !== undefined && left.scene !== right.scene) return false;
	if (left.gitRef !== undefined && right.gitRef !== undefined && left.gitRef !== right.gitRef) return false;
	if (left.modulePaths && right.modulePaths && !left.modulePaths.some((path) => right.modulePaths!.includes(path)))
		return false;
	return true;
}

function conditionApplicability(condition: MemoryMachineCondition, context: MemoryQueryContext): MemoryApplicability {
	switch (condition.kind) {
		case "scene":
			return context.scene === undefined
				? "unknown"
				: context.scene === condition.value
					? "applicable"
					: "not_applicable";
		case "git_ref":
			return context.gitRef === undefined
				? "unknown"
				: context.gitRef === condition.value
					? "applicable"
					: "not_applicable";
		case "runtime":
			return context.runtime === undefined
				? "unknown"
				: context.runtime === condition.value
					? "applicable"
					: "not_applicable";
		case "platform":
			return context.platform === undefined
				? "unknown"
				: context.platform === condition.value
					? "applicable"
					: "not_applicable";
		case "file_hash": {
			if (!context.cwd) return "unknown";
			try {
				const content = readFileSync(resolve(context.cwd, condition.path));
				return createHash("sha256").update(content).digest("hex") === condition.hash ? "applicable" : "unknown";
			} catch {
				return "unknown";
			}
		}
		case "directory_hash":
			return "unknown";
	}
}

function applicability(record: MemoryRecordRevision, context: MemoryQueryContext): MemoryApplicability {
	const scopedConditions: MemoryMachineCondition[] = [
		...(record.scope.scene ? [{ kind: "scene" as const, value: record.scope.scene }] : []),
		...(record.scope.gitRef ? [{ kind: "git_ref" as const, value: record.scope.gitRef }] : []),
		...record.machineConditions,
	];
	let result: MemoryApplicability = "applicable";
	for (const condition of scopedConditions) {
		const current = conditionApplicability(condition, context);
		if (current === "not_applicable") return current;
		if (current === "unknown") result = current;
	}
	return result;
}

function authorityApplicability(
	record: MemoryRecordRevision,
	state: MemoryAuthorityState,
	context: MemoryQueryContext,
): MemoryApplicability {
	const conditionResult = applicability(record, context);
	if (conditionResult !== "applicable") return conditionResult;
	for (const reference of record.sourceRefs) {
		const source = state.sources[reference.sourceId];
		if (!source || source.contentHash !== reference.contentHash || source.completeness !== "complete")
			return "unknown";
		if (
			reference.rootPromptId &&
			record.verification.validatedSourceRevision !== undefined &&
			state.runs[reference.rootPromptId]?.sourceRevision !== record.verification.validatedSourceRevision
		) {
			return "unknown";
		}
	}
	return "applicable";
}

/** Authoritative v2 memory state for one project. All mutations pass through this module. */
export class MemoryAuthority {
	private readonly statePath: string;
	private readonly lockPath: string;
	private readonly activeViewPath: string;

	constructor(memoryRoot: string, cwd: string) {
		const projectDir = projectMemoryDir(memoryRoot, cwd);
		this.statePath = resolve(projectDir, "memory-state.v2.json");
		this.lockPath = resolve(projectDir, ".memory-state.v2.lock");
		this.activeViewPath = resolve(projectDir, "memory-active.md");
		if (!isPathWithinScope(this.statePath, resolve(memoryRoot), resolve(memoryRoot))) {
			throw new Error("Memory authority path outside scope");
		}
	}

	private readState(): MemoryAuthorityState {
		return existsSync(this.statePath) ? parseState(readFileSync(this.statePath, "utf8")) : initialState();
	}

	private mutate<T>(operation: (state: MemoryAuthorityState) => T): T {
		mkdirSync(dirname(this.statePath), { recursive: true });
		const release = lockfile.lockSync(this.lockPath, { realpath: false, lockfilePath: this.lockPath });
		try {
			const state = this.readState();
			const before = JSON.stringify(state);
			const result = operation(state);
			if (JSON.stringify(state) !== before) {
				state.revision++;
				writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
				try {
					writeAtomic(this.activeViewPath, serializeActiveView(state));
				} catch {
					// The authority commit remains valid; status reports the stale derived view.
				}
			}
			return result;
		} finally {
			release();
		}
	}

	commitRecord(input: MemoryRecordInput): MemoryRecordRevision {
		return this.mutate((state) => {
			for (const reference of input.sourceRefs) {
				const source = state.sources[reference.sourceId];
				if (
					!source ||
					source.contentHash !== reference.contentHash ||
					source.origin !== reference.origin ||
					source.completeness !== reference.completeness
				) {
					throw new Error("invalid_memory_source_reference");
				}
			}
			const record = createRecord(input, state.records);
			state.records.push(record);
			advanceConflictRevision(state, record.subject);
			return structuredClone(record);
		});
	}

	rememberUserRule(input: {
		rootPromptId: string;
		sessionId: string;
		sourceId: string;
		entryId?: string;
		text: string;
		contentHash: string;
	}): MemoryRecordRevision {
		return this.mutate((state) => {
			if (!input.text.trim()) throw new Error("invalid_memory_record");
			if (!checkMemoryCandidate(input.text).safe) throw new Error("unsafe_memory_record");
			const candidateKey = `user-rule:${createHash("sha256").update(input.text.trim()).digest("hex")}`;
			const existing = state.records.filter((record) => record.candidateKey === candidateKey).at(-1);
			if (existing?.status === "active" && existing.text === input.text.trim()) return structuredClone(existing);
			const now = new Date().toISOString();
			const source: MemoryEvidenceSource = {
				sourceId: input.sourceId,
				rootPromptId: input.rootPromptId,
				sessionId: input.sessionId,
				origin: "user",
				content: input.text,
				contentHash: input.contentHash,
				visibility: "project_rule",
				completeness: "complete",
				sequence: 0,
				entryId: input.entryId,
			};
			state.sources[source.sourceId] = source;
			state.sourceReceipts[source.sourceId] = {
				sourceId: source.sourceId,
				rootPromptId: source.rootPromptId,
				contentHash: source.contentHash,
				recordedAt: now,
			};
			state.runs[input.rootPromptId] = {
				rootPromptId: input.rootPromptId,
				sessionId: input.sessionId,
				taskSourceEntryId: input.entryId,
				mainState: "quiescent",
				continuationState: "none",
				outcome: "completed",
				sourceRevision: 1,
				sourceIds: [source.sourceId],
				pendingEvidenceIds: [],
				sealedManifestIds: [],
				requiredTasks: {},
				createdAt: now,
				updatedAt: now,
			};
			state.projectDirectives[input.rootPromptId] = {
				directiveId: input.rootPromptId,
				sourceId: source.sourceId,
				status: "active",
				createdAt: now,
			};
			state.projectDirectiveRevision++;
			const record = createRecord(
				{
					candidateKey,
					kind: "user_rule",
					subject: input.text.trim().toLocaleLowerCase().slice(0, 120),
					text: input.text.trim(),
					scope: { project: true },
					status: "active",
					sourceRefs: [
						{
							sourceId: source.sourceId,
							origin: "user",
							contentHash: source.contentHash,
							completeness: "complete",
							rootPromptId: source.rootPromptId,
							sessionId: source.sessionId,
							entryId: source.entryId,
						},
					],
					verification: { level: "user_asserted", checkedAt: now, validatedSourceRevision: 1 },
					reasonCode: "explicit_user_rule",
				},
				state.records,
			);
			state.records.push(record);
			advanceConflictRevision(state, record.subject);
			return structuredClone(record);
		});
	}

	getStatus(): MemoryArchiveStatus {
		const state = this.readState();
		const latest = new Map<string, MemoryRecordRevision>();
		for (const record of state.records) latest.set(record.memoryId, record);
		const jobs: MemoryArchiveStatus["jobs"] = {
			queued: 0,
			running: 0,
			waiting_budget: 0,
			waiting_dependency: 0,
			retryable_failed: 0,
			needs_review: 0,
			superseded: 0,
			completed: 0,
		};
		for (const job of Object.values(state.jobs)) jobs[job.status]++;
		const unfinishedJobs = Object.values(state.jobs).filter(
			(job) => job.status !== "completed" && job.status !== "superseded",
		);
		const oldestReservation = state.modelCallReservations
			.map((reservation) => Date.parse(reservation.reservedAt))
			.filter(Number.isFinite)
			.sort((left, right) => left - right)[0];
		return {
			authorityRevision: state.revision,
			runs: Object.keys(state.runs).length,
			jobs,
			unprocessedSources: unfinishedJobs.reduce(
				(sum, job) => sum + (state.manifests[job.manifestId]?.sourceIds.length ?? 0),
				0,
			),
			deferredCandidates: Object.values(state.jobs).reduce((sum, job) => sum + job.deferred, 0),
			missingEvidenceTasks: Object.values(state.runs).reduce(
				(sum, run) =>
					sum + Object.values(run.requiredTasks).filter((task) => task.evidenceState !== "durable").length,
				0,
			),
			technicalFailures: unfinishedJobs.reduce((sum, job) => sum + job.failureCount, 0),
			projectDirectives: Object.keys(state.projectDirectives).length,
			...(jobs.waiting_budget > 0 && oldestReservation !== undefined
				? { nextSchedulableAt: new Date(oldestReservation + 60 * 60 * 1000).toISOString() }
				: {}),
			derivedViewStale: activeViewIsStale(this.statePath, this.activeViewPath, state),
			activeRecords: [...latest.values()].filter((record) => record.status === "active").length,
			unverifiedRecords: [...latest.values()].filter((record) => record.status === "needs_verification").length,
			revokedRecords: [...latest.values()].filter((record) => record.status === "revoked").length,
		};
	}

	startRun(input: MemoryRunStart): MemoryRun {
		return this.mutate((state) => {
			const existing = state.runs[input.rootPromptId];
			if (existing) {
				if (existing.sessionId !== input.sessionId) throw new Error("memory_run_identity_conflict");
				return structuredClone(existing);
			}
			const now = new Date().toISOString();
			const run: MemoryRun = {
				rootPromptId: input.rootPromptId,
				sessionId: input.sessionId,
				branchStartEntryId: input.branchStartEntryId,
				taskSourceEntryId: input.taskSourceEntryId,
				promptGeneration: input.promptGeneration,
				mainState: "running",
				continuationState: "none",
				sourceRevision: 0,
				sourceIds: [],
				pendingEvidenceIds: [],
				sealedManifestIds: [],
				requiredTasks: {},
				createdAt: now,
				updatedAt: now,
			};
			state.runs[input.rootPromptId] = run;
			return structuredClone(run);
		});
	}

	recordEvidence(source: MemoryEvidenceSource): MemoryRun {
		return this.mutate((state) => {
			const run = state.runs[source.rootPromptId];
			if (!run || run.sessionId !== source.sessionId) throw new Error("memory_run_not_found");
			const existing = state.sources[source.sourceId];
			if (existing) {
				if (existing.contentHash !== source.contentHash || existing.rootPromptId !== source.rootPromptId) {
					throw new Error("memory_source_identity_conflict");
				}
				run.pendingEvidenceIds = run.pendingEvidenceIds.filter((id) => id !== source.sourceId);
				return structuredClone(run);
			}
			state.sources[source.sourceId] = source;
			state.sourceReceipts[source.sourceId] = {
				sourceId: source.sourceId,
				rootPromptId: source.rootPromptId,
				contentHash: source.contentHash,
				recordedAt: new Date().toISOString(),
			};
			run.sourceIds.push(source.sourceId);
			if (!run.pendingEvidenceIds.includes(source.sourceId)) run.sourceRevision++;
			run.pendingEvidenceIds = run.pendingEvidenceIds.filter((id) => id !== source.sourceId);
			run.updatedAt = new Date().toISOString();
			return structuredClone(run);
		});
	}

	bindEvidenceSourceEntry(rootPromptId: string, sourceId: string, entryId: string): MemoryRun {
		return this.mutate((state) => {
			const run = state.runs[rootPromptId];
			const source = state.sources[sourceId];
			if (!run || !source || source.rootPromptId !== rootPromptId) throw new Error("memory_source_not_found");
			if (source.entryId !== entryId) source.entryId = entryId;
			if (run.taskSourceEntryId !== entryId) run.taskSourceEntryId = entryId;
			run.updatedAt = new Date().toISOString();
			return structuredClone(run);
		});
	}

	beginEvidence(rootPromptId: string, evidenceEventId: string): MemoryRun {
		return this.mutate((state) => {
			const run = state.runs[rootPromptId];
			if (!run) throw new Error("memory_run_not_found");
			if (state.sources[evidenceEventId] || run.pendingEvidenceIds.includes(evidenceEventId)) {
				return structuredClone(run);
			}
			run.pendingEvidenceIds.push(evidenceEventId);
			run.sourceRevision++;
			run.updatedAt = new Date().toISOString();
			return structuredClone(run);
		});
	}

	settleRun(
		rootPromptId: string,
		outcome: MemoryRun["outcome"],
		continuationState: MemoryRun["continuationState"] = "none",
	): MemoryRun {
		return this.mutate((state) => {
			const run = state.runs[rootPromptId];
			if (!run) throw new Error("memory_run_not_found");
			run.mainState = "quiescent";
			run.continuationState = continuationState;
			run.outcome = outcome;
			run.updatedAt = new Date().toISOString();
			return structuredClone(run);
		});
	}

	getRun(rootPromptId: string): MemoryRun | undefined {
		const run = this.readState().runs[rootPromptId];
		return run ? structuredClone(run) : undefined;
	}

	getEvidenceSource(sourceId: string): MemoryEvidenceSource | undefined {
		const source = this.readState().sources[sourceId];
		return source ? structuredClone(source) : undefined;
	}

	getJob(jobId: string): MemoryArchiveJob | undefined {
		const job = this.readState().jobs[jobId];
		return job ? structuredClone(job) : undefined;
	}

	refreshBudgetWaits(maxCallsPerHour: number, now = Date.now()): void {
		this.mutate((state) => {
			const cutoff = now - 60 * 60 * 1000;
			state.modelCallReservations = state.modelCallReservations.filter(
				(reservation) => Date.parse(reservation.reservedAt) > cutoff,
			);
			if (state.modelCallReservations.length >= maxCallsPerHour) return;
			for (const job of Object.values(state.jobs)) {
				if (job.status !== "waiting_budget") continue;
				job.status = "queued";
				job.reasonCode = undefined;
				job.updatedAt = new Date(now).toISOString();
			}
		});
	}

	reserveModelCall(
		jobId: string,
		attemptToken: number,
		maxCallsPerHour: number,
		now = Date.now(),
	): { reserved: true } | { reserved: false; retryAt: string } {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken) {
				throw new Error("stale_archive_worker");
			}
			const cutoff = now - 60 * 60 * 1000;
			state.modelCallReservations = state.modelCallReservations.filter(
				(reservation) => Date.parse(reservation.reservedAt) > cutoff,
			);
			if (state.modelCallReservations.length >= maxCallsPerHour) {
				const oldest = Math.min(
					...state.modelCallReservations.map((reservation) => Date.parse(reservation.reservedAt)),
				);
				const retryAt = new Date(oldest + 60 * 60 * 1000).toISOString();
				job.status = "waiting_budget";
				job.reasonCode = "archive_model_budget";
				job.leaseOwnerId = undefined;
				job.leaseExpiresAt = undefined;
				job.updatedAt = new Date(now).toISOString();
				return { reserved: false as const, retryAt };
			}
			state.modelCallReservations.push({
				reservationId: randomUUID(),
				jobId,
				reservedAt: new Date(now).toISOString(),
			});
			return { reserved: true as const };
		});
	}

	saveExtractionCheckpoint(
		jobId: string,
		attemptToken: number,
		extraction: MemoryArchiveExtraction,
	): MemoryArchiveJob {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken) {
				throw new Error("stale_archive_worker");
			}
			if (job.extractionCheckpoint) {
				const previous = job.extractionCheckpoint;
				const checked = new Set(extraction.checkedSourceIds);
				const previousUnchecked = new Set(previous.uncheckedSourceIds);
				const nextUnchecked = new Set(extraction.uncheckedSourceIds);
				const candidates = new Map(extraction.candidates.map((candidate) => [candidate.candidateKey, candidate]));
				if (
					previous.checkedSourceIds.some((sourceId) => !checked.has(sourceId)) ||
					extraction.checkedSourceIds.some(
						(sourceId) => !previous.checkedSourceIds.includes(sourceId) && !previousUnchecked.has(sourceId),
					) ||
					extraction.uncheckedSourceIds.some((sourceId) => !previousUnchecked.has(sourceId)) ||
					previous.candidates.some(
						(candidate) => JSON.stringify(candidates.get(candidate.candidateKey)) !== JSON.stringify(candidate),
					) ||
					(nextUnchecked.size >= previousUnchecked.size && checked.size <= previous.checkedSourceIds.length)
				) {
					throw new Error("memory_extraction_checkpoint_conflict");
				}
			}
			job.extractionCheckpoint = structuredClone(extraction);
			job.updatedAt = new Date().toISOString();
			return structuredClone(job);
		});
	}

	saveValidationCheckpoint(
		jobId: string,
		attemptToken: number,
		validation: MemoryCandidateValidationReceipt,
	): MemoryArchiveJob {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken) {
				throw new Error("stale_archive_worker");
			}
			const existing = job.validationReceipts[validation.candidateKey];
			if (existing && JSON.stringify(existing) !== JSON.stringify(validation)) {
				throw new Error("memory_validation_checkpoint_conflict");
			}
			job.validationReceipts[validation.candidateKey] = structuredClone(validation);
			job.updatedAt = new Date().toISOString();
			return structuredClone(job);
		});
	}

	markJobNeedsReview(jobId: string, attemptToken: number, reasonCode: string): MemoryArchiveJob {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken) {
				throw new Error("stale_archive_worker");
			}
			job.status = "needs_review";
			job.reasonCode = reasonCode;
			job.leaseOwnerId = undefined;
			job.leaseExpiresAt = undefined;
			job.updatedAt = new Date().toISOString();
			return structuredClone(job);
		});
	}

	yieldJob(jobId: string, attemptToken: number, reasonCode: string): MemoryArchiveJob {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken) {
				throw new Error("stale_archive_worker");
			}
			job.status = "queued";
			job.reasonCode = reasonCode;
			job.leaseOwnerId = undefined;
			job.leaseExpiresAt = undefined;
			job.updatedAt = new Date().toISOString();
			return structuredClone(job);
		});
	}

	registerTask(rootPromptId: string, taskId: string, archiveRole: "dependency" | "service"): MemoryRun {
		return this.mutate((state) => {
			const run = state.runs[rootPromptId];
			if (!run) throw new Error("memory_run_not_found");
			const existing = run.requiredTasks[taskId];
			if (existing && existing.archiveRole !== archiveRole) throw new Error("memory_task_identity_conflict");
			if (!existing) {
				run.requiredTasks[taskId] = { archiveRole, evidenceState: "pending" };
				run.sourceRevision++;
			}
			return structuredClone(run);
		});
	}

	recordTaskEvidence(rootPromptId: string, taskId: string, evidenceState: "durable" | "unavailable"): MemoryRun {
		return this.mutate((state) => {
			const run = state.runs[rootPromptId];
			if (!run) throw new Error("memory_run_not_found");
			const task = run.requiredTasks[taskId];
			if (!task) throw new Error("memory_task_not_found");
			if (task.evidenceState !== evidenceState) {
				task.evidenceState = evidenceState;
				run.sourceRevision++;
			}
			return structuredClone(run);
		});
	}

	sealRun(rootPromptId: string, manifest: MemorySourceManifest, job: MemoryArchiveJob): MemoryArchiveJob {
		return this.mutate((state) => {
			const run = state.runs[rootPromptId];
			if (!run || run.sourceRevision !== manifest.sourceRevision) throw new Error("memory_run_source_changed");
			const existing = state.jobs[job.jobId];
			if (existing) return structuredClone(existing);
			state.manifests[manifest.manifestId] = manifest;
			state.jobs[job.jobId] = job;
			for (const previous of Object.values(state.jobs)) {
				if (previous.jobId === job.jobId || previous.rootPromptId !== rootPromptId) continue;
				const previousManifest = state.manifests[previous.manifestId];
				if (previousManifest && previousManifest.sourceRevision < manifest.sourceRevision) {
					previous.status = "superseded";
					previous.successorJobId = job.jobId;
					previous.updatedAt = new Date().toISOString();
				}
			}
			run.sealedManifestIds.push(manifest.manifestId);
			return structuredClone(job);
		});
	}

	claimNextJob(
		workerId: string,
		leaseMs: number,
		maxFailures: number,
		maxConcurrency: number,
	): { job: MemoryArchiveJob; manifest: MemorySourceManifest; sources: MemoryEvidenceSource[] } | undefined {
		return this.mutate((state) => {
			const now = Date.now();
			for (const candidate of Object.values(state.jobs)) {
				if (
					candidate.status === "running" &&
					candidate.leaseExpiresAt !== undefined &&
					Date.parse(candidate.leaseExpiresAt) <= now
				) {
					candidate.failureCount++;
					candidate.status = candidate.failureCount >= maxFailures ? "needs_review" : "queued";
					candidate.reasonCode = "archive_worker_lease_expired";
					candidate.leaseOwnerId = undefined;
					candidate.leaseExpiresAt = undefined;
					candidate.updatedAt = new Date(now).toISOString();
				}
			}
			if (Object.values(state.jobs).filter((candidate) => candidate.status === "running").length >= maxConcurrency) {
				return undefined;
			}
			const job = Object.values(state.jobs).find((candidate) => candidate.status === "queued");
			if (!job) return undefined;
			const manifest = state.manifests[job.manifestId];
			if (!manifest) throw new Error("memory_manifest_not_found");
			const run = state.runs[job.rootPromptId];
			if (!run || run.sourceRevision !== manifest.sourceRevision) {
				job.status = "superseded";
				job.updatedAt = new Date().toISOString();
				return undefined;
			}
			job.status = "running";
			job.attemptToken++;
			job.leaseOwnerId = workerId;
			job.leaseExpiresAt = new Date(now + leaseMs).toISOString();
			job.updatedAt = new Date(now).toISOString();
			return {
				job: structuredClone(job),
				manifest: structuredClone(manifest),
				sources: manifest.sourceIds.map((sourceId) => structuredClone(state.sources[sourceId]!)),
			};
		});
	}

	completeJob(jobId: string, attemptToken: number, extraction: MemoryArchiveExtraction): MemoryArchiveJob {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken)
				throw new Error("stale_archive_worker");
			const manifest = state.manifests[job.manifestId];
			if (!manifest) throw new Error("memory_manifest_not_found");
			const checked = new Set(extraction.checkedSourceIds);
			const unchecked = new Set(extraction.uncheckedSourceIds);
			if (
				[...checked].some((sourceId) => unchecked.has(sourceId) || !manifest.sourceIds.includes(sourceId)) ||
				[...unchecked].some((sourceId) => !manifest.sourceIds.includes(sourceId)) ||
				manifest.sourceIds.some((sourceId) => !checked.has(sourceId) && !unchecked.has(sourceId))
			) {
				throw new Error("invalid_counterevidence_receipt");
			}
			if (unchecked.size > 0) {
				job.status = "completed";
				job.leaseOwnerId = undefined;
				job.leaseExpiresAt = undefined;
				job.deferred = extraction.candidates.length;
				job.reasonCode = "counterevidence_incomplete";
				job.updatedAt = new Date().toISOString();
				return structuredClone(job);
			}
			const staleCandidateKeys = extraction.candidates
				.filter((candidate) => {
					const validation = job.validationReceipts[candidate.candidateKey];
					return (
						validation !== undefined &&
						(validation.conflictRevision !== (state.conflictRevisions[conflictKey(candidate.subject)] ?? 0) ||
							validation.projectDirectiveRevision !== state.projectDirectiveRevision)
					);
				})
				.map((candidate) => candidate.candidateKey);
			if (staleCandidateKeys.length > 0) {
				for (const candidateKey of staleCandidateKeys) delete job.validationReceipts[candidateKey];
				job.status = "queued";
				job.reasonCode = "conflict_context_changed";
				job.leaseOwnerId = undefined;
				job.leaseExpiresAt = undefined;
				job.updatedAt = new Date().toISOString();
				return structuredClone(job);
			}
			let accepted = 0;
			let rejected = 0;
			let deferred = 0;
			const manifestHasGap = manifest.sourceIds.some(
				(sourceId) =>
					state.sources[sourceId]?.origin !== "assistant" && state.sources[sourceId]?.completeness !== "complete",
			);
			for (const candidate of extraction.candidates) {
				const validation = job.validationReceipts[candidate.candidateKey];
				if (
					!validation ||
					validation.supportCheck === "deferred" ||
					validation.counterEvidenceCheck === "deferred"
				) {
					deferred++;
					continue;
				}
				if (validation.supportCheck === "failed" || validation.counterEvidenceCheck === "failed") {
					rejected++;
					continue;
				}
				if (
					candidate.sourceIds.length === 0 ||
					candidate.sourceIds.some((sourceId) => !manifest.sourceIds.includes(sourceId))
				) {
					rejected++;
					continue;
				}
				if (manifestHasGap) {
					deferred++;
					continue;
				}
				const sources = candidate.sourceIds.map((sourceId) => state.sources[sourceId]!);
				if (sources.some((source) => source.completeness !== "complete")) {
					rejected++;
					continue;
				}
				if (candidate.kind === "user_rule" && !sources.some((source) => source.origin === "user")) {
					rejected++;
					continue;
				}
				const current = state.records.filter((record) => record.candidateKey === candidate.candidateKey).at(-1);
				if (current?.status === "revoked") {
					rejected++;
					continue;
				}
				const relatedMemoryIds = [
					...new Set([...(candidate.relatedMemoryIds ?? []), ...validation.conflictMemoryIds]),
				];
				const latestById = new Map<string, MemoryRecordRevision>();
				for (const record of state.records) latestById.set(record.memoryId, record);
				if (relatedMemoryIds.some((memoryId) => !latestById.has(memoryId))) {
					rejected++;
					continue;
				}
				const relations = {
					...(candidate.proposedRelation === "replaces" ? { supersedes: relatedMemoryIds } : {}),
					...(candidate.proposedRelation === "exception" ? { exceptionOf: relatedMemoryIds } : {}),
					...(candidate.proposedRelation === "conflicts" ||
					(validation.conflictMemoryIds.length > 0 && candidate.proposedRelation !== "replaces")
						? { conflictsWith: relatedMemoryIds }
						: {}),
				};
				const trustedUserAssertion =
					sources.some((source) => source.origin === "user") &&
					(candidate.kind === "user_rule" || candidate.kind === "decision");
				const record = createRecord(
					{
						candidateKey: candidate.candidateKey,
						kind: candidate.kind,
						subject: candidate.subject,
						text: candidate.text,
						scope: candidate.scope,
						machineConditions: candidate.machineConditions,
						limitations: candidate.limitations,
						status: !trustedUserAssertion
							? "needs_verification"
							: candidate.proposedRelation === "conflicts" ||
									(validation.conflictMemoryIds.length > 0 && candidate.proposedRelation !== "replaces")
								? "needs_verification"
								: "active",
						relations,
						sourceRefs: sources.map((source) => ({
							sourceId: source.sourceId,
							origin: source.origin,
							contentHash: source.contentHash,
							completeness: source.completeness,
							rootPromptId: source.rootPromptId,
							sessionId: source.sessionId,
							entryId: source.entryId,
							toolCallId: source.toolCallId,
							taskId: source.taskId,
						})),
						verification: {
							level: trustedUserAssertion ? "user_asserted" : "observed",
							checkedAt: new Date().toISOString(),
							validatedSourceRevision: manifest.sourceRevision,
						},
					},
					state.records,
				);
				state.records.push(record);
				advanceConflictRevision(state, record.subject);
				if (candidate.proposedRelation === "replaces") {
					for (const memoryId of relatedMemoryIds) {
						const replaced = latestById.get(memoryId);
						if (!replaced || replaced.status === "revoked") continue;
						state.records.push({
							...structuredClone(replaced),
							revision: replaced.revision + 1,
							status: "superseded",
							reasonCode: `superseded_by:${record.memoryId}`,
							createdAt: new Date().toISOString(),
						});
						advanceConflictRevision(state, replaced.subject);
					}
				}
				accepted++;
			}
			job.status = "completed";
			job.leaseOwnerId = undefined;
			job.leaseExpiresAt = undefined;
			job.accepted = accepted;
			job.rejected = rejected;
			job.deferred = deferred;
			job.reasonCode = undefined;
			job.updatedAt = new Date().toISOString();
			return structuredClone(job);
		});
	}

	failJob(
		jobId: string,
		attemptToken: number,
		workItemId: string,
		reasonCode: string,
		maxFailures: number,
	): MemoryArchiveJob {
		return this.mutate((state) => {
			const job = state.jobs[jobId];
			if (!job || job.status !== "running" || job.attemptToken !== attemptToken)
				throw new Error("stale_archive_worker");
			const failureCount = (job.failureCountByWorkItem[workItemId] ?? 0) + 1;
			job.failureCountByWorkItem[workItemId] = failureCount;
			job.failureCount = failureCount;
			job.status = failureCount >= maxFailures ? "needs_review" : "retryable_failed";
			job.leaseOwnerId = undefined;
			job.leaseExpiresAt = undefined;
			job.reasonCode = reasonCode;
			job.updatedAt = new Date().toISOString();
			return structuredClone(job);
		});
	}

	requeueFailedJobs(): void {
		this.mutate((state) => {
			for (const job of Object.values(state.jobs)) {
				if (job.status === "retryable_failed") job.status = "queued";
			}
		});
	}

	getEffectiveMemoryView(context: MemoryQueryContext): EffectiveMemoryRecord[] {
		const state = this.readState();
		const latest = new Map<string, MemoryRecordRevision>();
		for (const record of state.records) latest.set(record.memoryId, record);
		const unresolvedConflictIds = new Set<string>();
		const basesWithUnknownException = new Set<string>();
		for (const record of latest.values()) {
			const currentApplicability = authorityApplicability(record, state, context);
			if (record.status === "active" && currentApplicability === "unknown") {
				for (const memoryId of record.relations.exceptionOf ?? []) basesWithUnknownException.add(memoryId);
			}
			if (record.status !== "needs_verification" || currentApplicability === "not_applicable") continue;
			for (const memoryId of record.relations.conflictsWith ?? []) unresolvedConflictIds.add(memoryId);
		}
		return [...latest.values()]
			.filter(
				(record) =>
					record.status === "active" &&
					!unresolvedConflictIds.has(record.memoryId) &&
					!basesWithUnknownException.has(record.memoryId),
			)
			.map((record) => ({
				...structuredClone(record),
				applicability: authorityApplicability(record, state, context),
			}))
			.filter((record) => record.applicability === "applicable");
	}

	search(
		query: string,
		context: MemoryQueryContext,
		options: MemoryReadOptions = {},
		limit = 10,
	): EffectiveMemoryRecord[] {
		const tokens = query
			.toLocaleLowerCase()
			.split(/[^\p{L}\p{N}_-]+/u)
			.filter(Boolean);
		const state = this.readState();
		const latest = new Map<string, MemoryRecordRevision>();
		for (const record of state.records) latest.set(record.memoryId, record);
		const effectiveIds = new Set(this.getEffectiveMemoryView(context).map((record) => record.memoryId));
		const available = [...latest.values()]
			.filter((record) => {
				if (effectiveIds.has(record.memoryId)) return true;
				if (record.status === "needs_verification") return options.includeUnverified === true;
				return options.includeHistory === true;
			})
			.map((record) => ({
				...structuredClone(record),
				applicability: authorityApplicability(record, state, context),
			}))
			.filter((record) => options.includeHistory === true || record.status !== "revoked");
		const ranked = available
			.map((record) => ({
				record,
				score: tokens.reduce((score, token) => {
					const text = `${record.subject} ${record.text} ${record.limitations.join(" ")}`.toLocaleLowerCase();
					return score + (text.includes(token) ? 1 : 0);
				}, 0),
			}))
			.filter(({ score }) => tokens.length === 0 || score > 0)
			.sort((left, right) => right.score - left.score || right.record.revision - left.record.revision)
			.slice(0, Math.max(1, Math.floor(limit)));
		const availableById = new Map(available.map((record) => [record.memoryId, record]));
		const expandedIds = new Set(ranked.map(({ record }) => record.memoryId));
		let changed = true;
		while (changed) {
			changed = false;
			for (const record of available) {
				const related = [
					...(record.relations.supersedes ?? []),
					...(record.relations.exceptionOf ?? []),
					...(record.relations.conflictsWith ?? []),
				];
				if (expandedIds.has(record.memoryId)) {
					for (const memoryId of related) {
						if (availableById.has(memoryId) && !expandedIds.has(memoryId)) {
							expandedIds.add(memoryId);
							changed = true;
						}
					}
				} else if (related.some((memoryId) => expandedIds.has(memoryId))) {
					expandedIds.add(record.memoryId);
					changed = true;
				}
			}
		}
		const seedIds = new Set(ranked.map(({ record }) => record.memoryId));
		return [
			...ranked.map(({ record }) => record),
			...available.filter((record) => expandedIds.has(record.memoryId) && !seedIds.has(record.memoryId)),
		];
	}

	getMemory(
		memoryId: string,
		context: MemoryQueryContext,
		options: MemoryReadOptions = {},
	): EffectiveMemoryRecord | undefined {
		const state = this.readState();
		const record = state.records.filter((candidate) => candidate.memoryId === memoryId).at(-1);
		if (!record) return undefined;
		const currentApplicability = authorityApplicability(record, state, context);
		if (record.status === "active" && currentApplicability === "applicable") {
			const effective = this.getEffectiveMemoryView(context).find((candidate) => candidate.memoryId === memoryId);
			return effective;
		}
		if (record.status === "needs_verification" && options.includeUnverified) {
			return { ...structuredClone(record), applicability: currentApplicability };
		}
		if (options.includeHistory) return { ...structuredClone(record), applicability: currentApplicability };
		return undefined;
	}

	revokeMemory(memoryId: string, reasonCode: string): MemoryRecordRevision {
		return this.mutate((state) => {
			const current = state.records.filter((record) => record.memoryId === memoryId).at(-1);
			if (!current) throw new Error("memory_record_not_found");
			const revoked: MemoryRecordRevision = {
				...structuredClone(current),
				revision: current.revision + 1,
				status: "revoked",
				reasonCode,
				createdAt: new Date().toISOString(),
			};
			state.records.push(revoked);
			advanceConflictRevision(state, revoked.subject);
			return structuredClone(revoked);
		});
	}

	getMemoryConflictContext(query: MemoryConflictQuery): MemoryConflictContext {
		const state = this.readState();
		return {
			authorityRevision: state.revision,
			conflictRevision: state.conflictRevisions[conflictKey(query.subject)] ?? 0,
			projectDirectiveRevision: state.projectDirectiveRevision,
			records: state.records
				.filter((record) => record.subject === query.subject && scopeOverlaps(record.scope, query.scope))
				.map((record) => structuredClone(record)),
		};
	}
}
