import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { intersectPermissions } from "./permissions.ts";
import { contentChunk, queryControlPage, type SubagentQueryOptions, summarizeMail, summarizeRun } from "./queries.ts";
import { SubagentRunScheduler } from "./run-scheduler.ts";
import { recoverSubagentSession } from "./session-context.ts";
import { hasSubagentMailReceipt, subagentMailMessage } from "./session-mailbox.ts";
import {
	isSubagentTerminal,
	SUBAGENT_LIMITS,
	type SubagentCaller,
	type SubagentControlEvent,
	type SubagentControlRecord,
	SubagentError,
	type SubagentFollowupInput,
	type SubagentIdentity,
	type SubagentMail,
	type SubagentPermission,
	type SubagentRootPhase,
	type SubagentRun,
	type SubagentRuntime,
	type SubagentRuntimeFactory,
	type SubagentSafePoint,
	type SubagentSpawnInput,
	type SubagentTerminalState,
} from "./types.ts";

export interface RootCoordinatorOptions {
	session: SessionManager;
	factory: SubagentRuntimeFactory;
	permission: () => SubagentPermission;
	rootContext: (selection: SubagentSpawnInput["context"]) => AgentMessage[];
	/** Must actually settle local operations left by an earlier host. */
	recover: () => Promise<void>;
	/** The host retains the root lease through prompt, tools and shutdown hooks. */
	root?: { stop: () => Promise<void>; close: () => Promise<void> };
}

interface Execution {
	controller: AbortController;
	done?: Promise<void>;
	committed: boolean;
}

/** One instance owns every descendant; no child constructs its own coordinator. */
export class RootSubagentCoordinator {
	readonly rootSessionId: string;
	readonly directory: string;
	readonly #options: RootCoordinatorOptions;
	readonly #agents = new Map<string, SubagentIdentity>();
	readonly #runtimes = new Map<string, SubagentRuntime>();
	readonly #executions = new Map<string, Execution>();
	readonly #scheduler = new SubagentRunScheduler();
	readonly #rootRuns = new Map<string, SubagentRun>();
	readonly #mail = new Map<string, SubagentMail>();
	readonly #listeners = new Set<() => void>();
	readonly #notifications = new Map<string, number>();
	readonly #updatesRead = new Map<string, number>();
	readonly #activityWrites = new Map<string, number>();
	readonly #pendingRequests = new Map<string, Promise<SubagentRun>>();
	#phase: SubagentRootPhase = "opening";
	#pendingAgents = 0;
	#version = 0;
	#closePromise?: Promise<void>;
	#failure?: unknown;

	private constructor(options: RootCoordinatorOptions) {
		this.#options = options;
		const owner = options.session.claimRootOwnership();
		this.rootSessionId = owner.rootSessionId;
		this.directory = join(options.session.getSessionDir(), ".subagents", this.rootSessionId);
		mkdirSync(this.directory, { recursive: true });
	}

