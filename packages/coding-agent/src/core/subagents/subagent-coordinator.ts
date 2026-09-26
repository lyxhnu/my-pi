/**
 * Grok-aligned subagent orchestration: cascades every subagent run through the shared `TaskManager`
 * (kind: "subagent") so `get_task_output`/`kill_task` can poll/cancel subagents exactly like background
 * bash. Actually running a subagent is delegated to a `SubagentChildRunner` callback injected by
 * `AgentSession` (see pi-child-runner.ts) — this class only owns spawn bookkeeping, depth enforcement,
 * isolation (worktree) setup/teardown, resume_from lookup, and structured result storage.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type BuiltinSubagentType,
	DEFAULT_CAPABILITY_MODE_BY_TYPE,
	type SubagentCapabilityMode,
} from "../../builtin-agents/index.ts";
import type { ExecutionUpgradeConfig } from "../execution-upgrade.ts";
import type { TaskManager } from "../tasks/task-manager.ts";
import type { TaskSnapshot } from "../tasks/types.ts";
import {
	type BlockedSubagentSubmission,
	type CompletedSubagentSubmission,
	isSubagentTaskResult,
	type SubagentTaskResult,
} from "./protocol.ts";

export type { BuiltinSubagentType, SubagentCapabilityMode } from "../../builtin-agents/index.ts";

/** Grok-aligned: subagents cannot spawn further subagents (depth 1 is the deepest child). */
export const MAX_SUBAGENT_DEPTH = 1;

export type SubagentIsolation = "none" | "worktree";

export interface SubagentChildRequest {
	taskId: string;
	execution?: { model: Model<Api>; thinkingLevel: ThinkingLevel; upgrade: ExecutionUpgradeConfig };
	agentType: BuiltinSubagentType;
	capabilityMode: SubagentCapabilityMode;
	cwd: string;
	prompt: string;
}

export type SubagentChildResult =
	| { status: "completed"; submission: CompletedSubagentSubmission }
	| { status: "blocked"; submission: BlockedSubagentSubmission }
	| {
			status: "failed" | "cancelled";
			errorCode: "missing_submission" | "execution_failed" | "cancelled";
			errorMessage: string;
	  };

/** Actually executes one subagent turn. Injected by AgentSession (see pi-child-runner.ts). Must not throw. */
export type SubagentChildRunner = (request: SubagentChildRequest, signal: AbortSignal) => Promise<SubagentChildResult>;

export interface SubagentSpawnRequest {
	agentType: BuiltinSubagentType;
	/** Short, human-readable description shown while the subagent runs (never the full prompt). */
	description: string;
	prompt: string;
	capabilityMode?: SubagentCapabilityMode;
	isolation?: SubagentIsolation;
	/** Default true, matching Grok: the model gets a task_id back immediately and polls via get_task_output. */
	runInBackground?: boolean;
	/** A previous subagent task_id whose recorded output is prepended as context. */
	resumeFrom?: string;
}

export interface SubagentSpawnHandle {
	taskId: string;
	runInBackground: boolean;
}

export interface SubagentCoordinatorOptions {
	captureExecution?: () => NonNullable<SubagentChildRequest["execution"]>;
	/** Depth of the *current* session (0 for the root session, since children are depth+1). */
	depth: number;
	cwd: string;
	ownerSessionId?: string;
	rootPromptId?: string;
	/** Resolve the receiving top-level run when each task is spawned. */
	getRootPromptId?: () => string | undefined;
}

const MAX_PATCH_BYTES = 100 * 1024 * 1024;

interface IsolatedCwd {
	cwd: string;
	applyChanges?: () => void;
	cleanup?: () => void;
}

