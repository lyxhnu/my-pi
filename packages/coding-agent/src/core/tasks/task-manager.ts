import { randomUUID } from "node:crypto";
import { TaskOutputBuffer } from "./task-output-buffer.ts";
import type {
	TaskArchiveRole,
	TaskKind,
	TaskOutputPage,
	TaskSnapshot,
	TaskStartRequest,
	TaskStateTransition,
	TaskStatus,
	TaskWaitOptions,
	TaskWaitResult,
} from "./types.ts";

interface TaskRecordBase {
	taskId: string;
	kind: TaskKind;
	ownerSessionId?: string;
	rootPromptId?: string;
	archiveRole: TaskArchiveRole;
	parentTaskId?: string;
	cwd?: string;
	description: string;
	startedAt: string;
	buffer: TaskOutputBuffer;
	abortController: AbortController;
	settled: Promise<void>;
	cancelReason?: string;
}

type TaskRecord = TaskRecordBase &
	(
		| { status: "running" | "cancelling" }
		| { status: "completed"; completedAt: string; result?: unknown; exitCode?: number | null }
		| { status: "blocked"; completedAt: string; result: unknown; errorMessage: string }
		| { status: "failed"; completedAt: string; errorMessage: string }
		| { status: "cancelled"; completedAt: string; errorMessage: string }
	);

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "blocked", "failed", "cancelled"]);

function isActive(record: TaskRecord): boolean {
	return record.status === "running" || record.status === "cancelling";
}

function toSnapshot(record: TaskRecord): TaskSnapshot {
	const base = {
		taskId: record.taskId,
		kind: record.kind,
		ownerSessionId: record.ownerSessionId,
		rootPromptId: record.rootPromptId,
		archiveRole: record.archiveRole,
		parentTaskId: record.parentTaskId,
		cwd: record.cwd,
		description: record.description,
		startedAt: record.startedAt,
	};
	switch (record.status) {
		case "running":
		case "cancelling":
			return { ...base, status: record.status };
		case "completed":
			return {
				...base,
				status: "completed",
				completedAt: record.completedAt,
				result: record.result,
				exitCode: record.exitCode,
			};
		case "blocked":
			return {
				...base,
				status: "blocked",
				completedAt: record.completedAt,
				result: record.result,
				errorMessage: record.errorMessage,
			};
		case "failed":
		case "cancelled":
			return {
				...base,
				status: record.status,
				completedAt: record.completedAt,
				errorMessage: record.errorMessage,
			};
	}
}

function transitionTask(
	record: TaskRecord,
	next:
		| { status: "cancelling"; reason: string }
		| { status: "completed"; result?: unknown; exitCode?: number | null }
		| { status: "blocked"; result: unknown; errorMessage: string }
		| { status: "failed"; errorMessage: string }
		| { status: "cancelled"; errorMessage: string },
): TaskRecord {
	if (TERMINAL_STATUSES.has(record.status)) return record;
	if (next.status === "cancelling") {
		if (record.status !== "running") return record;
		return { ...record, status: "cancelling", cancelReason: next.reason };
	}
	if (record.status === "cancelling" && next.status !== "cancelled") return record;
	const completedAt = new Date().toISOString();
	switch (next.status) {
		case "completed":
			return { ...record, status: "completed", completedAt, result: next.result, exitCode: next.exitCode };
		case "blocked":
			return { ...record, status: "blocked", completedAt, result: next.result, errorMessage: next.errorMessage };
		case "failed":
			return { ...record, status: "failed", completedAt, errorMessage: next.errorMessage };
		case "cancelled":
			return { ...record, status: "cancelled", completedAt, errorMessage: next.errorMessage };
	}
}

function missingTask(taskId: string): TaskSnapshot {
	const now = new Date().toISOString();
	return {
		taskId,
		kind: "bash",
		archiveRole: "dependency",
		description: "",
		status: "failed",
		startedAt: now,
		completedAt: now,
		errorMessage: "not found",
	};
}

/** Single-writer registry for every long-running unit of work in one AgentSession. */
export class TaskManager {
	private tasks = new Map<string, TaskRecord>();
	private readonly onTransition?: (transition: TaskStateTransition) => void;
	private readonly resolveOwnership?: () => { ownerSessionId?: string; rootPromptId?: string };
	private readonly onOutput?: (taskId: string, chunk: string) => void;

	constructor(
		onTransition?: (transition: TaskStateTransition) => void,
		resolveOwnership?: () => { ownerSessionId?: string; rootPromptId?: string },
		onOutput?: (taskId: string, chunk: string) => void,
	) {
		this.onTransition = onTransition;
		this.resolveOwnership = resolveOwnership;
		this.onOutput = onOutput;
	}

	private storeTransition(previous: TaskRecord, next: TaskRecord): void {
		if (previous === next) return;
		this.tasks.set(next.taskId, next);
		this.onTransition?.({
			taskId: next.taskId,
			kind: next.kind,
			ownerSessionId: next.ownerSessionId,
			rootPromptId: next.rootPromptId,
			archiveRole: next.archiveRole,
			from: previous.status,
			to: next.status,
			...(next.status === "cancelling"
				? { reason: next.cancelReason }
				: "errorMessage" in next
					? { reason: next.errorMessage }
					: {}),
		});
	}

