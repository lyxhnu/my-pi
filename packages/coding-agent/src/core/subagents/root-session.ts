import type { AgentSession } from "../agent-session.ts";
import type { SessionShutdownEvent, ToolDefinition } from "../extensions/types.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { intersectPermissions } from "./permissions.ts";
import { RootSubagentCoordinator } from "./root-coordinator.ts";
import { SubagentRunScope } from "./run-scope.ts";
import { executeSessionRun, shutdownSubagentSession } from "./session-execution.ts";
import {
	InProcessSubagentFactory,
	type InProcessSubagentFactoryOptions,
	selectSubagentContext,
} from "./session-runtime.ts";
import { createSubagentTools } from "./tools.ts";
import { SubagentError, type SubagentPermission, type SubagentTerminalState } from "./types.ts";

export interface RootSubagentOptions {
	permission?: () => SubagentPermission;
	/** Optional host recovery for externally tracked operations. No tool is replayed. */
	recover?: () => Promise<void>;
	resources?: InProcessSubagentFactoryOptions["resources"];
	/** Fresh child-owned custom tools; unknown tools require full capability. */
	tools?: InProcessSubagentFactoryOptions["tools"];
}

type RootSessionOptions = Omit<
	InProcessSubagentFactoryOptions,
	"resources" | "tools" | "onActivity" | "permission" | "allowedTools" | "onExternalEffect"
> &
	RootSubagentOptions;

