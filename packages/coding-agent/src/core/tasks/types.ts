/** Long-running work tracked by one TaskManager. */
export type TaskKind = "bash" | "subagent" | "diagnostics" | "lsp";
export type TaskArchiveRole = "dependency" | "service";

export type TaskStatus = "running" | "cancelling" | "completed" | "blocked" | "failed" | "cancelled";

interface TaskSnapshotBase {
	taskId: string;
	kind: TaskKind;
	ownerSessionId?: string;
	rootPromptId?: string;
	archiveRole: TaskArchiveRole;
	parentTaskId?: string;
	cwd?: string;
	/** Redacted, human-readable description (never the raw unredacted command/prompt). */
	description: string;
	startedAt: string;
}

/** Immutable task snapshot. Terminal-only fields cannot appear on running tasks. */
export type TaskSnapshot<TResult = unknown> = TaskSnapshotBase &
	(
		| { status: "running" | "cancelling" }
		| { status: "completed"; completedAt: string; result?: TResult; exitCode?: number | null }
		| { status: "blocked"; completedAt: string; result: TResult; errorMessage: string }
		| { status: "failed"; completedAt: string; errorMessage: string }
		| { status: "cancelled"; completedAt: string; errorMessage: string }
	);

export interface TaskRunContext {
	taskId: string;
	signal: AbortSignal;
	/** Append a chunk of output while the run is active. */
	appendOutput: (chunk: string) => void;
}

export type TaskRunResult<TResult = unknown> =
	| { status: "completed"; result?: TResult; exitCode?: number | null }
	| { status: "blocked"; result: TResult; errorMessage: string };

export interface TaskStartRequest<TResult = unknown> {
	kind: TaskKind;
	ownerSessionId?: string;
	rootPromptId?: string;
	archiveRole?: TaskArchiveRole;
	parentTaskId?: string;
	cwd?: string;
	description: string;
	/** Executes the task's work. Must honor `ctx.signal` for cancellation. */
	run: (ctx: TaskRunContext) => Promise<TaskRunResult<TResult>>;
}

export interface TaskOutputPage {
	text: string;
	nextCursor: number;
	hasMore: boolean;
	status: TaskStatus;
}

export interface TaskWaitOptions {
	/** Milliseconds to wait for completion. 0/undefined = non-blocking snapshot. */
	timeoutMs?: number;
}

export interface TaskWaitResult {
	snapshots: TaskSnapshot[];
	/** True only when this wait's deadline elapsed while at least one requested task remained active. */
	timedOut: boolean;
}

export interface TaskStateTransition {
	taskId: string;
	kind: TaskKind;
	ownerSessionId?: string;
	rootPromptId?: string;
	archiveRole: TaskArchiveRole;
	from?: TaskStatus;
	to: TaskStatus;
	reason?: string;
}