	start<TResult>(request: TaskStartRequest<TResult>): TaskSnapshot<TResult> {
		const taskId = randomUUID();
		const ownership = this.resolveOwnership?.() ?? {};
		const abortController = new AbortController();
		const buffer = new TaskOutputBuffer();
		let resolveSettled = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const record: TaskRecord = {
			taskId,
			kind: request.kind,
			ownerSessionId: request.ownerSessionId ?? ownership.ownerSessionId,
			rootPromptId: request.rootPromptId ?? ownership.rootPromptId,
			archiveRole: request.archiveRole ?? (request.kind === "lsp" ? "service" : "dependency"),
			parentTaskId: request.parentTaskId,
			cwd: request.cwd,
			description: request.description,
			status: "running",
			startedAt: new Date().toISOString(),
			buffer,
			abortController,
			settled,
		};
		this.tasks.set(taskId, record);
		this.onTransition?.({
			taskId,
			kind: request.kind,
			ownerSessionId: record.ownerSessionId,
			rootPromptId: record.rootPromptId,
			archiveRole: record.archiveRole,
			to: "running",
		});

		const ctx = {
			taskId,
			signal: abortController.signal,
			appendOutput: (chunk: string) => {
				const current = this.tasks.get(taskId);
				if (current && isActive(current)) {
					this.onOutput?.(taskId, chunk);
					current.buffer.append(chunk);
				}
			},
		};

		Promise.resolve()
			.then(() => {
				if (!abortController.signal.aborted) return request.run(ctx);
				const current = this.tasks.get(taskId);
				if (current) {
					this.storeTransition(
						current,
						transitionTask(current, {
							status: "cancelled",
							errorMessage: current.cancelReason ?? "cancelled",
						}),
					);
				}
				return undefined;
			})
			.then((result) => {
				if (!result) return;
				const current = this.tasks.get(taskId);
				if (!current) return;
				if (abortController.signal.aborted) {
					this.storeTransition(
						current,
						transitionTask(current, {
							status: "cancelled",
							errorMessage: current.cancelReason ?? "cancelled",
						}),
					);
					return;
				}
				this.storeTransition(current, transitionTask(current, result));
			})
			.catch((error: unknown) => {
				const current = this.tasks.get(taskId);
				if (!current) return;
				const message = error instanceof Error ? error.message : String(error);
				this.storeTransition(
					current,
					transitionTask(
						current,
						abortController.signal.aborted
							? { status: "cancelled", errorMessage: current.cancelReason ?? message }
							: { status: "failed", errorMessage: message },
					),
				);
			})
			.finally(resolveSettled);

		return toSnapshot(record) as TaskSnapshot<TResult>;
	}

	get(taskId: string): TaskSnapshot | undefined {
		const record = this.tasks.get(taskId);
		return record ? toSnapshot(record) : undefined;
	}

	async awaitSettled(taskId: string): Promise<TaskSnapshot> {
		const record = this.tasks.get(taskId);
		if (!record) return missingTask(taskId);
		await record.settled;
		return this.get(taskId) ?? missingTask(taskId);
	}

	read(taskId: string, cursor?: number): TaskOutputPage | undefined {
		const record = this.tasks.get(taskId);
		if (!record) return undefined;
		const page = record.buffer.read(cursor);
		return { ...page, status: record.status };
	}

	async wait(taskIds: string[], options?: TaskWaitOptions): Promise<TaskWaitResult> {
		const records = taskIds
			.map((id) => this.tasks.get(id))
			.filter((record): record is TaskRecord => record !== undefined);
		const pending = records.filter(isActive);
		const timeoutMs = options?.timeoutMs ?? 0;
		let timedOut = false;
		if (timeoutMs > 0 && pending.length > 0) {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const winner = await Promise.race([
				Promise.all(pending.map((record) => record.settled)).then(() => "settled" as const),
				new Promise<"timeout">((resolve) => {
					timeout = setTimeout(() => resolve("timeout"), timeoutMs);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			timedOut = winner === "timeout";
		}
		return { snapshots: taskIds.map((id) => this.get(id) ?? missingTask(id)), timedOut };
	}

	cancel(taskId: string, reason = "cancelled"): TaskSnapshot | undefined {
		const record = this.tasks.get(taskId);
		if (!record) return undefined;
		if (!isActive(record)) return toSnapshot(record);
		for (const child of this.tasks.values()) {
			if (child.parentTaskId === taskId && isActive(child)) this.cancel(child.taskId, reason);
		}
		if (record.status === "running") {
			this.storeTransition(record, transitionTask(record, { status: "cancelling", reason }));
			record.abortController.abort(reason);
		}
		return this.get(taskId);
	}

	cancelByOwner(sessionId: string, reason: string): void {
		for (const record of this.tasks.values()) {
			if (record.ownerSessionId === sessionId && isActive(record)) this.cancel(record.taskId, reason);
		}
	}

	cancelAll(reason: string): void {
		for (const record of this.tasks.values()) {
			if (isActive(record)) this.cancel(record.taskId, reason);
		}
	}

	list(ownerSessionId?: string): TaskSnapshot[] {
		return [...this.tasks.values()]
			.filter((record) => ownerSessionId === undefined || record.ownerSessionId === ownerSessionId)
			.map(toSnapshot);
	}
}
