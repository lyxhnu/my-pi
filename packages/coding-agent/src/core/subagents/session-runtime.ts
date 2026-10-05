import { existsSync, rmSync } from "node:fs";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import type { ExtensionRuntime, ToolDefinition } from "../extensions/index.ts";
import { convertToLlm } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { SubagentRunScope } from "./run-scope.ts";
import { committedSubagentContext, recoverSubagentSession } from "./session-context.ts";
import { executeSessionRun, shutdownSubagentSession } from "./session-execution.ts";
import { hasSubagentMailReceipt } from "./session-mailbox.ts";
import {
	type SubagentContextSelection,
	SubagentError,
	type SubagentIdentity,
	type SubagentPermission,
	type SubagentRun,
	type SubagentRuntime,
	type SubagentRuntimeFactory,
	type SubagentSafePoint,
} from "./types.ts";

export function selectSubagentContext(messages: AgentMessage[], selection: SubagentContextSelection): AgentMessage[] {
	if (selection === "none") return [];
	if (selection === "all") return committedSubagentContext(messages);
	if (!Number.isSafeInteger(selection) || selection <= 0) throw new SubagentError("invalid_context_selection");
	let remaining = selection;
	let start = messages.length;
	while (start > 0) {
		start--;
		if (messages[start].role === "user" && --remaining === 0) break;
	}
	return committedSubagentContext(messages.slice(start));
}

export interface InProcessSubagentFactoryOptions {
	rootSession: SessionManager;
	rootResources: ResourceLoader;
	agentDir: string;
	modelRuntime: ModelRuntime;
	model: () => Model<Api>;
	thinkingLevel: () => ThinkingLevel;
	settings: () => SettingsManager;
	/** Construct a fresh loader/runtime; never return the parent's loaded extensions. */
	resources: (agent: SubagentIdentity, settings: SettingsManager) => Promise<ResourceLoader>;
	/** Supply this session's own tool closures, including the shared root's delegation tools. */
	tools: (agent: SubagentIdentity, scope: SubagentRunScope) => ToolDefinition[];
	permission?: (agent: SubagentIdentity, scope: SubagentRunScope) => SubagentPermission;
	allowedTools?: () => string[];
	onExternalEffect?: (runId: string) => void;
	onActivity?: (runId: string, progress?: string) => void;
}

/** Preparation persists the child first. Opening does not start any model work. */
export class InProcessSubagentFactory implements SubagentRuntimeFactory {
	readonly #options: InProcessSubagentFactoryOptions;
	readonly #managers = new Map<string, SessionManager>();
	readonly #sessions = new Map<string, AgentSession>();
	readonly #loaders = new WeakSet<ResourceLoader>();
	readonly #extensionRuntimes = new WeakSet<ExtensionRuntime>();

	constructor(options: InProcessSubagentFactoryOptions) {
		this.#options = options;
		this.#loaders.add(options.rootResources);
		this.#extensionRuntimes.add(options.rootResources.getExtensions().runtime);
	}

	getSession(agentId: string): AgentSession | undefined {
		return this.#sessions.get(agentId);
	}

	async recover(agent: SubagentIdentity, pendingMailIds: readonly string[]): Promise<string[]> {
		const owner = this.#options.rootSession.getRootOwnership();
		if (!owner || owner.rootSessionId !== agent.rootSessionId) throw new SubagentError("root_ownership_required");
		if (!existsSync(agent.sessionFile)) throw new SubagentError("child_session_missing");
		const manager = SessionManager.open(agent.sessionFile, undefined, agent.cwd, owner);
		try {
			const header = manager.getHeader();
			if (
				header?.id !== agent.sessionId ||
				header.ownership?.kind !== "child" ||
				header.ownership.agentId !== agent.agentId ||
				header.ownership.rootSessionId !== agent.rootSessionId
			)
				throw new SubagentError("child_session_binding_mismatch");
			recoverSubagentSession(manager);
			return pendingMailIds.filter((id) => hasSubagentMailReceipt(manager, id));
		} finally {
			manager.closeOwnership();
		}
	}

