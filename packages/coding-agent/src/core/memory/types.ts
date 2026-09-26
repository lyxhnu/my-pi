export type MemoryKind = "user_rule" | "decision" | "implementation_fact" | "lesson";
export type MemoryRecordStatus = "active" | "needs_verification" | "superseded" | "revoked";
export type MemoryApplicability = "applicable" | "not_applicable" | "unknown";
export type MemoryVerificationLevel = "user_asserted" | "observed" | "tested";
export type MemorySourceOrigin = "user" | "runtime" | "extension" | "tool" | "subagent" | "assistant";

export interface MemorySourceRef {
	sourceId: string;
	origin: MemorySourceOrigin;
	contentHash: string;
	completeness: "complete" | "partial";
	sessionId?: string;
	rootPromptId?: string;
	entryId?: string;
	durableArtifactId?: string;
	toolCallId?: string;
	taskId?: string;
}

export interface MemoryScopeV2 {
	project: true;
	modulePaths?: string[];
	scene?: string;
	gitRef?: string;
	temporal?: "current" | "historical";
}

export type MemoryMachineCondition =
	| { kind: "scene"; value: string }
	| { kind: "git_ref"; value: string }
	| { kind: "runtime"; value: string }
	| { kind: "platform"; value: string }
	| { kind: "file_hash"; path: string; hash: string }
	| { kind: "directory_hash"; path: string; hash: string };

export interface MemoryVerification {
	level: MemoryVerificationLevel;
	checkedAt: string;
	dependencyManifestId?: string;
	validatedSourceRevision?: number;
}

export interface MemoryRelations {
	supersedes?: string[];
	exceptionOf?: string[];
	conflictsWith?: string[];
}

export interface MemoryRecordRevision {
	memoryId: string;
	revision: number;
	candidateKey: string;
	kind: MemoryKind;
	subject: string;
	text: string;
	scope: MemoryScopeV2;
	machineConditions: MemoryMachineCondition[];
	limitations: string[];
	sourceRefs: MemorySourceRef[];
	verification: MemoryVerification;
	status: MemoryRecordStatus;
	relations: MemoryRelations;
	reasonCode: string;
	createdAt: string;
}

export interface MemoryRecordInput {
	candidateKey: string;
	kind: MemoryKind;
	subject: string;
	text: string;
	scope: MemoryScopeV2;
	status: MemoryRecordStatus;
	sourceRefs: MemorySourceRef[];
	verification: MemoryVerification;
	machineConditions?: MemoryMachineCondition[];
	limitations?: string[];
	relations?: MemoryRelations;
	reasonCode?: string;
}

export interface MemoryQueryContext {
	cwd?: string;
	scene?: string;
	gitRef?: string;
	runtime?: string;
	platform?: string;
}

export interface MemoryReadOptions {
	includeUnverified?: boolean;
	includeHistory?: boolean;
}

export interface EffectiveMemoryRecord extends MemoryRecordRevision {
	applicability: MemoryApplicability;
}

export interface MemoryConflictQuery {
	subject: string;
	scope: MemoryScopeV2;
}

export interface MemoryConflictContext {
	authorityRevision: number;
	conflictRevision: number;
	projectDirectiveRevision: number;
	records: MemoryRecordRevision[];
}

export interface MemoryArchiveStatus {
	authorityRevision: number;
	runs: number;
	jobs: Record<MemoryArchiveJobStatus, number>;
	unprocessedSources: number;
	deferredCandidates: number;
	missingEvidenceTasks: number;
	technicalFailures: number;
	projectDirectives: number;
	nextSchedulableAt?: string;
	derivedViewStale: boolean;
	activeRecords: number;
	unverifiedRecords: number;
	revokedRecords: number;
}