	static async open(options: RootCoordinatorOptions): Promise<RootSubagentCoordinator> {
		const coordinator = new RootSubagentCoordinator(options);
		const unfinished = new Map<string, SubagentRun>();
		for (const record of options.session.readSubagentControl()) {
			coordinator.#version = record.sequence;
			coordinator.#observeUpdate(record);
			const event = record.control;
			if (event.kind === "agent_created") {
				if (coordinator.#agents.has(event.agent.agentId)) throw new SubagentError("duplicate_agent_commit");
				coordinator.#agents.set(event.agent.agentId, event.agent);
				options.session
					.getRootOwnership()!
					.registerChild(event.agent.agentId, event.agent.sessionId, event.agent.sessionFile, true);
				unfinished.set(event.run.runId, event.run);
			} else if (event.kind === "run_accepted" || event.kind === "run_updated")
				unfinished.set(event.run.runId, event.run);
			else if (event.kind === "run_finished") unfinished.delete(event.run.runId);
			else if (event.kind === "mail") {
				if (event.mail.state === "pending") coordinator.#mail.set(event.mail.messageId, event.mail);
				else coordinator.#mail.delete(event.mail.messageId);
			}
		}
		if (coordinator.#agents.size > SUBAGENT_LIMITS.createdAgents)
			throw new SubagentError("control_log_quota_invalid");
		coordinator.#commit({ kind: "root_phase", phase: "opening", processId: process.pid });
		for (const run of unfinished.values()) {
			if (run.state === "queued") {
				coordinator.#commit({
					kind: "run_finished",
					run: { ...run, state: "cancelled", finishedAt: Date.now(), error: "root_reopened" },
				});
				coordinator.#endRunMail(run.runId);
				unfinished.delete(run.runId);
			} else coordinator.#commit({ kind: "run_updated", run: { ...run, state: "recovering" } });
		}
		await options.recover();
		recoverSubagentSession(options.session);
		for (const mail of coordinator.#mail.values()) {
			if (
				mail.targetAgentId === coordinator.rootSessionId &&
				hasSubagentMailReceipt(options.session, mail.messageId)
			) {
				coordinator.#commit({ kind: "mail", mail: { ...mail, state: "delivered" } });
				coordinator.#mail.delete(mail.messageId);
			}
		}
		for (const agent of coordinator.#agents.values()) {
			const pending = [...coordinator.#mail.values()]
				.filter((mail) => mail.targetAgentId === agent.agentId)
				.map((mail) => mail.messageId);
			const delivered = await options.factory.recover(structuredClone(agent), pending);
			for (const id of delivered) {
				if (!pending.includes(id)) throw new SubagentError("invalid_mail_receipt");
				const mail = coordinator.#mail.get(id)!;
				coordinator.#commit({ kind: "mail", mail: { ...mail, state: "delivered" } });
				coordinator.#mail.delete(id);
			}
		}
		for (const run of unfinished.values()) {
			coordinator.#commit({
				kind: "run_finished",
				run: {
					...run,
					state: "interrupted",
					finishedAt: Date.now(),
					effectsUnknown: true,
					error: "previous_host_closed",
				},
			});
			coordinator.#endRunMail(run.runId);
		}
		coordinator.#phase = "open";
		coordinator.#commit({ kind: "root_phase", phase: "open", processId: process.pid });
		return coordinator;
	}

	get phase(): SubagentRootPhase {
		return this.#phase;
	}
	get processId(): number {
		return process.pid;
	}
	get usage(): {
		created: number;
		pending: number;
		active: number;
		queued: number;
		queuedBytes: number;
		mail: number;
	} {
		return {
			created: this.#agents.size,
			pending: this.#pendingAgents,
			active: this.#scheduler.activeCount,
			queued: this.#scheduler.queuedCount,
			queuedBytes: this.#scheduler.queuedBytes,
			mail: this.#mail.size,
		};
	}

	beginRootRun(): SubagentCaller {
		this.#assertOpen();
		if (this.#rootRuns.size) throw new SubagentError("root_run_busy");
		const run = this.#newRun(this.rootSessionId, this.rootSessionId, "", "", "", this.#options.permission());
		run.state = "running";
		run.startedAt = Date.now();
		this.#commit({ kind: "run_accepted", run });
		this.#rootRuns.set(run.runId, run);
		return this.callerFor(run.runId);
	}

	endRootRun(runId: string, state: SubagentTerminalState): void {
		const run = this.#rootRuns.get(runId);
		if (!run) throw new SubagentError("run_not_active");
		this.#commit({ kind: "run_finished", run: { ...run, state, finishedAt: Date.now() } });
		this.#rootRuns.delete(runId);
		this.#activityWrites.delete(runId);
		this.#endRunMail(runId);
	}

	cancelRootRun(runId: string): void {
		const run = this.#rootRuns.get(runId);
		if (!run || run.state === "stopping") return;
		run.state = "stopping";
		try {
			this.#commit({ kind: "run_cancelled", runId, scope: "run", reason: "root_cancelled" });
			this.#commit({ kind: "run_updated", run });
		} finally {
			// Accepted children can outlive their issuer. Uncommitted preparations
			// cannot become accepted descendants after that issuer is cancelled.
			for (const child of this.#scheduler.all)
				if (child.issuerRunId === runId && !this.#executions.get(child.runId)?.committed)
					this.#executions.get(child.runId)?.controller.abort();
		}
	}

	failRootRun(runId: string, error: unknown): void {
		const run = this.#rootRuns.get(runId);
		if (run) {
			run.state = "stopping";
			run.blockingReason = "root_cleanup_failed";
			try {
				this.#commit({ kind: "run_updated", run });
			} finally {
				this.#fail(error);
			}
		} else this.#fail(error);
	}

	callerFor(runId: string): SubagentCaller {
		const run = this.#rootRuns.get(runId) ?? this.#scheduler.get(runId);
		if (!run) throw new SubagentError("run_not_active");
		return { rootSessionId: this.rootSessionId, agentId: run.agentId, runId, permission: this.#effective(run) };
	}

	markExternalEffect(runId: string): void {
		const run = this.#rootRuns.get(runId) ?? this.#scheduler.get(runId);
		if (!run || isSubagentTerminal(run.state)) throw new SubagentError("run_not_active");
		if (run.effectsUnknown) return;
		run.effectsUnknown = true;
		this.#commit({ kind: "run_updated", run });
	}

	spawn(caller: SubagentCaller, input: SubagentSpawnInput, toolCallId: string): Promise<SubagentRun> {
		const key = JSON.stringify([caller.runId, toolCallId]);
		const pending = this.#pendingRequests.get(key);
		if (pending) return pending;
		const promise = this.#spawn(caller, input, toolCallId).finally(() => this.#pendingRequests.delete(key));
		this.#pendingRequests.set(key, promise);
		return promise;
	}

	async #spawn(caller: SubagentCaller, input: SubagentSpawnInput, toolCallId: string): Promise<SubagentRun> {
		this.#assertCaller(caller, true);
		const repeated = this.#findRequest(caller.runId, toolCallId);
		if (repeated) return repeated;
		const bytes = Buffer.byteLength(JSON.stringify(input));
		if (bytes > SUBAGENT_LIMITS.taskBytes) throw new SubagentError("payload_too_large");
		if (this.#agents.size + this.#pendingAgents >= SUBAGENT_LIMITS.createdAgents)
			throw new SubagentError("agent_creation_limit");
		const permission = intersectPermissions(this.callerFor(caller.runId).permission, input.permission);
		const agentId = randomUUID();
		const sessionId = randomUUID();
		const agent: SubagentIdentity = {
			agentId,
			sessionId,
			rootSessionId: this.rootSessionId,
			sessionFile: join(this.directory, `${sessionId}.jsonl`),
			creatorAgentId: caller.agentId,
			creatorRunId: caller.runId,
			permission,
			cwd: this.#options.session.getCwd(),
			createdAt: Date.now(),
		};
		const run = this.#newRun(agentId, caller.agentId, caller.runId, toolCallId, input.task, permission);
		const execution: Execution = { controller: new AbortController(), committed: false };
		this.#scheduler.accept(run, bytes, () => {});
		this.#pendingAgents++;
		this.#executions.set(run.runId, execution);
		let resolvePrepared!: () => void;
		execution.done = new Promise<void>((resolve) => {
			resolvePrepared = resolve;
		});
		try {
			const context =
				caller.agentId === this.rootSessionId
					? this.#options.rootContext(input.context)
					: this.#runtimes.get(caller.agentId)!.context(input.context);
			await this.#options.factory.prepare(agent, structuredClone(context), execution.controller.signal);
			this.#assertCaller(caller, true);
			if (execution.controller.signal.aborted) throw new SubagentError("cancelled");
			this.#commit({ kind: "agent_created", agent, run });
			execution.committed = true;
			this.#agents.set(agentId, agent);
			this.#options.session.getRootOwnership()!.registerChild(agentId, sessionId, agent.sessionFile, true);
			this.#pendingAgents--;
			resolvePrepared();
			this.#start(run, execution);
			return structuredClone(run);
		} catch (error) {
			if (!execution.committed && !this.#failure) {
				try {
					await this.#options.factory.discard(agent);
				} catch (cleanupError) {
					this.#failure = cleanupError;
					this.#phase = "closing";
					this.#scheduler.closeAdmission();
					resolvePrepared();
					throw cleanupError;
				}
				this.#pendingAgents--;
				this.#scheduler.finish(run.runId, () => {});
				this.#executions.delete(run.runId);
			}
			resolvePrepared();
			throw error;
		}
	}

	followup(caller: SubagentCaller, input: SubagentFollowupInput, toolCallId: string): SubagentRun {
		this.#assertCaller(caller, true);
		const repeated = this.#findRequest(caller.runId, toolCallId);
		if (repeated) return repeated;
		const bytes = Buffer.byteLength(JSON.stringify(input));
		if (bytes > SUBAGENT_LIMITS.taskBytes) throw new SubagentError("payload_too_large");
		const agent = this.#agents.get(input.agentId);
		if (!agent) throw new SubagentError("agent_not_found");
		const permission = intersectPermissions(
			this.#options.permission(),
			agent.permission,
			this.callerFor(caller.runId).permission,
			input.permission ?? agent.permission,
		);
		const run = this.#newRun(agent.agentId, caller.agentId, caller.runId, toolCallId, input.task, permission);
		this.#scheduler.accept(run, bytes, (accepted) => this.#commit({ kind: "run_accepted", run: accepted }));
		const execution: Execution = { controller: new AbortController(), committed: true };
		this.#executions.set(run.runId, execution);
		if (run.state !== "queued") this.#start(run, execution);
		return structuredClone(run);
	}

	#start(run: SubagentRun, execution: Execution): void {
		execution.done = this.#execute(run, execution).catch((error: unknown) => {
			this.#fail(error);
		});
	}

	async #execute(run: SubagentRun, execution: Execution): Promise<void> {
		let state: SubagentTerminalState = "completed";
		let text = "";
		let error: string | undefined;
		let effectsUnknown = false;
		let cleanupFailed = false;
		try {
			this.#assertOpen();
			if (execution.controller.signal.aborted) throw new SubagentError("cancelled");
			run.permission = this.#effective(run);
			this.#commit({ kind: "run_updated", run });
			let runtime = this.#runtimes.get(run.agentId);
			if (!runtime) {
				runtime = await this.#options.factory.open(this.#agents.get(run.agentId)!, execution.controller.signal);
				this.#runtimes.set(run.agentId, runtime);
				if (runtime.processId !== process.pid || runtime.sessionId !== this.#agents.get(run.agentId)!.sessionId) {
					try {
						await runtime.close();
					} catch (cause) {
						cleanupFailed = true;
						throw cause;
					}
					this.#runtimes.delete(run.agentId);
					throw new SubagentError("child_runtime_identity_mismatch");
				}
			}
			if (execution.controller.signal.aborted) throw new SubagentError("cancelled");
			run.state = "running";
			run.startedAt = Date.now();
			run.lastActivityAt = run.startedAt;
			this.#commit({ kind: "run_updated", run });
			const result = await runtime.run(run, execution.controller.signal, (receive, notify) => {
				const through = this.pendingUpdates(this.callerFor(run.runId));
				if (through !== undefined) notify(through);
				this.deliverMail(run.runId, receive);
			});
			text = result.text;
			effectsUnknown = result.effectsUnknown ?? false;
		} catch (cause) {
			if (
				cleanupFailed ||
				(cause instanceof SubagentError &&
					(cause.code === "child_cleanup_failed" || cause.code === "session_run_cleanup_failed"))
			) {
				run.state = "stopping";
				run.blockingReason = "child_cleanup_failed";
				this.#commit({ kind: "run_updated", run });
				throw cause;
			}
			error = cause instanceof Error ? cause.message : String(cause);
			state = execution.controller.signal.aborted ? "cancelled" : "failed";
		}
		if (execution.controller.signal.aborted) state = "cancelled";
		if (text) {
			const file = join(this.directory, `${run.runId}.result`);
			const fd = openSync(file, "wx");
			try {
				writeFileSync(fd, text);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			run.resultRef = `result:${run.runId}`;
			run.resultBytes = Buffer.byteLength(text);
			run.resultSummary = text.slice(0, 512);
		}
		this.#endRunMail(run.runId);
		const finished = {
			...run,
			state,
			error,
			effectsUnknown: run.effectsUnknown || effectsUnknown,
			finishedAt: Date.now(),
		};
		const next = this.#scheduler.finish(run.runId, () => this.#commit({ kind: "run_finished", run: finished }));
		this.#executions.delete(run.runId);
		this.#activityWrites.delete(run.runId);
		this.#wake();
		if (next) this.#start(next, this.#executions.get(next.runId)!);
	}

	interrupt(
		caller: SubagentCaller,
		runId: string,
		scope: "run" | "subtree",
	): { previousState: string; accepted: boolean; stopped: boolean; pending: number } {
		this.#assertCaller(caller);
		const target = this.getRun(caller, runId);
		if (target.agentId === this.rootSessionId) throw new SubagentError("cannot_interrupt_root");
		if (
			caller.agentId !== this.rootSessionId &&
			target.runId !== caller.runId &&
			!this.#issuedBy(target, caller.agentId)
		)
			throw new SubagentError("run_control_denied");
		const previousState = target.state;
		const affected = this.#scheduler.all.filter(
			(run) =>
				run.runId === runId ||
				(scope === "subtree" && this.#descends(run, runId)) ||
				(run.issuerRunId === runId && !this.#executions.get(run.runId)!.committed),
		);
		this.#commit({ kind: "run_cancelled", runId, scope, reason: "requested" });
		// Queued cancellation first prevents a finishing predecessor from handing
		// its permit to a cancelled successor. No await can expose a partial graph.
		for (const run of affected.filter((item) => item.state === "queued")) {
			this.#scheduler.finish(run.runId, () =>
				this.#commit({ kind: "run_finished", run: { ...run, state: "cancelled", finishedAt: Date.now() } }),
			);
			this.#executions.delete(run.runId);
			this.#endRunMail(run.runId);
		}
		for (const run of affected.filter((item) => item.state !== "queued")) {
			if (!this.#scheduler.get(run.runId)) continue;
			run.state = "stopping";
			if (this.#executions.get(run.runId)?.committed) this.#commit({ kind: "run_updated", run });
			this.#executions.get(run.runId)!.controller.abort();
		}
		this.#wake();
		return {
			previousState,
			accepted: true,
			stopped: affected.every((run) => !this.#scheduler.get(run.runId)),
			pending: affected.filter((run) => this.#scheduler.get(run.runId)).length,
		};
	}

	async wait(
		caller: SubagentCaller,
		runId: string,
		options: {
			condition?: "result" | "update" | "subtree_stopped";
			timeoutMs?: number;
			version?: number;
			signal?: AbortSignal;
		} = {},
	): Promise<{ run: SubagentRun; version: number; timedOut: boolean; subtreeStopped: boolean }> {
		this.#assertCaller(caller);
		const timeoutMs = options.timeoutMs ?? SUBAGENT_LIMITS.defaultWaitMs;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > SUBAGENT_LIMITS.maxWaitMs)
			throw new SubagentError("invalid_wait_timeout");
		const condition = options.condition ?? "result";
		this.getRun(caller, runId);
		const initialVersion = options.version ?? this.#runVersion(runId);
		if (!Number.isSafeInteger(initialVersion) || initialVersion < 0 || initialVersion > this.#version)
			throw new SubagentError("invalid_update_version");
		if (condition === "subtree_stopped" && !this.#isCancelled(runId, "subtree"))
			throw new SubagentError("subtree_not_closed");
		const targets =
			condition === "subtree_stopped"
				? this.#scheduler.all
						.filter((item) => item.runId === runId || this.#descends(item, runId))
						.map((item) => item.runId)
				: [runId];
		const removeWait = condition === "update" ? () => {} : this.#scheduler.addWait(caller.runId, targets);
		const oldState = this.#scheduler.get(caller.runId)?.state;
		if (oldState === "running") this.#scheduler.get(caller.runId)!.state = "waiting";
		const snapshot = (timedOut: boolean) => {
			if (timedOut)
				this.#commit({
					kind: "wait_timed_out",
					agentId: caller.agentId,
					waiterRunId: caller.runId,
					runId,
					condition,
				});
			return {
				run: this.getRun(caller, runId),
				version: this.#runVersion(runId),
				timedOut,
				subtreeStopped:
					this.#isCancelled(runId, "subtree") &&
					!this.#scheduler.all.some((item) => item.runId === runId || this.#descends(item, runId)),
			};
		};
		const ready = () => {
			const current = snapshot(false);
			return condition === "update"
				? current.version > initialVersion
				: condition === "result"
					? isSubagentTerminal(current.run.state)
					: current.subtreeStopped;
		};
		try {
			if (ready()) return snapshot(false);
			if (!timeoutMs) return snapshot(true);
			await new Promise<void>((resolve, reject) => {
				const finish = () => {
					clearTimeout(timer);
					this.#listeners.delete(listener);
					options.signal?.removeEventListener("abort", abort);
				};
				const listener = () => {
					try {
						if (!ready()) return;
						finish();
						resolve();
					} catch (error) {
						finish();
						reject(error);
					}
				};
				const abort = () => {
					finish();
					reject(new SubagentError("wait_cancelled"));
				};
				const timer = setTimeout(() => {
					finish();
					resolve();
				}, timeoutMs);
				this.#listeners.add(listener);
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) abort();
				else listener();
			});
			return snapshot(!ready());
		} finally {
			removeWait();
			const current = this.#scheduler.get(caller.runId);
			if (current?.state === "waiting" && oldState === "running") current.state = "running";
		}
	}

	getRun(caller: SubagentCaller, runId: string): SubagentRun {
		const run = this.#lookupRun(runId);
		if (!run) throw new SubagentError("run_not_found");
		if (
			caller.rootSessionId !== this.rootSessionId ||
			(caller.agentId !== this.rootSessionId &&
				run.agentId !== caller.agentId &&
				!this.#issuedBy(run, caller.agentId))
		)
			throw new SubagentError("run_access_denied");
		return structuredClone(run);
	}

	listRuns(
		caller: SubagentCaller,
		query: SubagentQueryOptions & { agentId?: string; ancestorRunId?: string; queuedOnly?: boolean } = {},
	) {
		this.#assertCaller(caller);
		if (query.ancestorRunId) this.getRun(caller, query.ancestorRunId);
		return queryControlPage({
			rootSessionId: this.rootSessionId,
			scope: JSON.stringify([caller.agentId, "runs", query.agentId, query.ancestorRunId, query.queuedOnly ?? false]),
			query,
			read: () => this.#options.session.readSubagentControl(),
			select: ({ control }) => {
				if (control.kind !== "agent_created" && control.kind !== "run_accepted") return;
				const run = this.#lookupRun(control.run.runId)!;
				if (run.agentId === this.rootSessionId || (query.agentId && run.agentId !== query.agentId)) return;
				if (query.queuedOnly && run.state !== "queued") return;
				if (query.ancestorRunId && !this.#descends(run, query.ancestorRunId)) return;
				if (
					caller.agentId !== this.rootSessionId &&
					run.agentId !== caller.agentId &&
					!this.#issuedBy(run, caller.agentId)
				)
					return;
				return summarizeRun(this.rootSessionId, run);
			},
		});
	}

	listAgents(caller: SubagentCaller, query: SubagentQueryOptions = {}) {
		this.#assertCaller(caller);
		return queryControlPage({
			rootSessionId: this.rootSessionId,
			scope: JSON.stringify([caller.agentId, "agents"]),
			query,
			read: () => this.#options.session.readSubagentControl(),
			select: ({ control }) => {
				if (control.kind !== "agent_created") return;
				return this.#agentOverview(caller, control.agent.agentId);
			},
		});
	}

	getAgentInfo(caller: SubagentCaller, agentId: string) {
		this.#assertCaller(caller);
		const info = this.#agentOverview(caller, agentId);
		if (!info) throw new SubagentError("agent_access_denied");
		return info;
	}

	#agentOverview(caller: SubagentCaller, agentId: string) {
		const identity = this.#agents.get(agentId);
		if (!identity) throw new SubagentError("agent_not_found");
		let latest: SubagentRun | undefined;
		for (const { control } of this.#options.session.readSubagentControl()) {
			if ((control.kind === "agent_created" || control.kind === "run_accepted") && control.run.agentId === agentId) {
				const run = control.run;
				if (
					caller.agentId === this.rootSessionId ||
					run.agentId === caller.agentId ||
					this.#issuedBy(run, caller.agentId)
				)
					latest = run;
			}
		}
		if (!latest && caller.agentId !== this.rootSessionId && caller.agentId !== agentId) return;
		const visible = this.#scheduler
			.queue(agentId)
			.filter(
				(run) =>
					caller.agentId === this.rootSessionId ||
					run.agentId === caller.agentId ||
					this.#issuedBy(run, caller.agentId),
			);
		const current = visible.find((run) => run.state !== "queued");
		return {
			agentId,
			sessionId: identity.sessionId,
			createdAt: identity.createdAt,
			currentRun: current ? summarizeRun(this.rootSessionId, current) : undefined,
			latestRun: latest ? summarizeRun(this.rootSessionId, this.#lookupRun(latest.runId)!) : undefined,
			queued: visible.filter((run) => run.state === "queued").length,
		};
	}

	listMessages(caller: SubagentCaller, query: SubagentQueryOptions & { agentId?: string } = {}) {
		this.#assertCaller(caller);
		return queryControlPage({
			rootSessionId: this.rootSessionId,
			scope: JSON.stringify([caller.agentId, "messages", query.agentId]),
			query,
			read: () => this.#options.session.readSubagentControl(),
			select: ({ control }) => {
				if (control.kind !== "mail" || control.mail.state !== "pending") return;
				const mail = this.#lookupMail(control.mail.messageId)!;
				if (query.agentId && mail.targetAgentId !== query.agentId && mail.senderAgentId !== query.agentId) return;
				if (!this.#canReadMail(caller, mail)) return;
				return summarizeMail(this.rootSessionId, mail);
			},
		});
	}

	pendingUpdates(caller: SubagentCaller): number | undefined {
		this.#assertCaller(caller);
		const through = this.#notifications.get(caller.agentId) ?? 0;
		return through > (this.#updatesRead.get(caller.agentId) ?? 0) ? through : undefined;
	}

	listUpdates(caller: SubagentCaller, query: SubagentQueryOptions = {}) {
		this.#assertCaller(caller);
		const read = this.#updatesRead.get(caller.agentId) ?? 0;
		const page = queryControlPage({
			rootSessionId: this.rootSessionId,
			scope: JSON.stringify([caller.agentId, "updates"]),
			query,
			read: () => this.#options.session.readSubagentControl(),
			select: ({ sequence, timestamp, control }) => {
				if (sequence <= read) return;
				if (control.kind === "wait_timed_out") {
					if (caller.agentId !== this.rootSessionId && control.agentId !== caller.agentId) return;
					return {
						sequence,
						timestamp,
						kind: control.kind,
						runId: control.runId,
						waiterRunId: control.waiterRunId,
						condition: control.condition,
					};
				}
				if (
					control.kind !== "agent_created" &&
					control.kind !== "run_accepted" &&
					control.kind !== "run_updated" &&
					control.kind !== "run_finished"
				)
					return;
				if (
					control.run.agentId === this.rootSessionId ||
					(caller.agentId !== this.rootSessionId && control.run.issuerAgentId !== caller.agentId)
				)
					return;
				return {
					sequence,
					timestamp,
					kind: control.kind,
					runId: control.run.runId,
					run: summarizeRun(this.rootSessionId, control.run),
				};
			},
		});
		const through = page.items.at(-1)?.sequence;
		if (through !== undefined) this.#commit({ kind: "updates_read", agentId: caller.agentId, through });
		return page;
	}

	readContent(caller: SubagentCaller, contentRef: string, offset = 0) {
		this.#assertCaller(caller);
		const [root, kind, id, extra] = contentRef.split(":");
		if (root !== this.rootSessionId || !id || extra !== undefined) throw new SubagentError("invalid_content_ref");
		if (kind === "result") return this.readResult(caller, id, offset);
		if (kind === "task") return contentChunk(this.getRun(caller, id).task, offset);
		if (kind !== "mail") throw new SubagentError("invalid_content_ref");
		const mail = this.#lookupMail(id);
		if (!mail || !this.#canReadMail(caller, mail)) throw new SubagentError("mail_access_denied");
		return contentChunk(mail.message, offset);
	}

	sendMessage(
		caller: SubagentCaller,
		input: { targetAgentId: string; targetRunId?: string; message: string; kind?: SubagentMail["kind"] },
	): SubagentMail {
		this.#assertCaller(caller, true);
		if (Buffer.byteLength(JSON.stringify(input)) > SUBAGENT_LIMITS.messageBytes)
			throw new SubagentError("payload_too_large");
		if (input.targetAgentId !== this.rootSessionId && !this.#agents.has(input.targetAgentId))
			throw new SubagentError("agent_not_found");
		if (input.targetRunId) {
			const target = this.#lookupRun(input.targetRunId);
			if (!target || target.agentId !== input.targetAgentId) throw new SubagentError("run_not_found");
			if (isSubagentTerminal(target.state)) throw new SubagentError("run_finished");
		}
		const mail: SubagentMail = {
			...input,
			kind: input.kind ?? "information",
			messageId: randomUUID(),
			senderAgentId: caller.agentId,
			senderRunId: caller.runId,
			createdAt: Date.now(),
			state: "pending",
		};
		const used = [...this.#mail.values()].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
		if (
			this.#mail.size >= SUBAGENT_LIMITS.mailCount ||
			used + Buffer.byteLength(JSON.stringify(mail)) > SUBAGENT_LIMITS.mailBytes
		)
			throw new SubagentError("mailbox_full");
		this.#commit({ kind: "mail", mail });
		this.#mail.set(mail.messageId, mail);
		return structuredClone(mail);
	}

	deliverMail(runId: string, receive: (mail: SubagentMail) => void): void {
		const run = this.#rootRuns.get(runId) ?? this.#scheduler.get(runId);
		if (!run) throw new SubagentError("run_not_active");
		this.#assertCaller(this.callerFor(runId), true);
		let bytes = 0;
		for (const mail of this.#mail.values()) {
			if (mail.targetAgentId !== run.agentId || (mail.targetRunId && mail.targetRunId !== runId)) continue;
			const size = Buffer.byteLength(JSON.stringify(subagentMailMessage(mail)));
			// Leave room for the single coalesced update hint delivered at this safe point.
			if (bytes + size > SUBAGENT_LIMITS.responseBytes - 1024) break;
			// The synchronous recipient commit and root receipt cannot interleave
			// with cancellation or delivery to a different run.
			receive(structuredClone(mail));
			this.#commit({ kind: "mail", mail: { ...mail, state: "delivered" } });
			this.#mail.delete(mail.messageId);
			bytes += size;
		}
	}

	safePoint(runId: string, receive: Parameters<SubagentSafePoint>[0], notify: Parameters<SubagentSafePoint>[1]): void {
		const through = this.pendingUpdates(this.callerFor(runId));
		if (through !== undefined) notify(through);
		this.deliverMail(runId, receive);
	}

	activity(runId: string, progress?: string): void {
		const run = this.#rootRuns.get(runId) ?? this.#scheduler.get(runId);
		if (!run) return;
		run.lastActivityAt = Date.now();
		// Streaming deltas update the live timestamp immediately. Persist at most
		// once per second of real activity; terminal records keep the final value.
		// Never turn every token into an fsync and a separate unread notification.
		if (progress === undefined && run.lastActivityAt - (this.#activityWrites.get(runId) ?? 0) < 1000) return;
		if (progress !== undefined) {
			run.lastProgressAt = Date.now();
			run.stage = progress.slice(0, 512);
		}
		this.#commit({ kind: "run_updated", run });
		this.#activityWrites.set(runId, run.lastActivityAt);
		this.#wake();
	}

	readResult(
		caller: SubagentCaller,
		runId: string,
		offset = 0,
	): { text: string; nextOffset?: number; complete: boolean } {
		const run = this.getRun(caller, runId);
		if (!run.resultRef) throw new SubagentError("result_not_available");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > (run.resultBytes ?? 0))
			throw new SubagentError("invalid_content_cursor");
		const fd = openSync(join(this.directory, `${run.runId}.result`), "r");
		try {
			const buffer = Buffer.alloc(4096);
			let length = readSync(fd, buffer, 0, buffer.length, offset);
			if (length && (buffer[0] & 0xc0) === 0x80) throw new SubagentError("invalid_content_cursor");
			if (!length && offset < run.resultBytes!) throw new SubagentError("result_content_incomplete");
			const eof = offset + length >= run.resultBytes!;
			if (!eof) {
				let start = length - 1;
				while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
				const leading = buffer[start];
				const expected = leading >= 0xf0 ? 4 : leading >= 0xe0 ? 3 : leading >= 0xc0 ? 2 : 1;
				if (length - start < expected) length = start;
			}
			return {
				text: buffer.subarray(0, length).toString("utf8"),
				nextOffset: eof ? undefined : offset + length,
				complete: eof,
			};
		} finally {
			closeSync(fd);
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#phase = "closing";
		this.#scheduler.closeAdmission();
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		// Signal the root before awaiting anything. A blocked root may itself be
		// waiting for a child that is stopped below.
		const rootStopped = this.#options.root?.stop();
		void rootStopped?.catch(() => {});
		const failures: unknown[] = [];
		try {
			this.#commit({ kind: "root_phase", phase: "closing", processId: process.pid });
		} catch (error) {
			failures.push(error);
		}
		for (const run of this.#scheduler.all.filter((item) => item.state === "queued")) {
			try {
				this.#scheduler.finish(run.runId, () =>
					this.#commit({ kind: "run_finished", run: { ...run, state: "cancelled", finishedAt: Date.now() } }),
				);
				this.#executions.delete(run.runId);
				this.#endRunMail(run.runId);
			} catch (error) {
				failures.push(error);
			}
		}
		for (const execution of this.#executions.values()) execution.controller.abort();
		while (this.#executions.size) {
			await Promise.all([...this.#executions.values()].map((execution) => execution.done));
			if (this.#failure) {
				failures.push(this.#failure);
				break;
			}
		}
		try {
			await rootStopped;
		} catch (error) {
			failures.push(error);
		}
		const closed = await Promise.allSettled([...this.#runtimes.values()].map((runtime) => runtime.close()));
		for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
		try {
			await this.#options.root?.close();
		} catch (error) {
			failures.push(error);
		}
		if (this.#failure && !failures.includes(this.#failure)) failures.push(this.#failure);
		if (failures.length)
			throw new AggregateError(
				failures,
				`subagent_children_cleanup_failed: ${failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
			);
		this.#runtimes.clear();
		this.#phase = "closed";
		this.#commit({ kind: "root_phase", phase: "closed", processId: process.pid });
		this.#options.session.closeOwnership();
	}

	#commit(event: SubagentControlEvent): void {
		try {
			const record = this.#options.session.appendSubagentControl(event);
			this.#version = record.sequence;
			this.#observeUpdate(record);
			queueMicrotask(() => this.#wake());
		} catch (error) {
			this.#fail(error);
			throw error;
		}
	}
	#fail(error: unknown): void {
		this.#failure ??= error;
		this.#phase = "closing";
		this.#scheduler.closeAdmission();
		// Cancellation remains effective when its durable receipt cannot be written.
		for (const execution of this.#executions.values()) execution.controller.abort();
		void this.#options.root?.stop().catch(() => {});
		this.#wake();
	}
	#observeUpdate({ sequence, control }: SubagentControlRecord): void {
		if (control.kind === "updates_read") {
			if (!Number.isSafeInteger(control.through) || control.through < 0 || control.through >= sequence)
				throw new SubagentError("invalid_update_receipt");
			this.#updatesRead.set(control.agentId, Math.max(this.#updatesRead.get(control.agentId) ?? 0, control.through));
		} else if (control.kind === "wait_timed_out") {
			this.#notifications.set(control.agentId, sequence);
			this.#notifications.set(this.rootSessionId, sequence);
		} else if ("run" in control && control.run.agentId !== this.rootSessionId) {
			this.#notifications.set(control.run.issuerAgentId, sequence);
			this.#notifications.set(this.rootSessionId, sequence);
		}
	}
	#wake(): void {
		for (const listener of [...this.#listeners]) listener();
	}
	#assertOpen(): void {
		if (this.#phase !== "open") throw new SubagentError(`root_${this.#phase}`);
	}
	#assertCaller(caller: SubagentCaller, admission = false): void {
		if (caller.rootSessionId !== this.rootSessionId) throw new SubagentError("root_access_denied");
		const run = this.#rootRuns.get(caller.runId) ?? this.#scheduler.get(caller.runId);
		if (!run || run.agentId !== caller.agentId) throw new SubagentError("caller_not_running");
		if (admission) {
			this.#assertOpen();
			if (run.state === "stopping" || this.#isCancelled(run.runId) || this.#cancelledAncestor(run))
				throw new SubagentError("run_cancelled");
		}
	}
	#newRun(
		agentId: string,
		issuerAgentId: string,
		issuerRunId: string,
		toolCallId: string,
		task: string,
		permission: SubagentPermission,
	): SubagentRun {
		return {
			agentId,
			issuerAgentId,
			issuerRunId,
			toolCallId,
			task,
			permission,
			runId: randomUUID(),
			state: "queued",
			createdAt: Date.now(),
		};
	}
	#lookupRun(runId: string): SubagentRun | undefined {
		const active = this.#rootRuns.get(runId) ?? this.#scheduler.get(runId);
		if (active) return active;
		let found: SubagentRun | undefined;
		for (const { control } of this.#options.session.readSubagentControl()) {
			if ("run" in control && control.run.runId === runId) found = control.run;
		}
		return found;
	}
	#runVersion(runId: string): number {
		let version = 0;
		for (const { sequence, control } of this.#options.session.readSubagentControl()) {
			if (
				("run" in control && control.run.runId === runId) ||
				(control.kind === "run_cancelled" && control.runId === runId)
			)
				version = sequence;
		}
		return version;
	}
	#lookupMail(messageId: string): SubagentMail | undefined {
		let found: SubagentMail | undefined;
		for (const { control } of this.#options.session.readSubagentControl()) {
			if (control.kind === "mail" && control.mail.messageId === messageId) found = control.mail;
		}
		return found;
	}
	#canReadMail(caller: SubagentCaller, mail: SubagentMail): boolean {
		if (caller.rootSessionId !== this.rootSessionId) return false;
		if (
			caller.agentId === this.rootSessionId ||
			mail.senderAgentId === caller.agentId ||
			mail.targetAgentId === caller.agentId
		)
			return true;
		const sender = this.#lookupRun(mail.senderRunId);
		const target = mail.targetRunId ? this.#lookupRun(mail.targetRunId) : undefined;
		return Boolean(
			(sender && this.#issuedBy(sender, caller.agentId)) || (target && this.#issuedBy(target, caller.agentId)),
		);
	}
	#findRequest(issuerRunId: string, toolCallId: string): SubagentRun | undefined {
		for (const { control } of this.#options.session.readSubagentControl()) {
			if (
				(control.kind === "agent_created" || control.kind === "run_accepted") &&
				control.run.issuerRunId === issuerRunId &&
				control.run.toolCallId === toolCallId
			)
				return this.#lookupRun(control.run.runId);
		}
	}
	#descends(run: SubagentRun, ancestorRunId: string): boolean {
		let current: SubagentRun | undefined = run;
		const seen = new Set<string>();
		while (current?.issuerRunId) {
			if (current.issuerRunId === ancestorRunId) return true;
			if (seen.has(current.runId)) throw new SubagentError("run_lineage_corrupt");
			seen.add(current.runId);
			current = this.#lookupRun(current.issuerRunId);
		}
		return false;
	}
	#issuedBy(run: SubagentRun, agentId: string): boolean {
		let current: SubagentRun | undefined = run;
		const seen = new Set<string>();
		while (current?.issuerRunId) {
			if (seen.has(current.runId)) throw new SubagentError("run_lineage_corrupt");
			seen.add(current.runId);
			if (current.issuerAgentId === agentId) return true;
			current = this.#lookupRun(current.issuerRunId);
		}
		return false;
	}
	#isCancelled(runId: string, scope?: "subtree"): boolean {
		for (const { control } of this.#options.session.readSubagentControl())
			if (control.kind === "run_cancelled" && control.runId === runId && (!scope || control.scope === scope))
				return true;
		return false;
	}
	#cancelledAncestor(run: SubagentRun): boolean {
		for (const { control } of this.#options.session.readSubagentControl())
			if (control.kind === "run_cancelled" && control.scope === "subtree" && this.#descends(run, control.runId))
				return true;
		return false;
	}
	#effective(run: SubagentRun): SubagentPermission {
		const grants = [this.#options.permission(), run.permission];
		let agent = this.#agents.get(run.agentId);
		while (agent) {
			grants.push(agent.permission);
			agent = this.#agents.get(agent.creatorAgentId);
		}
		return intersectPermissions(...grants);
	}
	#endRunMail(runId: string): void {
		for (const mail of this.#mail.values())
			if (mail.targetRunId === runId) {
				this.#commit({ kind: "mail", mail: { ...mail, state: "undelivered" } });
				this.#mail.delete(mail.messageId);
			}
	}
}