/** Owns the normal root prompt/dispose boundary, rather than delegating it to callers. */
export class RootSubagentSession {
	readonly scope = new SubagentRunScope((runId) => this.#coordinator.markExternalEffect(runId));
	readonly factory: InProcessSubagentFactory;
	#coordinator!: RootSubagentCoordinator;
	#session?: AgentSession;
	#dispose?: () => Promise<void>;
	#active?: Promise<unknown>;
	#cleanupFailure?: unknown;
	#shutdown?: { event: SessionShutdownEvent; beforeDispose?: () => void };
	readonly #permission: () => SubagentPermission;

	private constructor(options: RootSessionOptions) {
		this.#permission = options.permission ?? (() => ({ mode: "full" }));
		this.factory = new InProcessSubagentFactory({
			...options,
			resources:
				options.resources ??
				(async (agent, settingsManager) => {
					const loader = new DefaultResourceLoader({
						cwd: agent.cwd,
						agentDir: options.agentDir,
						settingsManager,
						noExtensions: true,
						additionalExtensionPaths:
							agent.permission.mode === "full"
								? options.rootResources
										.getExtensions()
										.extensions.filter((extension) => !extension.path.startsWith("<inline:"))
										.map((extension) => extension.resolvedPath)
								: [],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						skillsOverride: () => structuredClone(options.rootResources.getSkills()),
						promptsOverride: () => structuredClone(options.rootResources.getPrompts()),
						agentsFilesOverride: () => structuredClone(options.rootResources.getAgentsFiles()),
						systemPrompt: options.rootResources.getSystemPrompt(),
						appendSystemPrompt: options.rootResources.getAppendSystemPrompt(),
					});
					await loader.reload();
					return loader;
				}),
			permission: (agent, scope) =>
				scope.isCurrent
					? this.#coordinator.callerFor(scope.assertActive().runId).permission
					: intersectPermissions(agent.permission, this.permission),
			allowedTools: options.tools ? undefined : () => this.#session?.getActiveToolNames() ?? [],
			onExternalEffect: (runId) => this.#coordinator.markExternalEffect(runId),
			model: () => this.#session?.model ?? options.model(),
			thinkingLevel: () => this.#session?.thinkingLevel ?? options.thinkingLevel(),
			tools: (agent, scope) => [
				...createSubagentTools(
					() => this.#coordinator,
					() => this.#coordinator.callerFor(scope.assertActive().runId),
				),
				...(options.tools?.(agent, scope) ?? []),
			],
			onActivity: (runId, progress) => this.#coordinator.activity(runId, progress),
		});
	}

	static async open(options: RootSessionOptions): Promise<RootSubagentSession> {
		const host = new RootSubagentSession(options);
		host.#coordinator = await RootSubagentCoordinator.open({
			session: options.rootSession,
			factory: host.factory,
			permission: () => host.permission,
			rootContext: (selection) => selectSubagentContext(host.#session!.messages, selection),
			recover: options.recover ?? (async () => {}),
			root: {
				stop: async () => {
					await host.scope.close();
					await host.#active?.catch(() => {});
					if (host.#cleanupFailure) throw host.#cleanupFailure;
				},
				close: async () => {
					if (host.#session && host.#dispose)
						await shutdownSubagentSession(
							host.#session,
							async () => {
								try {
									host.#shutdown?.beforeDispose?.();
								} finally {
									await host.#dispose!();
								}
							},
							host.#shutdown?.event,
						);
				},
			},
		});
		return host;
	}

	get coordinator(): RootSubagentCoordinator {
		return this.#coordinator;
	}

	get permission(): SubagentPermission {
		return intersectPermissions(this.#permission(), {
			mode: this.#session && this.#session.getPlanModeState().status !== "off" ? "read-only" : "full",
		});
	}

	get tools(): ToolDefinition[] {
		return createSubagentTools(
			() => this.#coordinator,
			() => this.#coordinator.callerFor(this.scope.assertActive().runId),
		);
	}

	bind(session: AgentSession, dispose: () => Promise<void>): void {
		if (this.#session) throw new SubagentError("root_session_already_bound");
		if (session.sessionId !== this.#coordinator.rootSessionId)
			throw new SubagentError("root_session_binding_mismatch");
		this.#session = session;
		this.#dispose = dispose;
	}

	run<T>(work: () => Promise<T>): Promise<T> {
		if (this.#cleanupFailure) throw new SubagentError("root_cleanup_failed");
		// A late callback retains its old async context. It must never acquire a
		// fresh root identity or borrow a newer run's lease.
		if (this.scope.hasContext) return this.scope.track(work);
		if (this.#active) {
			if (!this.#session?.isStreaming) throw new SubagentError("root_run_busy");
			return this.scope.join(work);
		}
		const session = this.#session;
		if (!session) throw new SubagentError("root_session_not_bound");
		const caller = this.#coordinator.beginRootRun();
		let state: SubagentTerminalState = "failed";
		const unsubscribe = session.subscribe(() => this.#coordinator.activity(caller.runId));
		const running = this.scope.run(caller.runId, new AbortController().signal, async (signal) => {
			const cancelled = () => {
				try {
					this.#coordinator.cancelRootRun(caller.runId);
				} catch (error) {
					this.#cleanupFailure = error;
				}
			};
			signal.addEventListener("abort", cancelled, { once: true });
			try {
				const value = await executeSessionRun(
					session,
					this.scope,
					signal,
					(receive, notify) => this.#coordinator.safePoint(caller.runId, receive, notify),
					work,
				);
				const outcome = session.agent.state.runState;
				state = signal.aborted
					? "cancelled"
					: outcome.status === "idle" && (!outcome.lastOutcome || outcome.lastOutcome.type === "completed")
						? "completed"
						: "failed";
				return value;
			} catch (error) {
				if (signal.aborted) state = "cancelled";
				if (error instanceof SubagentError && error.code === "session_run_cleanup_failed") {
					this.#cleanupFailure = error;
					this.#coordinator.failRootRun(caller.runId, error);
				}
				throw error;
			} finally {
				signal.removeEventListener("abort", cancelled);
			}
		});
		const done = running.finally(() => {
			unsubscribe();
			try {
				if (!this.#cleanupFailure) this.#coordinator.endRootRun(caller.runId, state);
			} finally {
				this.#active = undefined;
			}
		});
		this.#active = done;
		return done;
	}

	close(options?: { event: SessionShutdownEvent; beforeDispose?: () => void }): Promise<void> {
		if (this.scope.hasContext) throw new SubagentError("root_close_from_active_run");
		this.#shutdown ??= options ?? { event: { type: "session_shutdown", reason: "quit" } };
		return this.#coordinator.close();
	}
}