export interface MemoryAuthorityState {
	schemaVersion: 2;
	revision: number;
	records: MemoryRecordRevision[];
	jobs: Record<string, MemoryArchiveJob>;
	runs: Record<string, MemoryRun>;
	manifests: Record<string, MemorySourceManifest>;
	sources: Record<string, MemoryEvidenceSource>;
	sourceReceipts: Record<string, MemorySourceReceipt>;
	conflicts: Record<string, unknown>;
	projectDirectives: Record<string, unknown>;
	conflictRevisions: Record<string, number>;
	projectDirectiveRevision: number;
	modelCallReservations: Array<{ reservationId: string; jobId: string; reservedAt: string }>;
}

export interface MemoryEvidenceInput {
	sourceId: string;
	origin: MemorySourceOrigin;
	content: string;
	visibility: "session" | "project_rule";
	completeness?: "complete" | "partial";
	entryId?: string;
	toolCallId?: string;
	taskId?: string;
}

export interface MemoryEvidenceSource extends MemoryEvidenceInput {
	rootPromptId: string;
	sessionId: string;
	contentHash: string;
	completeness: "complete" | "partial";
	sequence: number;
}

export interface MemorySourceReceipt {
	sourceId: string;
	rootPromptId: string;
	contentHash: string;
	recordedAt: string;
}

export interface MemoryRun {
	rootPromptId: string;
	sessionId: string;
	branchStartEntryId?: string;
	taskSourceEntryId?: string;
	promptGeneration?: number;
	mainState: "running" | "quiescent";
	continuationState: "pending" | "none" | "outcome_unknown";
	outcome?: "completed" | "stopped" | "failed" | "aborted" | "interrupted" | "superseded";
	sourceRevision: number;
	sourceIds: string[];
	pendingEvidenceIds: string[];
	sealedManifestIds: string[];
	requiredTasks: Record<
		string,
		{ archiveRole: "dependency" | "service"; evidenceState: "pending" | "durable" | "unavailable" }
	>;
	createdAt: string;
	updatedAt: string;
}

export interface MemoryRunStart {
	rootPromptId: string;
	sessionId: string;
	branchStartEntryId?: string;
	taskSourceEntryId?: string;
	promptGeneration?: number;
}

export interface MemorySourceManifest {
	manifestId: string;
	rootPromptId: string;
	sourceRevision: number;
	sourceIds: string[];
	contentHash: string;
	sealedAt: string;
}

export type MemoryArchiveJobStatus =
	| "queued"
	| "running"
	| "waiting_budget"
	| "waiting_dependency"
	| "retryable_failed"
	| "needs_review"
	| "superseded"
	| "completed";

export interface MemoryArchiveJob {
	jobId: string;
	manifestId: string;
	rootPromptId: string;
	status: MemoryArchiveJobStatus;
	attemptToken: number;
	leaseOwnerId?: string;
	leaseExpiresAt?: string;
	failureCount: number;
	failureCountByWorkItem: Record<string, number>;
	accepted: number;
	rejected: number;
	deferred: number;
	createdAt: string;
	updatedAt: string;
	reasonCode?: string;
	successorJobId?: string;
	extractionCheckpoint?: MemoryArchiveExtraction;
	validationReceipts: Record<string, MemoryCandidateValidationReceipt>;
}

export interface MemoryExtractionCandidate {
	candidateKey: string;
	kind: MemoryKind;
	subject: string;
	text: string;
	scope: MemoryScopeV2;
	sourceIds: string[];
	machineConditions?: MemoryMachineCondition[];
	limitations?: string[];
	relations?: MemoryRelations;
	relatedMemoryIds?: string[];
	proposedRelation?: "new" | "equivalent" | "replaces" | "exception" | "conflicts";
}

export interface MemoryArchiveExtraction {
	checkedSourceIds: string[];
	uncheckedSourceIds: string[];
	candidates: MemoryExtractionCandidate[];
}

export interface MemoryCandidateValidation {
	candidateKey: string;
	supportCheck: "passed" | "failed" | "deferred";
	counterEvidenceCheck: "passed" | "failed" | "deferred";
	checkedSourceIds: string[];
	conflictMemoryIds: string[];
	reasonCode: string;
}

export interface MemoryCandidateValidationReceipt extends MemoryCandidateValidation {
	conflictRevision: number;
	projectDirectiveRevision: number;
}