	async prepare(agent: SubagentIdentity, context: AgentMessage[], signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw new SubagentError("cancelled");
		const owner = this.#options.rootSession.getRootOwnership();
		if (!owner || owner.rootSessionId !== agent.rootSessionId) throw new SubagentError("root_ownership_required");
		const manager = SessionManager.createChild(agent.cwd, agent.sessionFile, agent.sessionId, agent.agentId, owner);
		this.#managers.set(agent.agentId, manager);
		const model = this.#options.model();
		manager.appendModelChange(model.provider, model.id);
		manager.appendThinkingLevelChange(this.#options.thinkingLevel());
		for (const message of convertToLlm(committedSubagentContext(context))) manager.appendMessage(message);
		manager.flush();
	}

	async discard(agent: SubagentIdentity): Promise<void> {
		if (this.#sessions.has(agent.agentId)) throw new SubagentError("child_session_already_open");
		const manager = this.#managers.get(agent.agentId);
		if (!manager) return;
		manager.closeOwnership();
		this.#managers.delete(agent.agentId);
		rmSync(agent.sessionFile, { force: true });
	}

	async open(agent: SubagentIdentity, signal: AbortSignal): Promise<SubagentRuntime> {
		if (this.#sessions.has(agent.agentId)) throw new SubagentError("child_session_already_open");
		const owner = this.#options.rootSession.getRootOwnership();
		if (!owner || owner.rootSessionId !== agent.rootSessionId) throw new SubagentError("root_ownership_required");
		const manager =
			this.#managers.get(agent.agentId) ?? SessionManager.open(agent.sessionFile, undefined, agent.cwd, owner);
		this.#managers.set(agent.agentId, manager);
		let session: AgentSession | undefined;
		try {
			if (signal.aborted) throw new SubagentError("cancelled");
			const parentSettings = this.#options.settings();
			const settings = SettingsManager.inMemory(parentSettings.getEffectiveSettings(), {
				projectTrusted: parentSettings.isProjectTrusted(),
			});
			const loader = await this.#options.resources(agent, settings);
			const extensions = loader.getExtensions().runtime;
			if (this.#loaders.has(loader) || this.#extensionRuntimes.has(extensions))
				throw new SubagentError("child_resources_shared");
			this.#loaders.add(loader);
			this.#extensionRuntimes.add(extensions);
			if (signal.aborted) throw new SubagentError("cancelled");
			const scope = new SubagentRunScope(this.#options.onExternalEffect);
			const tools = this.#options.tools(agent, scope);
			const toolNames = () => this.#options.allowedTools?.() ?? tools.map((tool) => tool.name);
			let currentPermission = agent.permission;
			const saved = manager.buildSessionContext();
			const model = saved.model
				? this.#options.modelRuntime.getModel(saved.model.provider, saved.model.modelId)
				: this.#options.model();
			if (!model) throw new SubagentError("child_model_unavailable");
			const created = await createAgentSession({
				cwd: agent.cwd,
				agentDir: this.#options.agentDir,
				modelRuntime: this.#options.modelRuntime,
				model,
				thinkingLevel: saved.thinkingLevel as ThinkingLevel,
				settingsManager: settings,
				sessionManager: manager,
				resourceLoader: loader,
				customTools: tools,
				tools: toolNames(),
				subagentRunScope: scope,
				subagentPermission: () => this.#options.permission?.(agent, scope) ?? currentPermission,
			});
			session = created.session;
			await session.bindExtensions({});
			if (signal.aborted) throw new SubagentError("cancelled");
			this.#sessions.set(agent.agentId, session);
			return new InProcessSubagentRuntime(
				session,
				scope,
				this.#options.onActivity,
				() => {
					this.#sessions.delete(agent.agentId);
					this.#managers.delete(agent.agentId);
				},
				toolNames,
				(permission) => {
					currentPermission = permission;
				},
			);
		} catch (error) {
			try {
				if (session) await session.dispose();
			} catch {
				throw new SubagentError("child_cleanup_failed");
			}
			manager.closeOwnership();
			this.#managers.delete(agent.agentId);
			throw error;
		}
	}
}

class InProcessSubagentRuntime implements SubagentRuntime {
	readonly sessionId: string;
	readonly processId = process.pid;
	readonly #session: AgentSession;
	readonly #scope: SubagentRunScope;
	readonly #activity?: InProcessSubagentFactoryOptions["onActivity"];
	readonly #closed: () => void;
	readonly #toolNames: () => string[];
	readonly #setPermission: (permission: SubagentPermission) => void;
	#closePromise?: Promise<void>;

	constructor(
		session: AgentSession,
		scope: SubagentRunScope,
		activity: InProcessSubagentFactoryOptions["onActivity"],
		closed: () => void,
		toolNames: () => string[],
		setPermission: (permission: SubagentPermission) => void,
	) {
		this.sessionId = session.sessionId;
		this.#session = session;
		this.#scope = scope;
		this.#activity = activity;
		this.#closed = closed;
		this.#toolNames = toolNames;
		this.#setPermission = setPermission;
	}

	run(
		run: SubagentRun,
		signal: AbortSignal,
		safePoint: SubagentSafePoint,
	): Promise<{ text: string; effectsUnknown?: boolean }> {
		return this.#scope.run(run.runId, signal, async (runSignal) => {
			const session = this.#session;
			this.#setPermission(run.permission);
			session.setActiveToolsByName(this.#toolNames());
			const start = session.messages.length;
			const unsubscribe = session.subscribe(() => this.#activity?.(run.runId));
			try {
				await executeSessionRun(session, this.#scope, runSignal, safePoint, () =>
					session.prompt(run.task, { expandPromptTemplates: false }),
				);
			} finally {
				unsubscribe();
			}
			const state = session.agent.state.runState;
			if (state.status === "idle" && state.lastOutcome && state.lastOutcome.type !== "completed")
				throw new SubagentError("child_run_failed", `Child ended with ${state.lastOutcome.type}`);
			const response = session.messages
				.slice(start)
				.reverse()
				.find((message) => message.role === "assistant");
			return {
				text:
					response?.role === "assistant"
						? response.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "",
			};
		});
	}

	context(selection: SubagentContextSelection): AgentMessage[] {
		return selectSubagentContext(this.#session.messages, selection);
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		await this.#scope.close();
		await shutdownSubagentSession(this.#session, () => this.#session.dispose());
		this.#session.sessionManager.closeOwnership();
		this.#closed();
	}
}