/** `worktree` is a strict transaction: setup failure aborts, and successful child changes are applied atomically to the parent checkout. */
function resolveIsolatedCwd(baseCwd: string, isolation: SubagentIsolation): IsolatedCwd {
	if (isolation !== "worktree") return { cwd: baseCwd };
	const worktreeDir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
	rmSync(worktreeDir, { recursive: true, force: true }); // git worktree add requires the target to not exist
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], { cwd: baseCwd, stdio: "ignore" });
		return {
			cwd: worktreeDir,
			applyChanges: () => {
				execFileSync("git", ["add", "--intent-to-add", "--", "."], { cwd: worktreeDir, stdio: "ignore" });
				const patch = execFileSync("git", ["diff", "--binary", "--full-index", "HEAD", "--"], {
					cwd: worktreeDir,
					encoding: "buffer",
					maxBuffer: MAX_PATCH_BYTES,
				});
				if (patch.length === 0) return;
				execFileSync("git", ["apply", "--check", "--whitespace=nowarn", "-"], {
					cwd: baseCwd,
					input: patch,
					stdio: ["pipe", "ignore", "pipe"],
				});
				execFileSync("git", ["apply", "--whitespace=nowarn", "-"], {
					cwd: baseCwd,
					input: patch,
					stdio: ["pipe", "ignore", "pipe"],
				});
			},
			cleanup: () => {
				execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: baseCwd, stdio: "ignore" });
			},
		};
	} catch (error) {
		throw new Error(
			`Could not create isolated git worktree for subagent: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export class SubagentCoordinator {
	private readonly taskManager: TaskManager;
	private readonly runChild: SubagentChildRunner;
	private readonly options: SubagentCoordinatorOptions;

	constructor(taskManager: TaskManager, runChild: SubagentChildRunner, options: SubagentCoordinatorOptions) {
		this.taskManager = taskManager;
		this.runChild = runChild;
		this.options = options;
	}

	/** Whether the `task` tool should be registered at all: false once MAX_SUBAGENT_DEPTH is reached. */
	canSpawn(): boolean {
		return this.options.depth < MAX_SUBAGENT_DEPTH;
	}

	spawn(request: SubagentSpawnRequest): SubagentSpawnHandle {
		if (!this.canSpawn()) {
			throw new Error(
				`Subagents cannot spawn further subagents (depth ${this.options.depth} already at MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}).`,
			);
		}
		const capabilityMode = request.capabilityMode ?? DEFAULT_CAPABILITY_MODE_BY_TYPE[request.agentType];
		const isolation = request.isolation ?? "none";
		const runInBackground = request.runInBackground ?? true;

		let prompt = request.prompt;
		if (request.resumeFrom) {
			const priorSnapshot = this.taskManager.get(request.resumeFrom);
			if (
				!priorSnapshot ||
				priorSnapshot.kind !== "subagent" ||
				(priorSnapshot.status !== "completed" && priorSnapshot.status !== "blocked") ||
				!isSubagentTaskResult(priorSnapshot.result)
			) {
				throw new Error(`resume_from task id "${request.resumeFrom}" has no structured subagent result.`);
			}
			prompt = `Resumed from subagent task ${request.resumeFrom}. Previous structured result:\n${JSON.stringify(priorSnapshot.result)}\n\nNew instructions:\n${request.prompt}`;
		}

		const { cwd, applyChanges, cleanup } = resolveIsolatedCwd(this.options.cwd, isolation);
		const runChild = this.runChild;
		const execution = this.options.captureExecution?.();

		const snapshot = this.taskManager.start({
			kind: "subagent",
			ownerSessionId: this.options.ownerSessionId,
			rootPromptId: this.options.getRootPromptId?.() ?? this.options.rootPromptId,
			archiveRole: "dependency",
			cwd,
			description: request.description,
			run: async (ctx) => {
				try {
					const result = await runChild(
						{ taskId: ctx.taskId, execution, agentType: request.agentType, capabilityMode, cwd, prompt },
						ctx.signal,
					);
					if ("errorMessage" in result) throw new Error(result.errorMessage);
					const taskResult: SubagentTaskResult = {
						agentType: request.agentType,
						capabilityMode,
						isolation,
						cwd,
						submission: result.submission,
					};
					ctx.appendOutput(JSON.stringify(taskResult));
					if (result.status === "blocked") {
						return { status: "blocked" as const, result: taskResult, errorMessage: result.submission.blocker };
					}
					applyChanges?.();
					return { status: "completed" as const, result: taskResult, exitCode: 0 };
				} finally {
					cleanup?.();
				}
			},
		});

		return { taskId: snapshot.taskId, runInBackground };
	}

	/** Waits up to `timeoutMs` for a subagent task to settle (foreground mode). Never cancels on timeout. */
	async awaitForeground(taskId: string, timeoutMs: number): Promise<TaskSnapshot> {
		const { snapshots } = await this.taskManager.wait([taskId], { timeoutMs });
		const snapshot = snapshots[0];
		return (
			snapshot ?? {
				taskId,
				kind: "subagent",
				archiveRole: "dependency",
				description: "",
				status: "failed",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				errorMessage: "not found",
			}
		);
	}
}
