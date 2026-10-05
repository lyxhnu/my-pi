/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Manual compaction and automatic context windows
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentLoopAfterTurnControl,
	AgentMessage,
	AgentState,
	AgentTool,
	PreparedAgentRequest,
	PrepareNextTurnContext,
	ShakeConfig,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	buildRedactions,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
	estimateShakeSavings,
	prepareAgentRequest,
	resolveShakeConfig,
} from "@earendil-works/pi-agent-core";
import { type Context, type ContextBudget, contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getMemoryDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
} from "./compaction/index.ts";
import {
	type ContextReadBudgetReservation,
	type ContextRemaining,
	contextRemaining,
	STATE_SAVE_CONTROL_TOKENS,
	STATE_SAVE_OUTPUT_TOKENS,
} from "./context-budget.ts";
import { CONTEXT_CONTROL_TOOLS, ContextMaintenance } from "./context-maintenance.ts";
import {
	type ContextControlCause,
	type ContextRecoveryReferences,
	ContextRollover,
	type ContinuationStateValidation,
	collectCompleteToolTransactions,
	contextRecoveryCoverage,
	currentContextRecoveryReferences,
	fingerprintContextRolloverValue,
	getSaveStateOperation,
	RECOVERY_OUTPUT_TOKENS,
	RECOVERY_TOOL_NAMES,
	SAVE_STATE_MAX_SAMPLES,
	type SaveStateOperationSnapshot,
	validateCommittedRecovery,
	validateContinuationState,
} from "./context-rollover.ts";
import { formatContextWindow } from "./context-window.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { ExecutionMonitor } from "./execution-monitor.ts";
import {
	type ExecutionProfile,
	type ExecutionUpgradeConfig,
	type ExecutionUpgradeOutcome,
	type ExecutionUpgradeRequest,
	executionUpgradeOptions,
} from "./execution-upgrade.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { History } from "./history.ts";
import { PendingInteractionRegistry } from "./interactions/pending-interactions.ts";
import { LspManager, type LspServerConfig } from "./lsp/lsp-manager.ts";
import { McpManager, type McpServerConfig } from "./mcp/mcp-manager.ts";
import { extractArchivedMemory, validateArchivedMemoryCandidate } from "./memory/archive-extraction.ts";
import { type MemoryArchiveExtractor, MemoryArchiveService } from "./memory/archive-service.ts";
import { createOpenAiCompatibleEmbedder, resolveEmbeddingConfig } from "./memory/embeddings.ts";
import { MemoryAuthority } from "./memory/memory-authority.ts";
import { MemoryStore } from "./memory/memory-store.ts";
import type { MemoryArchiveStatus, MemoryEvidenceInput, MemoryRun } from "./memory/types.ts";
import { type BashExecutionMessage, type CustomMessage, createCustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { PendingDeliveryStore } from "./pending-delivery.ts";
import { JsonlPermissionAuditLog, NULL_AUDIT_LOG } from "./permissions/audit-log.ts";
import { PermissionService } from "./permissions/permission-service.ts";
import { decideToolPermission } from "./permissions/policy.ts";
import {
	OFF_PLAN_MODE_STATE,
	PLAN_MODE_READ_ONLY_TOOLS,
	type PlanArtifact,
	type PlanModeState,
} from "./plan/plan-state.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextProgressEntry,
	ContextRolloverEntry,
	SessionEntry,
	SessionManager,
} from "./session-manager.ts";
import {
	buildSessionContext,
	CURRENT_SESSION_VERSION,
	collectShakenIndex,
	getLatestCompactionEntry,
	getLatestCustomEntryData,
	type SessionHeader,
	sessionEntryToContextMessages,
} from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type ContextTransitionGate, captureSubagentHandoff } from "./subagent-continuation.ts";
import { canUseSubagentTool, subagentToolPermission } from "./subagents/permissions.ts";
import type { RootSubagentSession } from "./subagents/root-session.ts";
import type { SubagentRunScope } from "./subagents/run-scope.ts";
import { SubagentError, type SubagentPermission } from "./subagents/types.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import {
	buildTaskNoteProjectionFromBranch,
	createTaskNoteFreshnessResolver,
	createTaskScopeId,
	fingerprintTaskNoteWorkspaceContent,
	resolveTaskNoteScope,
} from "./task-note-projection.ts";
import { TaskManager } from "./tasks/task-manager.ts";
import type { TaskStateTransition } from "./tasks/types.ts";
import {
	shouldFireTodoGate,
	TodoNudgeTracker,
	todoGateReminderText,
	todoNudgeReminderText,
} from "./todo/reminder-policy.ts";
import { TodoStateStore } from "./todo/todo-state.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createContextNoteToolDefinition } from "./tools/context-note.ts";
import { createContextRemainingToolDefinition, createNewContextToolDefinition } from "./tools/context-window.ts";
import { createHistoryToolDefinition } from "./tools/history.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createLspToolDefinition } from "./tools/lsp.ts";
import { createMcpSearchToolDefinition } from "./tools/mcp-search-tool.ts";
import { createMcpUseToolDefinition } from "./tools/mcp-use-tool.ts";
import { createMemoryGetToolDefinition } from "./tools/memory-get.ts";
import { createMemorySearchToolDefinition } from "./tools/memory-search.ts";
import { createEnterPlanModeToolDefinition, createExitPlanModeToolDefinition } from "./tools/plan-mode.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { boundToolResultContent } from "./tools/tool-result-budget.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./tools/truncate.ts";
import { createUpgradeExecutionToolDefinition } from "./tools/upgrade-execution.ts";
import {
	createDefaultWebFetchOperations,
	createWebFetchToolDefinition,
	type WebFetchOperations,
} from "./tools/web-fetch.ts";
import { createWebSearchToolDefinition, type WebSearchOperations } from "./tools/web-search.ts";
import {
	createTraceAssistantChunk,
	createTraceRequestHeader,
	getNextTraceTurn,
	type SessionTraceEvent,
} from "./trace.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const skillBlockPattern = new RegExp(
		'^<skill name="([^"]+)" location="([^"]+)">\\n' + "([\\s\\S]*?)" + "\\n<\\/skill>(?:\\n\\n([\\s\\S]+))?$",
	);
	const match = skillBlockPattern.exec(text);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Why a shake ran. Recorded on the session entry and emitted for the UI. */
export type ShakeReason = "manual" | "threshold" | "compaction-budget-exhausted";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" | "request_start" | "queue_delivery" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			outcome?: Extract<AgentEvent, { type: "agent_end" }>["outcome"];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "shake"; reason: ShakeReason; tokensSaved: number; regionCount: number }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "execution_upgrade"; outcome: ExecutionUpgradeOutcome; taskId?: string }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	subagentRoot?: RootSubagentSession;
	/** The root coordinator owns every model turn in this child session. */
	subagentRunScope?: SubagentRunScope;
	subagentPermission?: () => SubagentPermission;
	collaborationTools?: ToolDefinition[];
	/** A child captures the parent's upgrade policy at spawn time. */
	executionUpgrade?: ExecutionUpgradeConfig;
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** File path for the permission-decision audit log (JSONL). When omitted, permission decisions are evaluated but not persisted to disk. */
	permissionAuditLogPath?: string;
	/** Root directory for the Grok-aligned memory system (memory_search/memory_get + compaction memory flush). Default: getMemoryDir() (~/.pi/agent/memory). Tests should override this to a tmpdir. */
	memoryRootDir?: string;
	/** Deterministic archive extractor injection. Production uses the configured model with no tools. */
	memoryArchiveExtractor?: MemoryArchiveExtractor;
	/** Language server configs for the `lsp` tool. The tool is not registered when omitted or empty. */
	lspServers?: LspServerConfig[];
	/** MCP server configs. search_tool/use_tool only register when this is non-empty (Grok two-stage discovery, spec 13). */
	mcpServers?: McpServerConfig[];
	/** Search backend for web_search. The tool is not registered when omitted. */
	webSearchOperations?: WebSearchOperations;
	/** Overrides the default (real, fetch()-backed) web_fetch backend. */
	webFetchOperations?: WebFetchOperations;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

export interface MemoryFlushResult {
	attempted: boolean;
	status: "processed" | "deferred" | "disabled";
	jobId?: string;
	manifestId?: string;
	written: number;
	skipped: number;
	remainingSources: number;
	reasons: string[];
	warning?: string;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "custom") return "";
	return contentText(message.content, "");
}

type PostRunAction = "continue" | "continue_save_state" | "wait" | "stop";

const SAVE_STATE_SUPERSESSION_INSTRUCTION =
	"If context_note query returns an active next_action/current, include supersedesEventId set exactly to that item's eventId in the upsert; omit supersedesEventId only when no active entry exists.";
const SAVE_STATE_CONTENT_INSTRUCTION =
	"The text must choose exactly one immediate action that can finish within one context window, such as editing one named file or running one named check, and preserve the established findings needed for that action, including the exact failure, Task outcome, completed required Memory or external reads, and command. Keep later work in referenced Todos instead of combining every remaining step into next_action. Do not turn completed inspection, retrieval, or known failed attempts back into future work.";

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const SAVE_STATE_TOOL_NAMES = CONTEXT_CONTROL_TOOLS;

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	private _executionMonitor = new ExecutionMonitor();
	private _executionUpgradeOverride?: ExecutionUpgradeConfig;
	private _selectionRevision = 0;
	private _executionRequestRevision = 0;
	private _preparedExecutionRevision = 0;
	private _executionBusinessRequest = false;
	private _executionToolRequests = new Map<string, { request: ExecutionUpgradeRequest; revision: number }>();
	private _pendingExecutionUpgrade?: { outcome: ExecutionUpgradeOutcome; revision: number };
	private _lastExecutionUpgrade?: ExecutionUpgradeOutcome;
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private readonly _subagentRunScope?: SubagentRunScope;
	private readonly _subagentPermission?: () => SubagentPermission;
	private readonly _collaborationTools: ToolDefinition[];
	readonly subagents?: RootSubagentSession;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	private _pendingDeliveryStore: PendingDeliveryStore;
	private _deliveredPendingMessages = new WeakSet<object>();
	private _rolloverDispatchPreparationId: string | undefined;
	private _contextRollover!: ContextRollover;
	private _contextRemaining: ContextRemaining | undefined;
	private _latestRequest: { budget: ContextBudget; requestFingerprint: string } | undefined;
	private _lastProviderRequest: Context | undefined;
	private _controlReadTokens = 0;
	private _recoveryNoProgressCount = 0;
	private _recoveryProgressRolloverId: string | undefined;
	private _recoveryProgressFingerprints = new Set<string>();
	private _deferredContextTransition = false;
	private _toolEvidenceInputs = new Map<string, { toolName: string; args: unknown }>();
	private _toolBatchSizeByCallId = new Map<string, number>();
	private _controlReadBudgetByCallId = new Map<string, number>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _promptAborted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private _nextTraceTurn = 0;
	private _traceTurn: number | undefined;
	private _traceStep = -1;
	private _permissionService!: PermissionService;
	private _todoNudgeTracker!: TodoNudgeTracker;
	private _taskManager!: TaskManager;
	private _taskTraceTurns = new Map<string, number>();
	private _todoStateStore!: TodoStateStore;
	private _todoGateFireCount = 0;
	private _planModeState: PlanModeState = OFF_PLAN_MODE_STATE;
	private _pendingInteractions!: PendingInteractionRegistry;
	private _memoryStore!: MemoryStore;
	private _memoryAuthority!: MemoryAuthority;
	private _memoryArchiveService: MemoryArchiveService | undefined;
	private _memoryArchiveEnabled = false;
	private _memoryRootPromptId: string | undefined;
	private _memoryRootSourceId: string | undefined;
	private _memoryRootSourceContent: string | undefined;
	private _memoryEvidenceSequence = 0;
	private _taskMemorySequence = new Map<string, number>();
	private _taskMemoryEvidenceFailed = new Set<string>();
	private _memoryQueueOrigins = new Map<string, "user" | "runtime" | "extension">();
	private _memoryArchiveProcessing: Promise<void> | undefined;
	private _memoryArchiveRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	private _lspManager!: LspManager;
	private _lspEnabled = false;
	private _mcpManager!: McpManager;
	private _webFetchOps!: WebFetchOperations;
	private _webSearchOps: WebSearchOperations | undefined;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		const ownership = config.sessionManager.getHeader()?.ownership;
		if (ownership?.kind === "root" && !config.subagentRoot) throw new SubagentError("root_coordinator_required");
		if (ownership?.kind === "child" && !config.subagentRunScope) throw new SubagentError("child_requires_root");
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this._subagentRunScope = config.subagentRunScope;
		this._subagentPermission = config.subagentPermission;
		this._collaborationTools = config.collaborationTools ?? [];
		this.subagents = config.subagentRoot;
		this._pendingDeliveryStore = new PendingDeliveryStore(this.sessionManager);
		this.settingsManager = config.settingsManager;
		this._executionUpgradeOverride = config.executionUpgrade ? structuredClone(config.executionUpgrade) : undefined;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._nextTraceTurn = getNextTraceTurn(this.sessionManager.getEntries());
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		for (const item of this._pendingDeliveryStore.snapshot().items) {
			if (this._subagentRunScope) {
				this._pendingDeliveryStore.cancel(item.queueItemId);
				continue;
			}
			if (item.channel === "steering") {
				this.agent.steer({ queueItemId: item.queueItemId, message: item.message });
			} else if (item.channel === "follow_up") {
				this.agent.followUp({ queueItemId: item.queueItemId, message: item.message });
			}
		}
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._permissionService = new PermissionService({
			getMode: () => (this._planModeState.status !== "off" ? "plan" : this.settingsManager.getPermissionMode()),
			getAllowRules: () => this.settingsManager.getPermissionAllowRules(),
			getDenyRules: () => this.settingsManager.getPermissionDenyRules(),
			getAuditEnabled: () => this.settingsManager.isPermissionAuditEnabled(),
			getCwd: () => this._cwd,
			auditLog: config.permissionAuditLogPath
				? new JsonlPermissionAuditLog(config.permissionAuditLogPath)
				: NULL_AUDIT_LOG,
		});
		const reminderPolicy = this.settingsManager.getReminderPolicy();
		this._todoNudgeTracker = new TodoNudgeTracker({
			...reminderPolicy.todoNudge,
			enabled: reminderPolicy.enabled && reminderPolicy.todoNudge.enabled,
		});
		const memoryRoot = config.memoryRootDir ?? getMemoryDir();
		const memorySettings = this.settingsManager.getMemorySettings();
		const memoryEmbeddingConfig = resolveEmbeddingConfig(memorySettings.embedding, process.env);
		this._memoryStore = new MemoryStore(
			memoryRoot,
			memoryEmbeddingConfig ? createOpenAiCompatibleEmbedder(memoryEmbeddingConfig) : undefined,
		);
		const archiveExtractor =
			config.memoryArchiveExtractor ??
			({
				extract: async (sources, archiveSignal) => {
					const model = this.model;
					if (!model) throw new Error("memory_archive_no_model");
					const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
					const controller = new AbortController();
					const onArchiveAbort = () => controller.abort();
					if (archiveSignal?.aborted) controller.abort();
					else archiveSignal?.addEventListener("abort", onArchiveAbort, { once: true });
					const timeout = setTimeout(() => controller.abort(), memorySettings.archive.modelCallTimeoutMs);
					try {
						return await extractArchivedMemory(
							sources,
							model,
							{
								apiKey,
								headers,
								env,
								signal: controller.signal,
								maxTokens: memorySettings.archive.maxOutputTokensPerCall,
							},
							this.agent.streamFunction,
							memorySettings.archive.maxCandidatesPerBatch,
							(usage) =>
								this._appendTraceSafely({
									type: "memory/archive",
									data: {
										turn: Math.max(0, this._nextTraceTurn - 1),
										phase: "processing",
										ran: true,
										reason: "extraction_model_call",
										usage,
									},
								}),
						);
					} finally {
						clearTimeout(timeout);
						archiveSignal?.removeEventListener("abort", onArchiveAbort);
					}
				},
				validate: async (candidate, sources, conflicts, archiveSignal) => {
					const model = this.model;
					if (!model) throw new Error("memory_archive_no_model");
					const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
					const controller = new AbortController();
					const onArchiveAbort = () => controller.abort();
					if (archiveSignal?.aborted) controller.abort();
					else archiveSignal?.addEventListener("abort", onArchiveAbort, { once: true });
					const timeout = setTimeout(() => controller.abort(), memorySettings.archive.modelCallTimeoutMs);
					try {
						return await validateArchivedMemoryCandidate(
							candidate,
							sources,
							conflicts,
							model,
							{
								apiKey,
								headers,
								env,
								signal: controller.signal,
								maxTokens: memorySettings.archive.maxOutputTokensPerCall,
							},
							this.agent.streamFunction,
							(usage) =>
								this._appendTraceSafely({
									type: "memory/archive",
									data: {
										turn: Math.max(0, this._nextTraceTurn - 1),
										phase: "processing",
										ran: true,
										reason: "validation_model_call",
										usage,
									},
								}),
						);
					} finally {
						clearTimeout(timeout);
						archiveSignal?.removeEventListener("abort", onArchiveAbort);
					}
				},
			} satisfies MemoryArchiveExtractor);
		this._memoryArchiveService = memorySettings.enabled
			? new MemoryArchiveService(memoryRoot, this._cwd, archiveExtractor, {
					maxConcurrencyPerProject: memorySettings.archive.maxConcurrencyPerProject,
					maxFailuresPerWorkItem: memorySettings.archive.maxFailuresPerWorkItem,
					maxInputTokensPerCall: memorySettings.archive.maxInputTokensPerCall,
					maxModelCallsPerProjectHour: memorySettings.archive.maxModelCallsPerProjectHour,
					maxCandidatesPerBatch: memorySettings.archive.maxCandidatesPerBatch,
					maxModelCallsPerSlice: memorySettings.archive.maxModelCallsPerSlice,
				})
			: undefined;
		this._memoryAuthority = this._memoryArchiveService?.authority ?? new MemoryAuthority(memoryRoot, this._cwd);
		this._memoryArchiveEnabled =
			memorySettings.enabled &&
			memorySettings.archive.enabled &&
			this.sessionManager.getHeader()?.ownership?.kind !== "child";
		const allMemoryEvidence = this.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "memory_evidence" && entry.visibility !== "project_rule");
		for (const entry of allMemoryEvidence) {
			if (entry.type !== "memory_evidence") continue;
			const run = this._memoryAuthority.getRun(entry.rootPromptId);
			if (run?.sessionId !== this.sessionId) continue;
			try {
				if (
					run.pendingEvidenceIds.includes(entry.evidenceEventId) ||
					!run.sourceIds.includes(entry.evidenceEventId)
				) {
					this._memoryArchiveService?.recordEvidence(entry.rootPromptId, {
						sourceId: entry.evidenceEventId,
						origin: entry.origin,
						content: entry.content,
						visibility: entry.visibility,
						completeness: entry.completeness,
						entryId: entry.sourceEntryId ?? entry.id,
						toolCallId: entry.toolCallId,
						taskId: entry.taskId,
					});
				}
				if (entry.deliveryState === "delivered" && entry.sourceEntryId) {
					this._memoryAuthority.bindEvidenceSourceEntry(
						entry.rootPromptId,
						entry.evidenceEventId,
						entry.sourceEntryId,
					);
				}
			} catch {
				// Pending evidence remains authoritative and blocks archive eligibility.
			}
		}
		const branchIds = new Set(this.sessionManager.getBranch().map((entry) => entry.id));
		const deliveredEvidenceIds = new Set(
			allMemoryEvidence
				.filter((entry) => entry.type === "memory_evidence" && entry.deliveryState === "delivered")
				.map((entry) => (entry.type === "memory_evidence" ? entry.evidenceEventId : "")),
		);
		const persistedMemoryRun = [...allMemoryEvidence]
			.reverse()
			.find(
				(entry) =>
					entry.type === "memory_evidence" &&
					(entry.parentId === null || branchIds.has(entry.parentId)) &&
					(entry.deliveryState === "delivered" || !deliveredEvidenceIds.has(entry.evidenceEventId)),
			);
		if (persistedMemoryRun?.type === "memory_evidence") {
			const rootPromptId = persistedMemoryRun.rootPromptId;
			const run = this._memoryAuthority.getRun(rootPromptId);
			if (run?.sessionId === this.sessionId) {
				this._memoryRootPromptId = rootPromptId;
				if (run.mainState === "running") {
					this._memoryArchiveService?.settleRun(rootPromptId, undefined, "outcome_unknown");
				}
			}
		}
		this._taskManager = new TaskManager(
			(transition) => {
				this._recordMemoryTaskTransition(transition);
				if (["completed", "blocked", "failed", "cancelled"].includes(transition.to))
					this._scheduleDeferredContextTransition();
				let turn = this._taskTraceTurns.get(transition.taskId);
				if (transition.from === undefined) {
					if (this._traceTurn === undefined) return;
					turn = this._traceTurn;
					this._taskTraceTurns.set(transition.taskId, turn);
				}
				if (turn === undefined) return;
				this.sessionManager.appendTrace({ type: "task/state", data: { turn, ...transition } });
				if (
					transition.to === "completed" ||
					transition.to === "blocked" ||
					transition.to === "failed" ||
					transition.to === "cancelled"
				) {
					const completedTask =
						transition.to === "completed"
							? this._taskManager
									.list()
									.find((task) => task.taskId === transition.taskId && task.status === "completed")
							: undefined;
					if (
						completedTask?.status === "completed" &&
						(completedTask.result !== undefined || completedTask.exitCode === 0)
					) {
						this.sessionManager.appendContextProgress({
							evidenceId: fingerprintContextRolloverValue({ kind: "task_completed", taskId: transition.taskId }),
							evidenceKind: "task_completed",
							targetFingerprint: fingerprintContextRolloverValue({ taskId: transition.taskId }),
							resultFingerprint: fingerprintContextRolloverValue({
								result: completedTask.result,
								exitCode: completedTask.exitCode,
							}),
							outcome: "succeeded",
							taskId: transition.taskId,
						});
					}
					this._taskTraceTurns.delete(transition.taskId);
				}
			},
			() => ({ ownerSessionId: this.sessionId, rootPromptId: this._memoryRootPromptId }),
			(taskId, chunk) => {
				this._recordMemoryTaskOutput(taskId, chunk);
			},
			this._subagentRunScope,
		);
		// Grok-aligned TodoState persistence (spec 6.4): restore from the session's latest "todo-state"
		// custom entry if one exists (resume/reload), otherwise start empty. The tool wiring below
		// (see the todo_write tool construction in _buildRuntime) persists every subsequent mutation
		// back via the same mechanism.
		const persistedTodoState = getLatestCustomEntryData<ReturnType<TodoStateStore["toJSON"]>>(
			this.sessionManager.getBranch(),
			"todo-state",
		);
		this._todoStateStore = persistedTodoState ? TodoStateStore.fromJSON(persistedTodoState) : new TodoStateStore();
		this._pendingInteractions = new PendingInteractionRegistry();
		this._contextRollover = new ContextRollover({
			agent: this.agent,
			manager: this.sessionManager,
			revisions: () => this._contextRolloverRevisions(),
			transitionGate: (requiredTaskIds) => this.getContextTransitionGate(requiredTaskIds),
			isCancelled: () => this._promptAborted,
			pendingDeliveryIds: () => this._pendingDeliveryStore.snapshot().items.map((item) => item.queueItemId),
			canRecover: (recovery) => this._canRecoverContext(recovery),
			workThresholdPercent: () => this.settingsManager.getContextWorkThresholdPercent(),
			measureSource: () => this._measureRequest(),
			onDispatch: (id) => {
				this._rolloverDispatchPreparationId = id;
			},
			onTrace: (data) =>
				this._appendTraceSafely({
					type: "context/rollover",
					data: { turn: Math.max(0, this._nextTraceTurn - 1), ...data },
				}),
		});
		this._lspEnabled = (config.lspServers?.length ?? 0) > 0;
		this._lspManager = new LspManager({
			cwd: this._cwd,
			servers: config.lspServers ?? [],
			taskManager: this._taskManager,
		});
		this._mcpManager = new McpManager(config.mcpServers);
		this._webFetchOps = config.webFetchOperations ?? createDefaultWebFetchOperations();
		this._webSearchOps = config.webSearchOperations;
		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installContextGuard();
		this._installExecutionUpgrade();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._memoryRootPromptId) this._requestMemoryArchiveCheck(this._memoryRootPromptId);

		// Restore Plan Mode across resume/reload (spec 7). "awaiting_approval" collapses to "planning":
		// its PendingInteraction cannot survive a process restart, but the mutation-disabling intent it
		// represented should not silently evaporate either. "off"/missing entries are a no-op (the
		// constructor already starts at OFF_PLAN_MODE_STATE).
		const persistedPlanModeState = getLatestCustomEntryData<PlanModeState>(
			this.sessionManager.getEntries(),
			"plan-mode-state",
		);
		if (persistedPlanModeState && persistedPlanModeState.status !== "off") {
			this._planModeState = {
				status: "planning",
				plan: persistedPlanModeState.plan,
				previousActiveToolNames: persistedPlanModeState.previousActiveToolNames,
			};
			const readOnly = PLAN_MODE_READ_ONLY_TOOLS.filter((name) => this._toolRegistry.has(name));
			this.setActiveToolsByName([...new Set([...readOnly, "enter_plan_mode", "exit_plan_mode"])]);
		}
		this.subagents?.bind(this, () => this._dispose());
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get taskManager(): TaskManager {
		return this._taskManager;
	}

	get memoryStore(): MemoryStore {
		return this._memoryStore;
	}

	get memoryAuthority(): MemoryAuthority {
		return this._memoryAuthority;
	}

	rememberMemoryRule(text: string): { memoryId: string; revision: number } {
		const normalized = text.trim();
		if (!normalized) throw new Error("memory_rule_empty");
		if (!this.settingsManager.getMemorySettings().enabled) throw new Error("memory_disabled");
		const rootPromptId = randomUUID();
		const sourceId = `evidence-${randomUUID()}`;
		const entryId = this.sessionManager.appendMemoryEvidence({
			evidenceEventId: sourceId,
			rootPromptId,
			origin: "user",
			content: normalized,
			visibility: "project_rule",
		});
		const record = this._memoryAuthority.rememberUserRule({
			rootPromptId,
			sessionId: this.sessionId,
			sourceId,
			entryId,
			text: normalized,
			contentHash: createHash("sha256").update(normalized).digest("hex"),
		});
		return { memoryId: record.memoryId, revision: record.revision };
	}

	revokeMemory(memoryId: string): boolean {
		try {
			this._memoryAuthority.revokeMemory(memoryId, "explicit_user_revoke");
			return true;
		} catch (error) {
			if (error instanceof Error && error.message === "memory_record_not_found") return false;
			throw error;
		}
	}

	getMemoryStatus(): MemoryArchiveStatus {
		return this._memoryAuthority.getStatus();
	}

	private _recordMemoryEvidence(rootPromptId: string, input: MemoryEvidenceInput): boolean {
		if (!this._memoryArchiveService) return false;
		try {
			const evidenceEntryId = this.sessionManager.appendMemoryEvidence({
				evidenceEventId: input.sourceId,
				rootPromptId,
				origin: input.origin,
				content: input.content,
				visibility: input.visibility,
				completeness: input.completeness,
				sourceEntryId: input.entryId,
				toolCallId: input.toolCallId,
				taskId: input.taskId,
			});
			this._memoryArchiveService.recordEvidence(rootPromptId, {
				...input,
				entryId: input.entryId ?? evidenceEntryId,
			});
			return true;
		} catch (error) {
			this._appendTraceSafely({
				type: "memory/archive",
				data: {
					turn: Math.max(0, this._nextTraceTurn - 1),
					ran: false,
					reason: error instanceof Error ? error.message : "memory_evidence_write_failed",
					written: 0,
					skipped: 1,
				},
			});
			return false;
		}
	}

	private _startMemoryRun(originalText: string, transformedText: string, expandedText: string): void {
		const service = this._memoryArchiveService;
		if (!service) return;
		const rootPromptId = randomUUID();
		const sourceId = `evidence-${randomUUID()}`;
		const branchStartEntryId = this.sessionManager.getLeafId() ?? undefined;
		const sourceEntryId = this.sessionManager.appendMemoryEvidence({
			evidenceEventId: sourceId,
			rootPromptId,
			origin: "user",
			content: originalText,
			visibility: "session",
			deliveryState: "pending",
		});
		service.startRun({
			rootPromptId,
			sessionId: this.sessionId,
			branchStartEntryId,
			taskSourceEntryId: sourceEntryId,
			promptGeneration: this.sessionManager.getLatestContextCoordinates().promptGeneration + 1,
		});
		service.recordEvidence(rootPromptId, {
			sourceId,
			origin: "user",
			content: originalText,
			visibility: "session",
			entryId: sourceEntryId,
		});
		this._memoryRootPromptId = rootPromptId;
		this._memoryRootSourceId = sourceId;
		this._memoryRootSourceContent = originalText;
		this._memoryEvidenceSequence = 0;
		if (transformedText !== originalText) {
			this._recordMemoryEvidence(rootPromptId, {
				sourceId: `${rootPromptId}:extension-input`,
				origin: "extension",
				content: transformedText,
				visibility: "session",
			});
		}
		if (expandedText !== transformedText) {
			this._recordMemoryEvidence(rootPromptId, {
				sourceId: `${rootPromptId}:runtime-input`,
				origin: "runtime",
				content: expandedText,
				visibility: "session",
			});
		}
	}

	private _settleCurrentMemoryRun(forcedOutcome?: NonNullable<MemoryRun["outcome"]>): void {
		const rootPromptId = this._memoryRootPromptId;
		const service = this._memoryArchiveService;
		if (!rootPromptId || !service) return;
		const run = service.authority.getRun(rootPromptId);
		if (!run) return;
		const rolloverDispatchState = this.contextRolloverState.dispatchState;
		const continuationState: MemoryRun["continuationState"] =
			rolloverDispatchState === "outcome_unknown"
				? "outcome_unknown"
				: this._deferredContextTransition ||
						this._pendingInteractions.list().length > 0 ||
						rolloverDispatchState === "prepared" ||
						rolloverDispatchState === "started"
					? "pending"
					: "none";
		const state = this.agent.state.runState;
		const lastOutcome = state.status === "idle" ? state.lastOutcome?.type : undefined;
		let outcome: NonNullable<MemoryRun["outcome"]> = forcedOutcome ?? "completed";
		if (!forcedOutcome && (this._promptAborted || lastOutcome === "aborted")) outcome = "interrupted";
		else if (
			!forcedOutcome &&
			(lastOutcome === "failed" ||
				lastOutcome === "context_limit" ||
				lastOutcome === "context_maintenance" ||
				lastOutcome === "context_transition")
		)
			outcome = "failed";
		service.settleRun(rootPromptId, continuationState === "none" ? outcome : undefined, continuationState);
		this._requestMemoryArchiveCheck(rootPromptId);
	}

	private _recordMemoryTaskOutput(taskId: string, chunk: string): void {
		if (!this._memoryArchiveService || !chunk) return;
		const task = this._taskManager.get(taskId);
		if (!task?.rootPromptId) return;
		const sequence = this._taskMemorySequence.get(taskId) ?? 0;
		this._taskMemorySequence.set(taskId, sequence + 1);
		if (
			!this._recordMemoryEvidence(task.rootPromptId, {
				sourceId: `${taskId}:output:${sequence}`,
				origin: "tool",
				content: chunk,
				visibility: "session",
				taskId,
			})
		) {
			this._taskMemoryEvidenceFailed.add(taskId);
		}
	}

	private _recordMemoryTaskTransition(transition: TaskStateTransition): void {
		const service = this._memoryArchiveService;
		const rootPromptId = transition.rootPromptId;
		if (!service || !rootPromptId) return;
		try {
			if (transition.from === undefined) {
				service.registerTask(rootPromptId, transition.taskId, transition.archiveRole);
				return;
			}
			if (!["completed", "blocked", "failed", "cancelled"].includes(transition.to)) return;
			const snapshot = this._taskManager.get(transition.taskId);
			const recorded = this._recordMemoryEvidence(rootPromptId, {
				sourceId: `${transition.taskId}:terminal`,
				origin: "tool",
				content: JSON.stringify(snapshot ?? transition),
				visibility: "session",
				taskId: transition.taskId,
				completeness: this._taskMemoryEvidenceFailed.has(transition.taskId) ? "partial" : "complete",
			});
			if (!recorded) throw new Error("memory_task_evidence_unavailable");
			service.recordTaskEvidence(rootPromptId, transition.taskId, "durable");
			this._taskMemorySequence.delete(transition.taskId);
			this._taskMemoryEvidenceFailed.delete(transition.taskId);
			this._requestMemoryArchiveCheck(rootPromptId);
		} catch {
			try {
				service.recordTaskEvidence(rootPromptId, transition.taskId, "unavailable");
			} catch {
				// The original evidence failure remains authoritative.
			}
		}
	}

	private _requestMemoryArchiveCheck(rootPromptId: string): void {
		if (!this._memoryArchiveEnabled || !this._memoryArchiveService) return;
		try {
			if (this._memoryArchiveService.checkArchiveEligibility(rootPromptId).status === "ready") {
				const job = this._memoryArchiveService.sealRun(rootPromptId);
				this._appendTraceSafely({
					type: "memory/archive",
					data: {
						turn: Math.max(0, this._nextTraceTurn - 1),
						rootPromptId,
						jobId: job.jobId,
						manifestId: job.manifestId,
						phase: "sealed",
						ran: true,
						reason: "archive_ready",
					},
				});
				this._scheduleMemoryArchiveProcessing();
			}
		} catch {
			// Persisted run/job state remains available for status and recovery.
		}
	}

	private _scheduleMemoryArchiveProcessing(): void {
		if (this._disposed || this._memoryArchiveProcessing || !this._memoryArchiveService) return;
		this._memoryArchiveProcessing = this.drainMemoryArchive().finally(() => {
			this._memoryArchiveProcessing = undefined;
			if ((this._memoryArchiveService?.authority.getStatus().jobs.queued ?? 0) > 0) {
				setTimeout(() => this._scheduleMemoryArchiveProcessing(), 0);
			}
		});
	}

	private _scheduleMemoryArchiveRetry(retryAt: string): void {
		if (this._disposed || this._memoryArchiveRetryTimer) return;
		const delay = Math.max(0, Date.parse(retryAt) - Date.now());
		this._memoryArchiveRetryTimer = setTimeout(
			() => {
				this._memoryArchiveRetryTimer = undefined;
				this._scheduleMemoryArchiveProcessing();
			},
			Math.min(delay, 2_147_483_647),
		);
		this._memoryArchiveRetryTimer.unref?.();
	}

	async drainMemoryArchive(): Promise<void> {
		if (this._memoryArchiveProcessing) {
			await this._memoryArchiveProcessing;
			return;
		}
		const service = this._memoryArchiveService;
		if (!service) return;
		while (true) {
			const result = await service.processNext();
			if (result.status !== "idle") {
				this._appendTraceSafely({
					type: "memory/archive",
					data: {
						turn: Math.max(0, this._nextTraceTurn - 1),
						jobId: result.jobId,
						phase:
							result.status === "completed"
								? "completed"
								: result.status === "retryable_failed" || result.status === "needs_review"
									? "failed"
									: "processing",
						ran: true,
						reason: result.status,
						written: result.accepted,
						skipped: result.rejected,
					},
				});
			}
			if (result.status === "budget_wait") {
				if (result.retryAt) this._scheduleMemoryArchiveRetry(result.retryAt);
				return;
			}
			if (result.status === "idle" || result.status === "needs_review" || result.status === "yielded") return;
			if (result.status === "retryable_failed") service.requeueFailedJobs();
		}
	}

	/**
	 * Seal and process the current closed evidence run. This uses the normal archive job, validation,
	 * conflict, and authority transaction path. It does not summarize or mutate the live context.
	 */
	async flushMemoryNow(): Promise<MemoryFlushResult> {
		const service = this._memoryArchiveService;
		const rootPromptId = this._memoryRootPromptId;
		if (!service || !rootPromptId) {
			return {
				attempted: false,
				status: "disabled",
				written: 0,
				skipped: 0,
				remainingSources: 0,
				reasons: [service ? "no_current_run" : "memory_disabled"],
			};
		}
		if (this._memoryArchiveProcessing) await this._memoryArchiveProcessing;
		const eligibility = service.checkArchiveEligibility(rootPromptId);
		if (eligibility.status !== "ready") {
			return {
				attempted: false,
				status: "deferred",
				written: 0,
				skipped: 0,
				remainingSources: service.authority.getRun(rootPromptId)?.sourceIds.length ?? 0,
				reasons: [eligibility.status],
			};
		}
		try {
			const job = service.sealRun(rootPromptId);
			this._appendTraceSafely({
				type: "memory/archive",
				data: {
					turn: Math.max(0, this._nextTraceTurn - 1),
					rootPromptId,
					jobId: job.jobId,
					manifestId: job.manifestId,
					phase: "sealed",
					ran: true,
					reason: "manual_flush",
				},
			});
			await this.drainMemoryArchive();
			const completed = service.authority.getJob(job.jobId) ?? job;
			return {
				attempted: true,
				status: completed.status === "completed" ? "processed" : "deferred",
				jobId: job.jobId,
				manifestId: job.manifestId,
				written: completed.accepted,
				skipped: completed.rejected,
				remainingSources:
					completed.status === "completed" ? 0 : (service.authority.getRun(rootPromptId)?.sourceIds.length ?? 0),
				reasons: completed.reasonCode ? [completed.reasonCode] : [],
			};
		} catch (error) {
			return {
				attempted: true,
				status: "deferred",
				written: 0,
				skipped: 0,
				remainingSources: service.authority.getRun(rootPromptId)?.sourceIds.length ?? 0,
				reasons: [error instanceof Error ? error.message : "memory_flush_failed"],
				warning: "memory flush failed",
			};
		}
	}

	/** The Grok-aligned TodoState store (spec 6.4), restored from/persisted to a session custom entry. */
	get todoStateStore(): TodoStateStore {
		return this._todoStateStore;
	}

	get lspManager(): LspManager {
		return this._lspManager;
	}

	get mcpManager(): McpManager {
		return this._mcpManager;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			return {
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			return result
				? { apiKey: result.auth.apiKey, headers: withoutDeletedHeaders(result.auth.headers), env: result.env }
				: {};
		} catch {
			return {};
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			return {
				content: hookResult?.content ?? result.content,
				details: hookResult?.details ?? result.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage ?? result.usage,
			};
		};

		this.agent.guardToolCall = async ({ toolCall, args }) => {
			this._subagentRunScope?.assertActive();
			const { windowId } = this.sessionManager.ensureContextWindow();
			const coordinates = this.sessionManager.getLatestContextCoordinates();
			const saving = getSaveStateOperation(this.sessionManager, windowId, coordinates.promptGeneration);
			if (saving && !saving.finished && !SAVE_STATE_TOOL_NAMES.some((name) => name === toolCall.name))
				return {
					block: true,
					reason: "Only History, Note, budget and window control tools are allowed during state saving",
				};
			const recovering = this._recoveringRollover();
			if (
				recovering &&
				(!RECOVERY_TOOL_NAMES.some((name) => name === toolCall.name) ||
					(toolCall.name === "context_note" &&
						typeof args === "object" &&
						args !== null &&
						"operation" in args &&
						args.operation !== "query"))
			)
				return {
					block: true,
					reason: "Only recovery reads and budget queries are allowed until sourced bodies enter a request",
				};
			const result = this._permissionService.evaluate(toolCall.name, args, toolCall.id);
			if (result.decision === "allow") {
				return undefined;
			}
			if (result.decision === "deny") {
				return { block: true, reason: result.reason };
			}
			if (this._extensionUIContext) {
				try {
					const approved = await this._extensionUIContext.confirm(
						"Permission required",
						`${result.operation}\n\n${result.reason}`,
					);
					if (approved) return undefined;
					return { block: true, reason: `${result.reason} (denied by user)` };
				} catch {
					return { block: true, reason: `${result.reason} (approval channel failed)` };
				}
			}
			return {
				block: true,
				reason: `${result.reason} (blocked: no approval channel configured; allow via permissions.mode, an allow rule, or permissions.mode="bypassPermissions")`,
			};
		};
	}

	private _permissionAllows(toolName: string, args: unknown): boolean {
		return (
			decideToolPermission({
				mode: this._planModeState.status !== "off" ? "plan" : this.settingsManager.getPermissionMode(),
				allow: this.settingsManager.getPermissionAllowRules(),
				deny: this.settingsManager.getPermissionDenyRules(),
				cwd: this._cwd,
				toolName,
				args,
			}).decision === "allow"
		);
	}

	private _canRecoverContext(recovery?: ContextRecoveryReferences): boolean {
		if (!RECOVERY_TOOL_NAMES.every((toolName) => this.getActiveToolNames().includes(toolName))) return false;
		const checks: Array<{ toolName: string; args: unknown }> = recovery
			? [
					{ toolName: "context_note", args: { operation: "query", item: recovery.nextActionEventId } },
					...recovery.relatedNoteEventIds.map((item) => ({
						toolName: "context_note",
						args: { operation: "query", item },
					})),
					...[...recovery.requirementSourceRefs, ...recovery.requiredHistoryRefs].map((reference) => ({
						toolName: "history",
						args: { operation: "read_item", ...reference },
					})),
					...recovery.todoIds.map((todoId) => ({
						toolName: "history",
						args: { operation: "read_item", entryId: recovery.todoStateEntryId, todoId },
					})),
				]
			: [
					{ toolName: "context_note", args: { operation: "query" } },
					{ toolName: "history", args: { operation: "list_items", role: "user" } },
				];
		return checks.every((check) => this._permissionAllows(check.toolName, check.args));
	}

	private _taskNoteRevision(promptGeneration: number): string | undefined {
		const branch = this.sessionManager.getBranch();
		const scope = resolveTaskNoteScope(branch, promptGeneration);
		if (!scope) return undefined;
		const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
		return projection.status === "valid" ? projection.snapshot.revision : undefined;
	}

	private _startSaveState(
		requestFingerprint: string,
		transitionCause: ContextControlCause = "work_budget_reached",
	):
		| { type: "failed"; message: string }
		| {
				type: "save_state";
				message: CustomMessage;
				toolNames: readonly string[];
				maxTokens: number;
				failureMessage: string;
		  } {
		const { windowId } = this.sessionManager.ensureContextWindow();
		const coordinates = this.sessionManager.getLatestContextCoordinates();
		if (
			!["history", "context_note", "get_context_remaining", "new_context"].every((toolName) =>
				this.getActiveToolNames().includes(toolName),
			)
		) {
			return { type: "failed", message: "recovery_unavailable: missing save-state tool" };
		}
		if (
			!this._permissionAllows("history", { operation: "list_items", role: "user" }) ||
			!this._permissionAllows("context_note", { operation: "query" })
		) {
			return { type: "failed", message: "recovery_unavailable: save-state query is denied" };
		}
		const startTaskNoteRevision = this._taskNoteRevision(coordinates.promptGeneration);
		const businessCutoffEntryId = this.sessionManager.getLeafId();
		if (!startTaskNoteRevision || !businessCutoffEntryId) {
			return { type: "failed", message: "continuation_state_missing: task scope is unavailable" };
		}
		const operationId = randomUUID();
		this.sessionManager.appendContextOperation({
			operationId,
			operationKind: "save_state",
			transitionCause,
			state: "started",
			windowId,
			...coordinates,
			sourceFingerprint: requestFingerprint,
			businessCutoffEntryId,
			startTaskNoteRevision,
			controlBudgetTokens: STATE_SAVE_CONTROL_TOKENS,
			outputBudgetTokens: STATE_SAVE_OUTPUT_TOKENS,
			samplesUsed: 0,
			consumedControlTokens: 0,
			consumedOutputTokens: 0,
		});
		this._appendTraceSafely({
			type: "context/save_state",
			data: {
				turn: Math.max(0, this._nextTraceTurn - 1),
				operationId,
				windowId,
				phase: "started",
				businessCutoffEntryId,
				samplesUsed: 0,
				consumedControlTokens: 0,
				consumedOutputTokens: 0,
			},
		});
		this._controlReadTokens = STATE_SAVE_CONTROL_TOKENS;
		return {
			type: "save_state",
			message: {
				role: "custom",
				customType: "context-save-state",
				content:
					(transitionCause === "model_requested"
						? "You requested a new window. Save the continuation before rollover. "
						: "Shake and Compaction have been attempted. The working context is full. Decide whether to finish here or request a fresh window with new_context. Only your explicit new_context call authorizes rollover. ") +
					`Current budget: ${JSON.stringify(this._contextRemaining)}. ` +
					"No resumeRef exists yet. Do not use the business cutoff entry ID as a resumeRef. " +
					`At most ${SAVE_STATE_MAX_SAMPLES} model responses remain for the entire decision and save sequence. Batch independent control calls in the same response. ` +
					'In the first batch, discover source IDs with history {"operation":"list_items","role":"user"} and query existing Notes with context_note {"operation":"query"} and no resumeRef. Skip reads whose results are already visible. list_windows is insufficient because it does not return source entry IDs. ' +
					"If you choose rollover and have not requested it, include new_context in that batch. Synchronize existing Todo progress in that batch when needed; do not create Todos solely to switch windows. " +
					`${SAVE_STATE_SUPERSESSION_INSTRUCTION} ` +
					`${SAVE_STATE_CONTENT_INSTRUCTION} ` +
					"Synchronize Todo progress with todo_write if needed before saving next_action/current. Preserve every unfinished task. Todo status is authoritative; do not declare completion in a Note. " +
					'Then call context_note with {"operation":"upsert","kind":"next_action","key":"current","text":"...","sourceRefs":[...],"evidenceRefs":[],"resume":{"relatedNotes":[],"requiredHistoryRefs":[...],"requirementSourceRefs":[...],"todoIds":[...],"subagentContinuations":[]}}. For every delegated task in this task scope (including terminal tasks), still-active earlier child and referenced child, populate subagentContinuations with taskId, parentRelation and onResult. Record dependent/independent parent work and result checks/use, or evidence it was already handled. Do not infer handled from terminal status. ' +
					'The key must be exactly "current". Include any directly required Notes and references in resume. Ordinary business tools are unavailable.',
				display: false,
				details: { windowId, businessCutoffEntryId },
				timestamp: Date.now(),
			},
			toolNames: SAVE_STATE_TOOL_NAMES,
			maxTokens: Math.min(STATE_SAVE_OUTPUT_TOKENS, this.agent.state.model.maxTokens),
			failureMessage: "save_state_budget_exhausted",
		};
	}

	private _appendContextControlMessage(message: Extract<AgentMessage, { role: "custom" }>): void {
		this.agent.state.messages.push(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _saveStateUsage(businessCutoffEntryId: string): {
		samplesUsed: number;
		controlTokens: number;
		outputTokens: number;
	} {
		const branch = this.sessionManager.getBranch();
		const cutoff = branch.findIndex((entry) => entry.id === businessCutoffEntryId);
		let samplesUsed = 0;
		let controlTokens = 0;
		let outputTokens = 0;
		for (const entry of branch.slice(cutoff + 1)) {
			const messages = sessionEntryToContextMessages(entry);
			for (const message of messages) {
				const tokens = estimateTokens(message);
				if (message.role === "assistant") {
					samplesUsed++;
					outputTokens += tokens;
				} else {
					controlTokens += tokens;
				}
			}
		}
		return { samplesUsed, controlTokens, outputTokens };
	}

	private _finishSaveState(
		operation: SaveStateOperationSnapshot,
		usage: ReturnType<AgentSession["_saveStateUsage"]>,
		validation: Extract<ContinuationStateValidation, { status: "valid" }>,
	): void {
		const current = getSaveStateOperation(this.sessionManager, operation.windowId, operation.promptGeneration);
		if (current?.finished) return;
		this.sessionManager.appendContextOperation({
			operationId: operation.operationId,
			operationKind: "save_state",
			transitionCause: operation.transitionCause,
			state: "finished",
			windowId: operation.windowId,
			promptGeneration: operation.promptGeneration,
			contextEpoch: operation.contextEpoch,
			sourceFingerprint: operation.sourceFingerprint,
			businessCutoffEntryId: operation.businessCutoffEntryId,
			startTaskNoteRevision: operation.startTaskNoteRevision,
			controlBudgetTokens: operation.controlBudgetTokens,
			outputBudgetTokens: operation.outputBudgetTokens,
			samplesUsed: usage.samplesUsed,
			consumedControlTokens: usage.controlTokens,
			consumedOutputTokens: usage.outputTokens,
			finalTaskNoteRevision: validation.finalTaskNoteRevision,
			nextActionEventId: validation.nextActionEventId,
			relatedNoteEventIds: validation.relatedNoteEventIds,
			noteFreshness: validation.noteFreshness,
			requiredHistoryRefs: validation.requiredHistoryRefs,
			requirementSourceRefs: validation.requirementSourceRefs,
			todoIds: validation.todoIds,
			outcome: "saved",
		});
		this._appendTraceSafely({
			type: "context/save_state",
			data: {
				turn: Math.max(0, this._nextTraceTurn - 1),
				operationId: operation.operationId,
				windowId: operation.windowId,
				phase: "finished",
				businessCutoffEntryId: operation.businessCutoffEntryId,
				samplesUsed: usage.samplesUsed,
				consumedControlTokens: usage.controlTokens,
				consumedOutputTokens: usage.outputTokens,
			},
		});
	}

	private _reserveContextReadBudget(requestedTokens: number, toolCallId: string): ContextReadBudgetReservation {
		const snapshot = this._contextRemaining;
		if (!snapshot || snapshot.phase === "normal") {
			return {
				tokens: snapshot?.remainingWorkTokens ?? null,
				settle: () => {},
			};
		}
		const batchCap = this._controlReadBudgetByCallId.get(toolCallId) ?? this._controlReadTokens;
		const reserved = Math.max(0, Math.min(requestedTokens, batchCap, this._controlReadTokens));
		this._controlReadTokens -= reserved;
		let settled = false;
		return {
			tokens: reserved,
			settle: (usedTokens) => {
				if (settled) return;
				settled = true;
				this._controlReadBudgetByCallId.delete(toolCallId);
				this._controlReadTokens += Math.max(0, reserved - Math.max(0, Math.min(reserved, usedTokens)));
			},
		};
	}

	private _recoveringRollover(): ContextRolloverEntry | undefined {
		const branch = this.sessionManager.getBranch();
		const rollover = this._currentContextRollover(branch);
		if (!rollover) return undefined;
		const rolloverIndex = branch.findIndex((entry) => entry.id === rollover.id);
		const completed = branch
			.slice(rolloverIndex + 1)
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "context-recovery-complete" &&
					typeof entry.details === "object" &&
					entry.details !== null &&
					"rolloverId" in entry.details &&
					entry.details.rolloverId === rollover.rolloverId,
			);
		return completed ? undefined : rollover;
	}

	private _currentContextRollover(branch = this.sessionManager.getBranch()): ContextRolloverEntry | undefined {
		const { promptGeneration } = this.sessionManager.getLatestContextCoordinates();
		const windowId = this.sessionManager.ensureContextWindow().windowId;
		return [...branch]
			.reverse()
			.find(
				(entry): entry is ContextRolloverEntry =>
					entry.type === "context_rollover" &&
					entry.promptGeneration === promptGeneration &&
					entry.windowId === windowId,
			);
	}

	private _completedRecoveryAwaitingBusinessRequest(): boolean {
		const branch = this.sessionManager.getBranch();
		const rollover = this._currentContextRollover(branch);
		if (!rollover) return false;
		const rolloverIndex = branch.findIndex((entry) => entry.id === rollover.id);
		const completionIndex = branch.findIndex(
			(entry, index) =>
				index > rolloverIndex &&
				entry.type === "custom_message" &&
				entry.customType === "context-recovery-complete" &&
				typeof entry.details === "object" &&
				entry.details !== null &&
				"rolloverId" in entry.details &&
				entry.details.rolloverId === rollover.rolloverId,
		);
		if (rolloverIndex < 0) return false;
		return (
			completionIndex > rolloverIndex &&
			!branch
				.slice(completionIndex + 1)
				.some((entry) => entry.type === "message" && entry.message.role === "assistant")
		);
	}

	private _resumableInterruptedDispatch():
		| { rollover: ContextRolloverEntry; lastAssistant: AssistantMessage }
		| undefined {
		if (this.contextRolloverState.dispatchState !== "outcome_unknown") return undefined;
		const branch = this.sessionManager.getBranch();
		const rollover = this._currentContextRollover(branch);
		if (!rollover) return undefined;
		let startIndex = -1;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (
				entry.type === "context_rollover_dispatch" &&
				entry.dispatchId === rollover.dispatchId &&
				entry.state === "started"
			) {
				startIndex = index;
				break;
			}
		}
		if (startIndex < 0) return undefined;
		const branchTail = branch.slice(startIndex + 1);
		const assistants = branchTail.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		const lastAssistant = assistants.at(-1);
		if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
			return undefined;
		try {
			collectCompleteToolTransactions(branchTail);
		} catch {
			return undefined;
		}
		const timeline = this.sessionManager.getBranchWithTrace();
		let timelineStart = -1;
		for (let index = timeline.length - 1; index >= 0; index--) {
			const entry = timeline[index];
			if (
				entry.type === "context_rollover_dispatch" &&
				entry.dispatchId === rollover.dispatchId &&
				entry.state === "started"
			) {
				timelineStart = index;
				break;
			}
		}
		if (timelineStart < 0) return undefined;
		const requestCount = timeline
			.slice(timelineStart + 1)
			.filter((entry) => entry.type === "trace" && entry.event.type === "request/header").length;
		if (requestCount === 0 || requestCount !== assistants.length) return undefined;
		return { rollover, lastAssistant };
	}

	private _restoreRecoveryProgress(rollover: ContextRolloverEntry): void {
		if (this._recoveryProgressRolloverId === rollover.rolloverId) return;
		this._recoveryProgressRolloverId = rollover.rolloverId;
		this._recoveryNoProgressCount = 0;
		this._recoveryProgressFingerprints.clear();
		for (const entry of this.sessionManager.getBranchWithTrace()) {
			if (
				entry.type !== "trace" ||
				entry.event.type !== "context/recovery" ||
				entry.event.data.rolloverId !== rollover.rolloverId ||
				entry.event.data.phase !== "reading"
			)
				continue;
			const { coveredUnits, progressFingerprint } = entry.event.data;
			if (coveredUnits > 0 && !this._recoveryProgressFingerprints.has(progressFingerprint)) {
				this._recoveryNoProgressCount = 0;
				this._recoveryProgressFingerprints.add(progressFingerprint);
			} else this._recoveryNoProgressCount++;
		}
	}

	private async _afterContextControlTurn(turn: PrepareNextTurnContext): Promise<AgentLoopAfterTurnControl> {
		const { windowId } = this.sessionManager.ensureContextWindow();
		const coordinates = this.sessionManager.getLatestContextCoordinates();
		const operation = getSaveStateOperation(this.sessionManager, windowId, coordinates.promptGeneration);
		if (operation && !operation.finished) {
			const usage = this._saveStateUsage(operation.businessCutoffEntryId);
			const validation = validateContinuationState(this.sessionManager, operation);
			const requested = this._pendingContextTransition();
			const base = {
				operationId: operation.operationId,
				operationKind: "save_state" as const,
				transitionCause: operation.transitionCause,
				windowId: operation.windowId,
				promptGeneration: operation.promptGeneration,
				contextEpoch: operation.contextEpoch,
				sourceFingerprint: operation.sourceFingerprint,
				businessCutoffEntryId: operation.businessCutoffEntryId,
				startTaskNoteRevision: operation.startTaskNoteRevision,
				controlBudgetTokens: operation.controlBudgetTokens,
				outputBudgetTokens: operation.outputBudgetTokens,
				samplesUsed: usage.samplesUsed,
				consumedControlTokens: usage.controlTokens,
				consumedOutputTokens: usage.outputTokens,
			};
			if (!requested && turn.message.stopReason === "stop") {
				this.sessionManager.appendContextOperation({
					...base,
					state: "finished",
					outcome: "completed_without_rollover",
				});
				return undefined;
			}
			if (validation.status === "valid" && requested) {
				this._finishSaveState(operation, usage, validation);
				return { type: "context_transition" };
			}
			const reason = validation.status === "invalid" ? validation.reason : "model_request_missing";
			this.sessionManager.appendContextOperation({ ...base, state: "started", outcome: reason });
			const remainingControl = operation.controlBudgetTokens - usage.controlTokens;
			const remainingOutput = operation.outputBudgetTokens - usage.outputTokens;
			if (usage.samplesUsed >= SAVE_STATE_MAX_SAMPLES || remainingControl <= 0 || remainingOutput <= 0) {
				this._appendTraceSafely({
					type: "context/save_state",
					data: {
						turn: Math.max(0, this._nextTraceTurn - 1),
						operationId: operation.operationId,
						windowId: operation.windowId,
						phase: "failed",
						businessCutoffEntryId: operation.businessCutoffEntryId,
						samplesUsed: usage.samplesUsed,
						consumedControlTokens: usage.controlTokens,
						consumedOutputTokens: usage.outputTokens,
						reasonCode: reason,
					},
				});
				return { type: "failed", message: reason };
			}
			this._appendTraceSafely({
				type: "context/save_state",
				data: {
					turn: Math.max(0, this._nextTraceTurn - 1),
					operationId: operation.operationId,
					windowId: operation.windowId,
					phase: "progress",
					businessCutoffEntryId: operation.businessCutoffEntryId,
					samplesUsed: usage.samplesUsed,
					consumedControlTokens: usage.controlTokens,
					consumedOutputTokens: usage.outputTokens,
					reasonCode: reason,
				},
			});
			this._controlReadTokens = Math.max(0, remainingControl);
			const controlMessage = createCustomMessage(
				"context-save-state-correction",
				`Context decision/save is incomplete (${reason}). ${SAVE_STATE_MAX_SAMPLES - usage.samplesUsed} sampling attempt(s) remain for the entire sequence. Finish here, or explicitly request new_context and save next_action/current after Todo synchronization. Batch independent calls and reuse visible results. Follow the continuation contract above. ${SAVE_STATE_SUPERSESSION_INSTRUCTION}`,
				false,
				{ operationId: operation.operationId, reason },
				new Date().toISOString(),
			);
			return {
				type: "continue",
				messages: [controlMessage],
				update: {
					context: {
						...turn.context,
						tools: this.agent.state.tools.filter((tool) =>
							SAVE_STATE_TOOL_NAMES.some((name) => name === tool.name),
						),
					},
					maxTokens: Math.min(remainingOutput, this.agent.state.model.maxTokens),
				},
			};
		}

		const recovering = this._recoveringRollover();
		if (recovering) {
			this._restoreRecoveryProgress(recovering);
			if (!validateCommittedRecovery(this.sessionManager, recovering)) {
				return { type: "failed", message: "recovery_reference_invalid" };
			}
			const recovery = currentContextRecoveryReferences(this.sessionManager, recovering.recovery);
			if (!this._canRecoverContext(recovery)) return { type: "failed", message: "recovery_unavailable" };
			const coverage = contextRecoveryCoverage(
				this.sessionManager,
				this._lastProviderRequest?.messages ?? [],
				recovery,
			);
			if (coverage.coveredUnits > 0 && !this._recoveryProgressFingerprints.has(coverage.progressFingerprint)) {
				this._recoveryNoProgressCount = 0;
				this._recoveryProgressFingerprints.add(coverage.progressFingerprint);
			} else {
				this._recoveryNoProgressCount++;
			}
			if (coverage.complete) {
				this._appendTraceSafely({
					type: "context/recovery",
					data: {
						turn: Math.max(0, this._nextTraceTurn - 1),
						rolloverId: recovering.rolloverId,
						phase: "complete",
						coveredUnits: coverage.coveredUnits,
						missingCount: 0,
						progressFingerprint: coverage.progressFingerprint,
						pages: coverage.pages,
					},
				});
				const message = createCustomMessage(
					"context-recovery-complete",
					"Required continuation sources are present in the preceding provider request. Continue the current task from next_action/current.",
					false,
					{ rolloverId: recovering.rolloverId, coverage: coverage.progressFingerprint },
					new Date().toISOString(),
				);
				return {
					type: "continue",
					messages: [message],
					update: {
						context: { ...turn.context, tools: this.agent.state.tools.slice() },
						maxTokens: this.agent.state.model.maxTokens,
					},
				};
			}
			if (this._recoveryNoProgressCount >= 3) {
				this._appendTraceSafely({
					type: "context/recovery",
					data: {
						turn: Math.max(0, this._nextTraceTurn - 1),
						rolloverId: recovering.rolloverId,
						phase: "failed",
						coveredUnits: coverage.coveredUnits,
						missingCount: coverage.missing.length,
						progressFingerprint: coverage.progressFingerprint,
						pages: coverage.pages,
						reasonCode: "recovery_no_progress",
					},
				});
				return { type: "failed", message: "recovery_no_progress" };
			}
			this._appendTraceSafely({
				type: "context/recovery",
				data: {
					turn: Math.max(0, this._nextTraceTurn - 1),
					rolloverId: recovering.rolloverId,
					phase: "reading",
					coveredUnits: coverage.coveredUnits,
					missingCount: coverage.missing.length,
					progressFingerprint: coverage.progressFingerprint,
					pages: coverage.pages,
				},
			});
			return {
				type: "continue",
				messages: [
					createCustomMessage(
						"context-recovery-required",
						`Recovery is incomplete in the preceding provider request: ${coverage.missing.slice(0, 8).join(", ")}. The latest tool results may already contain these bodies; use those results instead of reading them again. Read only bodies still absent from the visible results. Once all required bodies are visible, acknowledge recovery without more reads; business tools will then be enabled. Use verify=true only when previously read content is absent from the current request.`,
						false,
						{ rolloverId: recovering.rolloverId, missing: coverage.missing },
						new Date().toISOString(),
					),
				],
				update: {
					context: {
						...turn.context,
						tools: this.agent.state.tools.filter((tool) =>
							RECOVERY_TOOL_NAMES.some((name) => name === tool.name),
						),
					},
					maxTokens: Math.min(RECOVERY_OUTPUT_TOKENS, this.agent.state.model.maxTokens),
				},
			};
		}

		if (this._pendingContextTransition()) {
			const gate = this.getContextTransitionGate();
			if (gate.status === "invalid") return { type: "failed", message: gate.reason };
			const started = this._startSaveState(
				this._latestRequest?.requestFingerprint ?? fingerprintContextRolloverValue(this.agent.state.messages),
				"model_requested",
			);
			if (started.type === "failed") return started;
			return {
				type: "continue",
				messages: [started.message],
				update: {
					context: {
						...turn.context,
						tools: this.agent.state.tools.filter((tool) => started.toolNames.includes(tool.name)),
					},
					maxTokens: started.maxTokens,
				},
			};
		}
		return undefined;
	}

	/**
	 * Inspect the final request budget and enter the persisted save/recovery state machine.
	 */
	private _installContextGuard(): void {
		this.agent.getContextBudgetOptions = () => ({});
		this.agent.controlRequest = (budget, requestFingerprint, requestContext) => {
			const { windowId } = this.sessionManager.ensureContextWindow();
			const coordinates = this.sessionManager.getLatestContextCoordinates();
			this._latestRequest = { budget, requestFingerprint };
			const recovering = this._recoveringRollover();
			if (recovering) {
				if (!validateCommittedRecovery(this.sessionManager, recovering))
					return { type: "failed", message: "recovery_reference_invalid" };
				const recovery = currentContextRecoveryReferences(this.sessionManager, recovering.recovery);
				const recoveryRemaining = contextRemaining(
					budget,
					{
						windowId,
						measuredAtEntryId: this.sessionManager.getLeafId(),
						requestConfigRevision: this._requestConfigFingerprint(),
					},
					this.settingsManager.getContextWorkThresholdPercent(),
					"recovering",
				);
				const remainingControlTokens = recoveryRemaining.remainingControlTokens ?? 0;
				this._controlReadTokens = remainingControlTokens;
				this._contextRemaining = recoveryRemaining;
				if (!this._canRecoverContext(recovery)) return { type: "failed", message: "recovery_unavailable" };
				if (budget.decision === "context_limit" || remainingControlTokens === 0)
					return { type: "failed", message: "recovery_workset_too_large" };
				return undefined;
			}

			const saveOperation = getSaveStateOperation(this.sessionManager, windowId, coordinates.promptGeneration);
			if (saveOperation) {
				const usage = this._saveStateUsage(saveOperation.businessCutoffEntryId);
				if (saveOperation.finished) {
					const validation = validateContinuationState(this.sessionManager, saveOperation);
					if (validation.status === "valid" && this._pendingContextTransition())
						return { type: "context_transition" };
					if (validation.status === "valid") return { type: "failed", message: "model_request_missing" };
					const remainingControlTokens = Math.max(0, saveOperation.controlBudgetTokens - usage.controlTokens);
					const remainingOutputTokens = Math.max(0, saveOperation.outputBudgetTokens - usage.outputTokens);
					if (
						usage.samplesUsed >= SAVE_STATE_MAX_SAMPLES ||
						remainingControlTokens === 0 ||
						remainingOutputTokens === 0
					)
						return { type: "failed", message: validation.reason };
					this.sessionManager.appendContextOperation({
						operationId: saveOperation.operationId,
						operationKind: "save_state",
						transitionCause: saveOperation.transitionCause,
						state: "started",
						windowId: saveOperation.windowId,
						promptGeneration: saveOperation.promptGeneration,
						contextEpoch: saveOperation.contextEpoch,
						sourceFingerprint: saveOperation.sourceFingerprint,
						businessCutoffEntryId: saveOperation.businessCutoffEntryId,
						startTaskNoteRevision: saveOperation.startTaskNoteRevision,
						controlBudgetTokens: saveOperation.controlBudgetTokens,
						outputBudgetTokens: saveOperation.outputBudgetTokens,
						samplesUsed: usage.samplesUsed,
						consumedControlTokens: usage.controlTokens,
						consumedOutputTokens: usage.outputTokens,
						outcome: validation.reason,
					});
					this._controlReadTokens = remainingControlTokens;
					return {
						type: "save_state",
						message: createCustomMessage(
							"context-save-state-correction",
							`The saved continuation became invalid (${validation.reason}) after a new delivered fact. Reconfirm next_action/current in the same save operation. ${SAVE_STATE_SUPERSESSION_INSTRUCTION} ${SAVE_STATE_CONTENT_INSTRUCTION}`,
							false,
							{ operationId: saveOperation.operationId, reason: validation.reason },
							new Date().toISOString(),
						),
						toolNames: SAVE_STATE_TOOL_NAMES,
						maxTokens: Math.min(remainingOutputTokens, this.agent.state.model.maxTokens),
						failureMessage: validation.reason,
					};
				}
				const remainingControlTokens = Math.max(0, saveOperation.controlBudgetTokens - usage.controlTokens);
				this._controlReadTokens = remainingControlTokens;
				this._contextRemaining = contextRemaining(
					budget,
					{
						windowId,
						measuredAtEntryId: this.sessionManager.getLeafId(),
						requestConfigRevision: this._requestConfigFingerprint(),
					},
					this.settingsManager.getContextWorkThresholdPercent(),
					this._pendingContextTransition() ? "save_state" : "decision",
					remainingControlTokens,
				);
				if (budget.decision === "context_limit") return { type: "failed", message: "save_state_budget_exhausted" };
				return undefined;
			}

			this._contextRemaining = contextRemaining(
				budget,
				{
					windowId,
					measuredAtEntryId: this.sessionManager.getLeafId(),
					requestConfigRevision: this._requestConfigFingerprint(),
				},
				this.settingsManager.getContextWorkThresholdPercent(),
			);
			if (this._completedRecoveryAwaitingBusinessRequest()) {
				if (this._contextRemaining.phase !== "normal")
					return { type: "failed", message: "recovery_workset_too_large" };
				const rollover = [...this.sessionManager.getBranch()]
					.reverse()
					.find((entry) => entry.type === "context_rollover");
				if (rollover?.type !== "context_rollover" || !validateCommittedRecovery(this.sessionManager, rollover))
					return { type: "failed", message: "recovery_reference_invalid" };
				const recovery = currentContextRecoveryReferences(this.sessionManager, rollover.recovery);
				if (!contextRecoveryCoverage(this.sessionManager, requestContext.messages, recovery).complete)
					return { type: "failed", message: "recovery_request_incomplete" };
			}
			if (!this.autoCompactionEnabled || this._contextRemaining.phase === "normal") return undefined;
			return { type: "context_maintenance" };
		};
		this.agent.afterTurnControl = async (turn) => await this._afterContextControlTurn(turn);
	}

	private _pendingContextTransition() {
		const windowId = this.sessionManager.ensureContextWindow().windowId;
		const promptGeneration = this.sessionManager.getLatestContextCoordinates().promptGeneration;
		return this.sessionManager
			.getBranch()
			.reverse()
			.find(
				(entry): entry is Extract<SessionEntry, { type: "context_transition_request" }> =>
					entry.type === "context_transition_request" &&
					entry.windowId === windowId &&
					entry.promptGeneration === promptGeneration,
			);
	}

	private async _measureRequest(messages = this.agent.state.messages, signal?: AbortSignal) {
		const state = this.agent.state;
		return await prepareAgentRequest(
			{ systemPrompt: state.systemPrompt, tools: state.tools, messages },
			{
				model: state.model,
				reasoning: state.thinkingLevel === "off" ? undefined : state.thinkingLevel,
				convertToLlm: this.agent.convertToLlm,
				projectUsageContext: this.agent.projectUsageContext,
				transformContext: this.agent.transformContext,
				appendOnlyContext: this.agent.appendOnlyContext,
				getContextBudgetOptions: this.agent.getContextBudgetOptions,
				prepareRequest: this.agent.prepareRequest,
			},
			signal,
			{ mode: "measure" },
		);
	}

	private _validateCompactionCommit(
		summary: string,
		firstKeptEntryId: string,
		sourceFingerprint: string,
	): "valid" | "invalid" | "superseded" {
		const branch = this.sessionManager.getBranch();
		const keptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
		const firstMessage = branch.slice(keptIndex).find((entry) => entry.type === "message");
		if (fingerprintContextRolloverValue(branch) !== sourceFingerprint) return "superseded";
		if (
			!summary.trim() ||
			keptIndex < 0 ||
			(firstMessage?.type === "message" && firstMessage.message.role === "toolResult")
		)
			return "invalid";
		return "valid";
	}
	/**
	 * Mechanical context reduction: replace the heaviest regions still in context with placeholders.
	 *
	 * Costs no model call. Returns estimated tokens freed; 0 means no region was eligible.
	 * The final request budget still decides whether the current window can continue.
	 *
	 * Redactions are persisted as a {@link ShakeEntry} and replayed on every context build, so the
	 * reduction survives a reload — unlike an in-place edit of an append-only log.
	 */
	private _commitShake(config: ShakeConfig, reason: ShakeReason): { tokensSaved: number; warnings: string[] } {
		const resolved = resolveShakeConfig(config, (warning) => console.warn(warning));
		const entries = this.sessionManager.buildContextEntries();
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const regions = collectShakeRegions(
			entries,
			{
				...resolved,
				protectedTools: [...resolved.protectedTools, ...CONTEXT_CONTROL_TOOLS],
				keepBoundaryId: compactionEntry?.firstKeptEntryId,
			},
			collectShakenIndex(this.sessionManager.getBranch()),
			estimateTokens,
		).filter((region) => {
			const entry = entries.find((candidate) => candidate.id === region.entryId);
			return entry?.type === "message" && entry.message.role !== "user";
		});
		if (regions.length === 0) return { tokensSaved: 0, warnings: [] };

		const historyAvailable =
			this.getActiveToolNames().includes("history") &&
			decideToolPermission({
				mode: this._planModeState.status !== "off" ? "plan" : this.settingsManager.getPermissionMode(),
				allow: this.settingsManager.getPermissionAllowRules(),
				deny: this.settingsManager.getPermissionDenyRules(),
				cwd: this._cwd,
				toolName: "history",
				args: {},
			}).decision === "allow";
		const redactions = buildRedactions(entries, regions, historyAvailable);
		if (redactions.length === 0) return { tokensSaved: 0, warnings: [] };

		const tokensSaved = estimateShakeSavings(regions);
		this.sessionManager.appendShake(redactions, tokensSaved, reason);
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		const warnings: string[] = [];
		try {
			this._emit({ type: "shake", reason, tokensSaved, regionCount: regions.length });
		} catch {
			warnings.push("ui_notification_failed");
		}
		return { tokensSaved, warnings };
	}

	async shake(config: ShakeConfig, reason: ShakeReason): Promise<number> {
		return this._commitShake(config, reason).tokensSaved;
	}

	private _installAgentNextTurnRefresh(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			let transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			if (transformed.some((message) => message.role === "compactionSummary")) {
				const branch = this.sessionManager.getBranch();
				const scope = resolveTaskNoteScope(
					branch,
					this.sessionManager.getLatestContextCoordinates().promptGeneration,
				);
				const notes = scope
					? buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch))
					: undefined;
				transformed = [
					createCustomMessage(
						"context-compaction-state",
						`Current authoritative task state; summary text does not override requirements or Todo status.\n${JSON.stringify(
							{
								notes: notes?.status === "valid" ? notes.snapshot : null,
								todos: this._todoStateStore
									.toJSON()
									.filter((todo) => todo.status === "pending" || todo.status === "in_progress"),
							},
						)}`,
						false,
						undefined,
						"1970-01-01T00:00:00.000Z",
					),
					...transformed,
				];
			}
			if (transformed.some((message) => message.role === "custom" && message.customType === "context-window"))
				return transformed;
			const { windowId } = this.sessionManager.ensureContextWindow();
			return [
				createCustomMessage(
					"context-window",
					formatContextWindow(windowId),
					false,
					undefined,
					"1970-01-01T00:00:00.000Z",
				),
				...transformed,
			];
		};

		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	getExecutionUpgradeState() {
		const config = this._executionUpgradeOverride ?? this.settingsManager.getExecutionUpgradeSettings();
		return {
			enabled: config.enabled,
			current: {
				targetModel: `${this.agent.state.model.provider}/${this.agent.state.model.id}`,
				thinkingLevel: this.thinkingLevel,
			},
			metrics: this._executionMonitor.snapshot(),
			options: executionUpgradeOptions(
				this.agent.state.model,
				this.thinkingLevel,
				config,
				this._modelRuntime.getAvailableSnapshot(),
			),
			lastUpgrade: this._lastExecutionUpgrade,
		};
	}

	private _executionControlRequest(): boolean {
		const identity = this.sessionManager.ensureContextWindow();
		const coordinates = this.sessionManager.getLatestContextCoordinates();
		const saving = getSaveStateOperation(this.sessionManager, identity.windowId, coordinates.promptGeneration);
		return Boolean(this._recoveringRollover() || saving);
	}

	private _recordExecutionUpgrade(outcome: ExecutionUpgradeOutcome): void {
		this._lastExecutionUpgrade = outcome;
		if (outcome.status !== "applied") this.sessionManager.appendCustomEntry("execution-upgrade", outcome);
		this._appendTraceSafely({
			type: "execution/upgrade",
			data: {
				turn: this._traceTurn ?? Math.max(0, this._nextTraceTurn - 1),
				step: this._traceStep,
				sessionId: this.sessionId,
				promptGeneration: this.sessionManager.getLatestContextCoordinates().promptGeneration,
				outcome,
			},
		});
		this._emit({ type: "execution_upgrade", outcome });
		if (outcome.status !== "pending")
			this._extensionUIContext?.notify(
				`Execution upgrade ${outcome.status}: ${outcome.requested.targetModel} / ${outcome.requested.thinkingLevel}. ${outcome.message}`,
				"info",
			);
	}

	private _cancelExecutionUpgrade(message: string): void {
		const pending = this._pendingExecutionUpgrade;
		if (!pending) return;
		this._pendingExecutionUpgrade = undefined;
		this._recordExecutionUpgrade({ ...pending.outcome, status: "cancelled", message });
	}

	private _collectExecutionUpgrade(event: Extract<AgentEvent, { type: "turn_end" }>): void {
		const requests = event.toolResults.flatMap((result) => {
			const staged = this._executionToolRequests.get(result.toolCallId);
			this._executionToolRequests.delete(result.toolCallId);
			return staged && !result.isError ? [{ ...staged, callId: result.toolCallId }] : [];
		});
		if (requests.length === 0) return;
		const first = requests[0];
		const from: ExecutionProfile = {
			targetModel: `${this.agent.state.model.provider}/${this.agent.state.model.id}`,
			thinkingLevel: this.thinkingLevel,
		};
		const conflicting = requests.some(
			({ request }) =>
				request.targetModel !== first.request.targetModel || request.thinkingLevel !== first.request.thinkingLevel,
		);
		if (conflicting) {
			for (const request of requests)
				this._recordExecutionUpgrade({
					callIds: [request.callId],
					status: "rejected",
					from,
					requested: request.request,
					message: "Conflicting targets in the same tool batch. Choose one target in a new call.",
				});
			return;
		}
		this._cancelExecutionUpgrade("Replaced by a later explicit upgrade request.");
		const outcome: ExecutionUpgradeOutcome = {
			callIds: requests.map(({ callId }) => callId),
			status: "pending",
			from,
			requested: first.request,
			message: "Waiting for validation of the next ordinary request.",
		};
		this._pendingExecutionUpgrade = { outcome, revision: first.revision };
		this._recordExecutionUpgrade(outcome);
		if (requests.some(({ revision }) => revision !== this._selectionRevision))
			this._cancelExecutionUpgrade("User selection changed after the requesting model started.");
	}

	private _installExecutionUpgrade(): void {
		const restoredEntry = this.sessionManager
			.getBranch()
			.reverse()
			.find(
				(entry) =>
					(entry.type === "custom" && entry.customType === "execution-upgrade") ||
					(entry.type === "model_change" && entry.executionUpgrade !== undefined),
			);
		const restored =
			restoredEntry?.type === "model_change"
				? restoredEntry.executionUpgrade
				: restoredEntry?.type === "custom"
					? (restoredEntry.data as ExecutionUpgradeOutcome)
					: undefined;
		if (restored) {
			this._lastExecutionUpgrade = restored;
			if (restored.status === "pending")
				this._recordExecutionUpgrade({
					...restored,
					status: "cancelled",
					message: "Session interrupted before upgrade commit; request was not replayed.",
				});
		}
		const previousPrepare = this.agent.prepareRequest;
		this.agent.prepareRequest = async (context, prepare, signal, mode) => {
			if (mode !== "measure") this._preparedExecutionRevision = this._selectionRevision;
			const previousRequest = await previousPrepare?.(context, prepare, signal, mode);
			context = previousRequest?.context ?? context;
			if (mode !== "measure" && this._executionControlRequest()) return previousRequest;
			const config = this._executionUpgradeOverride ?? this.settingsManager.getExecutionUpgradeSettings();
			const active = config.enabled && context.tools?.some((tool) => tool.name === "upgrade_execution");
			if (!active) {
				if (mode !== "measure")
					this._cancelExecutionUpgrade("Execution upgrades are disabled or the tool is unavailable.");
				return previousRequest;
			}
			if (mode !== "measure") this._executionMonitor.observeTodos(this._todoStateStore.toJSON());
			const state = this.getExecutionUpgradeState();
			const reminder = state.options.length > 0 && this._executionMonitor.reminderDue(config);
			const makeContext = (
				current: ExecutionProfile,
				outcome?: ExecutionUpgradeOutcome,
				model = this.agent.state.model,
			): Context => ({
				...context,
				messages: [
					...context.messages,
					{
						role: "user",
						content: [
							"Execution status (runtime observations; you decide whether to call upgrade_execution):",
							JSON.stringify({
								current,
								metrics: state.metrics,
								lastUpgrade: outcome ?? this._lastExecutionUpgrade,
								availableUpgrades: executionUpgradeOptions(
									model,
									current.thinkingLevel,
									config,
									this._modelRuntime.getAvailableSnapshot(),
								),
							}),
							"Todo completions are agent-reported. No todos means no structured progress record. Tool success and tool counts do not prove progress or inability.",
							...(reminder
								? [
										"Review whether your current approach is making progress. You may change approach, continue, or request stronger execution if useful. The runtime has not concluded that an upgrade is necessary.",
									]
								: []),
						].join("\n"),
						timestamp: 0,
					},
				],
			});
			if (mode === "measure") return await prepare({ context: makeContext(state.current) });
			const pending = this._pendingExecutionUpgrade;
			let prepared: PreparedAgentRequest | undefined;
			let appliedUpgrade: { model: Model<string>; outcome: ExecutionUpgradeOutcome } | undefined;
			if (pending) {
				const { requested } = pending.outcome;
				try {
					if (pending.revision !== this._selectionRevision) throw new Error("User selection changed.");
					const option = state.options.find((item) => item.targetModel === requested.targetModel);
					if (!option?.thinkingLevels.includes(requested.thinkingLevel))
						throw new Error("Target is not an allowed upgrade with a supported thinking level.");
					const available = await this._modelRuntime.getAvailable();
					const model = available.find((item) => `${item.provider}/${item.id}` === requested.targetModel);
					if (!model) throw new Error("Target model is unavailable.");
					if (!(await this._modelRuntime.checkAuth(model.provider)))
						throw new Error("Target provider has no configured authentication.");
					const applied: ExecutionUpgradeOutcome = {
						...pending.outcome,
						status: "applied",
						message: "Selected for this request after validation.",
					};
					const candidate = await prepare({
						model,
						thinkingLevel: requested.thinkingLevel,
						context: makeContext(requested, applied, model),
					});
					if (candidate.budget.decision === "context_limit")
						throw new Error("The complete next request does not fit the target context window.");
					if (
						this.autoCompactionEnabled &&
						contextRemaining(
							candidate.budget,
							{
								windowId: this.sessionManager.ensureContextWindow().windowId,
								measuredAtEntryId: this.sessionManager.getLeafId(),
								requestConfigRevision: candidate.requestFingerprint,
							},
							this.settingsManager.getContextWorkThresholdPercent(),
						).phase !== "normal"
					)
						throw new Error("The target has insufficient working context for this request.");
					if (
						!model.input.includes("image") &&
						candidate.context.messages.some(
							(message) =>
								Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
						)
					)
						throw new Error("Target does not support images in the next request.");
					signal?.throwIfAborted();
					if (
						this._promptAborted ||
						this._selectionRevision !== pending.revision ||
						this._pendingExecutionUpgrade !== pending ||
						JSON.stringify(config) !==
							JSON.stringify(
								this._executionUpgradeOverride ?? this.settingsManager.getExecutionUpgradeSettings(),
							) ||
						!this.getActiveToolNames().includes("upgrade_execution")
					)
						throw new Error("Upgrade cancelled by a user selection or cancellation.");
					appliedUpgrade = {
						model,
						outcome: {
							...applied,
							requestFingerprint: candidate.requestFingerprint,
							effectiveThinkingLevel: candidate.reasoning ?? "off",
						},
					};
					prepared = candidate;
				} catch (error) {
					if (this._pendingExecutionUpgrade === pending) {
						this._pendingExecutionUpgrade = undefined;
						this._recordExecutionUpgrade({
							...pending.outcome,
							status:
								signal?.aborted || this._promptAborted || pending.revision !== this._selectionRevision
									? "cancelled"
									: "rejected",
							message: error instanceof Error ? error.message : String(error),
						});
					}
					signal?.throwIfAborted();
				}
			}
			if (appliedUpgrade) {
				const { model, outcome } = appliedUpgrade;
				const previousModel = this.agent.state.model;
				const previousLevel = this.thinkingLevel;
				// A single durable record commits the entire profile and its terminal status.
				this.sessionManager.appendModelChange(model.provider, model.id, outcome);
				this.agent.state.model = model;
				this.agent.state.thinkingLevel = outcome.requested.thinkingLevel;
				this._pendingExecutionUpgrade = undefined;
				this._executionMonitor.resetObservation();
				this._recordExecutionUpgrade(outcome);
				this._emit({ type: "thinking_level_changed", level: outcome.requested.thinkingLevel });
				void this._emitModelSelect(model, previousModel, "upgrade");
				if (previousLevel !== outcome.requested.thinkingLevel)
					void this._extensionRunner.emit({
						type: "thinking_level_select",
						level: outcome.requested.thinkingLevel,
						previousLevel,
					});
			}
			if (!prepared) this._preparedExecutionRevision = this._selectionRevision;
			const unchangedModel = previousRequest?.model ?? this.agent.state.model;
			const unchangedThinking = previousRequest ? (previousRequest.reasoning ?? "off") : this.thinkingLevel;
			prepared ??= await prepare({
				model: unchangedModel,
				thinkingLevel: unchangedThinking,
				context: makeContext(
					{ targetModel: `${unchangedModel.provider}/${unchangedModel.id}`, thinkingLevel: unchangedThinking },
					undefined,
					unchangedModel,
				),
			});
			this._appendTraceSafely({
				type: "execution/status",
				data: {
					turn: this._traceTurn ?? Math.max(0, this._nextTraceTurn - 1),
					step: this._traceStep,
					sessionId: this.sessionId,
					promptGeneration: this.sessionManager.getLatestContextCoordinates().promptGeneration,
					metrics: state.metrics,
					reminder,
				},
			});
			if (reminder) this._executionMonitor.resetObservation();
			return prepared;
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		const snapshot = this._pendingDeliveryStore.snapshot();
		this._emit({
			type: "queue_update",
			steering: snapshot.items
				.filter((item) => item.channel === "steering")
				.map((item) => messageText(item.message)),
			followUp: snapshot.items
				.filter((item) => item.channel === "follow_up")
				.map((item) => messageText(item.message)),
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		if (
			this._deferredContextTransition &&
			!this._promptAborted &&
			this.getContextTransitionGate().status !== "busy"
		) {
			await this._resumePreparedContextRollover();
			return;
		}
		try {
			const state = this.agent.state.runState;
			if (state.status === "idle" && state.lastOutcome?.type === "context_limit") {
				this._extensionUIContext?.notify(
					"context_limit: no valid continuation fits and the task is not complete; reduce context or switch to a model with a larger context window.",
					"error",
				);
			}
			if (this.contextRolloverState.dispatchState === "outcome_unknown") {
				this._extensionUIContext?.notify(
					"Context rollover stopped: Provider or tool outcome is unknown. Nothing was replayed automatically; inspect external state before sending a new prompt.",
					"error",
				);
			}
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._settleCurrentMemoryRun();
			this._resolveIdleWaitIfIdle();
			this._scheduleDeferredContextTransition();
		}
	}

	private _scheduleDeferredContextTransition(): void {
		queueMicrotask(() => {
			if (
				!this._deferredContextTransition ||
				this._isAgentRunActive ||
				this._promptAborted ||
				this.getContextTransitionGate().status === "busy"
			)
				return;
			void this._resumePreparedContextRollover().catch((error: unknown) => {
				this._extensionUIContext?.notify(error instanceof Error ? error.message : String(error), "error");
			});
		});
	}

	/**
	 * Grok-aligned TodoGate: forces a follow-up continuation while pending todos remain, bounded per
	 * prompt (see reminder-policy.ts). Disabled by default. Returns true when a follow-up was queued so
	 * the caller (the _runAgentPrompt continuation loop) knows to keep running instead of settling.
	 */
	private _maybeTriggerTodoGate(): boolean {
		const reminderPolicy = this.settingsManager.getReminderPolicy();
		if (!reminderPolicy.enabled || !this.getActiveToolNames().includes("todo_write")) return false;
		const shouldFire = shouldFireTodoGate(reminderPolicy.todoGate, {
			firesForCurrentPrompt: this._todoGateFireCount,
			hasPendingWork: this._todoStateStore.hasPendingWork(),
			cancelled: false,
		});
		if (!shouldFire) return false;
		this._todoGateFireCount++;
		void this._queueFollowUp(todoGateReminderText(), undefined, "runtime");
		return true;
	}

	/** PlanModeController: switches PermissionMode to "plan" and narrows the active tool set to read-only tools. */
	enterPlanMode(): { alreadyPlanning: boolean } {
		if (this._planModeState.status !== "off") {
			return { alreadyPlanning: true };
		}
		const previousActiveToolNames = this.getActiveToolNames();
		this._planModeState = { status: "planning", previousActiveToolNames };
		this._persistPlanModeState();
		const readOnly = PLAN_MODE_READ_ONLY_TOOLS.filter((name) => this._toolRegistry.has(name));
		this.setActiveToolsByName([...new Set([...readOnly, "enter_plan_mode", "exit_plan_mode"])]);
		return { alreadyPlanning: false };
	}

	/** PlanModeController: requires approval (via PendingInteractionRegistry) before restoring the previous tool set. Fails closed. */
	async requestExitPlanMode(plan: PlanArtifact): Promise<{ approved: boolean; reason?: string }> {
		if (this._planModeState.status === "off") {
			return { approved: false, reason: "not currently in plan mode" };
		}
		const previousActiveToolNames = this._planModeState.previousActiveToolNames ?? [];
		this._planModeState = { ...this._planModeState, status: "awaiting_approval", plan };
		this._persistPlanModeState();
		const toolCallId = `plan-approval-${plan.id}`;
		const resolution = await this._pendingInteractions.create<{ approved: boolean; reason?: string }>(
			toolCallId,
			"plan_approval",
			{ payload: plan, timeoutMs: this.settingsManager.getPlanModeApprovalTimeoutMs() },
		);
		if (resolution.outcome !== "resolved" || !resolution.value.approved) {
			this._planModeState = { status: "planning", plan, previousActiveToolNames };
			this._persistPlanModeState();
			return {
				approved: false,
				reason: resolution.outcome === "resolved" ? resolution.value.reason : resolution.outcome,
			};
		}
		this._planModeState = OFF_PLAN_MODE_STATE;
		this._persistPlanModeState();
		this.setActiveToolsByName(previousActiveToolNames);
		return { approved: true };
	}

	/** Resolves a pending plan-exit (or other) approval — call from a TUI/RPC driver once the user decides. */
	resolvePendingInteraction<T>(toolCallId: string, value: T): boolean {
		const resolved = this._pendingInteractions.resolve(toolCallId, value);
		this._scheduleDeferredContextTransition();
		return resolved;
	}

	getPlanModeState(): PlanModeState {
		return this._planModeState;
	}

	/**
	 * Persists the current PlanModeState into a session custom entry (spec 7: "plan mode 状态写入 session
	 * custom entry"), so it survives session resume/reload — see the constructor's restore step, which
	 * scans for this via getLatestCustomEntryData(). Best-effort: an in-memory-only SessionManager (e.g.
	 * a subagent's) still accepts the call, it just never reaches disk.
	 */
	private _persistPlanModeState(): void {
		this.sessionManager.appendCustomEntry("plan-mode-state", this._planModeState);
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _recordTraceEvent(event: AgentEvent): void {
		if (event.type === "agent_start") {
			if (this._traceTurn !== undefined) {
				throw new Error(`Trace turn ${this._traceTurn} is already open`);
			}
			this._traceTurn = this._nextTraceTurn++;
			this._traceStep = -1;
			this._appendTraceSafely({ type: "turn/start", data: { turn: this._traceTurn } });
			return;
		}

		const turn = this._traceTurn;
		if (turn === undefined) {
			throw new Error(`Agent event ${event.type} arrived without an open trace turn`);
		}

		let traceEvent: SessionTraceEvent | undefined;
		if (event.type === "agent_end") {
			let finalAssistant: AssistantMessage | undefined;
			for (let i = event.messages.length - 1; i >= 0; i--) {
				if (event.messages[i].role === "assistant") {
					finalAssistant = event.messages[i] as AssistantMessage;
					break;
				}
			}
			traceEvent = {
				type: "turn/end",
				data: {
					turn,
					...(finalAssistant === undefined ? {} : { stopReason: finalAssistant.stopReason }),
					...(finalAssistant?.errorMessage === undefined ? {} : { errorMessage: finalAssistant.errorMessage }),
					willRetry: this._willRetryAfterAgentEnd(event),
					outcome: event.outcome,
				},
			};
		} else if (event.type === "context_budget") {
			const identity = this.sessionManager.ensureContextWindow();
			const coordinates = this.sessionManager.getLatestContextCoordinates();
			const saving = getSaveStateOperation(this.sessionManager, identity.windowId, coordinates.promptGeneration);
			const phase = this._recoveringRollover()
				? "recovering"
				: saving && !saving.finished
					? this._pendingContextTransition()
						? "save_state"
						: "decision"
					: "normal";
			this._contextRemaining = contextRemaining(
				event.budget,
				{
					windowId: identity.windowId,
					measuredAtEntryId: this.sessionManager.getLeafId(),
					requestConfigRevision: this._requestConfigFingerprint(),
				},
				this.settingsManager.getContextWorkThresholdPercent(),
				phase,
				phase === "normal" ? null : this._controlReadTokens,
			);
			traceEvent = { type: "context/budget", data: { turn, step: this._traceStep, budget: event.budget } };
		} else if (event.type === "turn_start") {
			this._traceStep++;
			traceEvent = { type: "step/start", data: { turn, step: this._traceStep } };
		} else if (event.type === "request_start") {
			traceEvent = {
				type: "request/header",
				data: { turn, step: this._traceStep, header: createTraceRequestHeader(event) },
			};
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			traceEvent = {
				type: "assistant/chunk",
				data: { turn, step: this._traceStep, chunk: { type: "start" } },
			};
		} else if (event.type === "message_update") {
			traceEvent = {
				type: "assistant/chunk",
				data: {
					turn,
					step: this._traceStep,
					chunk: createTraceAssistantChunk(event.assistantMessageEvent),
				},
			};
		} else if (event.type === "tool_execution_start") {
			traceEvent = {
				type: "tool/call",
				data: {
					turn,
					step: this._traceStep,
					callId: event.toolCallId,
					name: event.toolName,
				},
			};
		} else if (event.type === "tool_execution_end") {
			traceEvent = {
				type: "tool/result",
				data: {
					turn,
					step: this._traceStep,
					callId: event.toolCallId,
					name: event.toolName,
					isError: event.isError,
				},
			};
		} else if (event.type === "turn_end") {
			const assistant = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
			traceEvent = {
				type: "step/end",
				data: {
					turn,
					step: this._traceStep,
					...(assistant === undefined ? {} : { stopReason: assistant.stopReason, usage: assistant.usage }),
				},
			};
		}

		if (traceEvent) {
			this._appendTraceSafely(traceEvent);
		}
		if (event.type === "agent_end") {
			this._traceTurn = undefined;
			this._traceStep = -1;
		}
	}

	private _recordToolProgress(
		toolCallId: string,
		toolName: string,
		args: unknown,
		result: unknown,
		failed: boolean,
	): void {
		if (toolName === "context_note") return;
		const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
		const target = record.path ?? record.filePath ?? record.url ?? record.command;
		const workspacePath =
			(toolName === "read" || toolName === "write" || toolName === "edit") && typeof target === "string"
				? resolve(this._cwd, target)
				: undefined;
		const subjectId = workspacePath === undefined ? undefined : `workspace-file:${workspacePath}`;
		let workspaceFingerprint: string | undefined;
		if (workspacePath !== undefined) {
			try {
				workspaceFingerprint = fingerprintTaskNoteWorkspaceContent(readFileSync(workspacePath, "utf8"));
			} catch {
				workspaceFingerprint = fingerprintTaskNoteWorkspaceContent(undefined);
			}
		}
		const targetFingerprint = fingerprintContextRolloverValue({
			toolName: toolName === "read" || toolName === "write" || toolName === "edit" ? "workspace-file" : toolName,
			target: target ?? null,
		});
		const resultFingerprint = fingerprintContextRolloverValue(result);
		const latestEffect = [...this.sessionManager.getBranch()]
			.reverse()
			.find(
				(entry): entry is ContextProgressEntry =>
					entry.type === "context_progress" &&
					entry.evidenceKind === "non_read_effect" &&
					entry.outcome === "succeeded" &&
					(subjectId !== undefined
						? entry.subjectId === subjectId
						: entry.targetFingerprint === targetFingerprint),
			);
		if ((toolName === "read" || toolName === "bash" || failed) && latestEffect) {
			this.sessionManager.appendContextProgress({
				evidenceId: fingerprintContextRolloverValue({
					kind: "verification",
					toolCallId,
					effect: latestEffect.evidenceId,
				}),
				evidenceKind: "verification",
				targetFingerprint: latestEffect.targetFingerprint,
				subjectId: latestEffect.subjectId ?? latestEffect.targetFingerprint,
				inputFingerprint: workspaceFingerprint ?? latestEffect.resultFingerprint,
				resultFingerprint,
				outcome: failed ? "failed" : "succeeded",
				toolCallId,
			});
		}
		if (!failed && ["write", "edit", "bash"].includes(toolName)) {
			this.sessionManager.appendContextProgress({
				evidenceId: fingerprintContextRolloverValue({ kind: "effect", toolCallId }),
				evidenceKind: "non_read_effect",
				targetFingerprint,
				subjectId: subjectId ?? targetFingerprint,
				inputFingerprint: workspaceFingerprint ?? targetFingerprint,
				resultFingerprint: workspaceFingerprint ?? resultFingerprint,
				outcome: "succeeded",
				toolCallId,
			});
		}
	}

	private _boundPersistedToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const sourceEntryId = this.sessionManager.appendToolResultSource(
			message.toolCallId,
			message.toolName,
			message.content,
			message.details,
			message.isError,
		);
		if (this._memoryRootPromptId) {
			this._recordMemoryEvidence(this._memoryRootPromptId, {
				sourceId: `${this._memoryRootPromptId}:tool:${message.toolCallId}`,
				origin: "tool",
				content: JSON.stringify({
					toolName: message.toolName,
					content: message.content,
					details: message.details,
					isError: message.isError,
				}),
				visibility: "session",
				entryId: sourceEntryId,
				toolCallId: message.toolCallId,
			});
		}
		const batchSize = this._toolBatchSizeByCallId.get(message.toolCallId) ?? 1;
		const phaseTokens =
			this._contextRemaining?.phase === "normal"
				? this._contextRemaining.remainingWorkTokens
				: this._contextRemaining?.remainingControlTokens;
		const sharedBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(512, (phaseTokens ?? DEFAULT_MAX_BYTES / 4) * 4));
		const bounded = {
			...message,
			content: boundToolResultContent(message.content, {
				maxBytes: Math.max(256, Math.floor(sharedBytes / batchSize)),
				maxLines: Math.max(4, Math.floor(DEFAULT_MAX_LINES / batchSize)),
				sourceEntryId,
			}),
		};
		this._replaceMessageInPlace(message, bounded);
		this._toolBatchSizeByCallId.delete(message.toolCallId);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "agent_end" && !this._willRetryAfterAgentEnd(event))
			this._cancelExecutionUpgrade("Execution ended before an ordinary request could commit the upgrade.");
		this._recordTraceEvent(event);
		if (event.type === "request_start") {
			this._executionBusinessRequest = !this._executionControlRequest();
			this._executionRequestRevision = this._preparedExecutionRevision;
		}
		if (this._executionBusinessRequest) {
			this._executionMonitor.observe(event);
			if (event.type === "turn_end") this._collectExecutionUpgrade(event);
		}
		if (event.type === "request_start") {
			this._lastProviderRequest = event.context;
		} else if (event.type === "tool_execution_start") {
			this._toolEvidenceInputs.set(event.toolCallId, {
				toolName: event.toolName,
				args: structuredClone(event.args),
			});
		} else if (event.type === "tool_execution_end") {
			const input = this._toolEvidenceInputs.get(event.toolCallId);
			this._toolEvidenceInputs.delete(event.toolCallId);
			if (input) this._recordToolProgress(event.toolCallId, input.toolName, input.args, event.result, event.isError);
		}

		if (event.type === "queue_delivery") {
			for (const item of event.items) {
				if (this._memoryRootPromptId && (item.message.role === "user" || item.message.role === "custom")) {
					this._recordMemoryEvidence(this._memoryRootPromptId, {
						sourceId: `${this._memoryRootPromptId}:queue:${item.queueItemId}`,
						origin:
							item.message.role === "custom"
								? "extension"
								: (this._memoryQueueOrigins.get(item.queueItemId) ?? "user"),
						content: JSON.stringify(item.message.content),
						visibility: "session",
					});
				}
				this._memoryQueueOrigins.delete(item.queueItemId);
				if (
					this._rolloverDispatchPreparationId === undefined ||
					event.preparationId !== this._rolloverDispatchPreparationId
				) {
					this._pendingDeliveryStore.markDelivered(item.queueItemId, event.preparationId);
				}
				this._deliveredPendingMessages.add(item.message as object);
			}
			this._emitQueueUpdate();
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);
		if (event.type === "message_end" && event.message.role === "assistant") {
			const toolCalls = event.message.content.filter((block) => block.type === "toolCall");
			for (const toolCall of toolCalls) this._toolBatchSizeByCallId.set(toolCall.id, toolCalls.length);
			const contextReads = toolCalls.filter(
				(toolCall) =>
					toolCall.name === "history" ||
					(toolCall.name === "context_note" && toolCall.arguments.operation === "query"),
			);
			if (contextReads.length > 0 && this._contextRemaining?.phase !== "normal") {
				const share = Math.floor(this._controlReadTokens / contextReads.length);
				for (const toolCall of contextReads) this._controlReadBudgetByCallId.set(toolCall.id, share);
			}
		} else if (event.type === "message_end" && event.message.role === "toolResult") {
			this._boundPersistedToolResult(event.message);
		} else if (event.type === "turn_end" && event.message.role === "assistant") {
			for (const block of event.message.content) {
				if (block.type === "toolCall") this._controlReadBudgetByCallId.delete(block.id);
			}
		}

		// Notify all listeners
		if (event.type !== "request_start" && event.type !== "queue_delivery") {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			let persistedEntryId: string | undefined;
			const deliveredFromQueue = this._deliveredPendingMessages.has(event.message as object);
			if (deliveredFromQueue) this._deliveredPendingMessages.delete(event.message as object);
			// Check if this is a custom message from extensions
			if (deliveredFromQueue) {
				// The receipt projects the authoritative pending message into context.
			} else if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				persistedEntryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				persistedEntryId = this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere
			if (
				persistedEntryId &&
				event.message.role === "user" &&
				this._memoryRootPromptId &&
				this._memoryRootSourceId &&
				this._memoryRootSourceContent !== undefined
			) {
				this.sessionManager.appendMemoryEvidence({
					evidenceEventId: this._memoryRootSourceId,
					rootPromptId: this._memoryRootPromptId,
					origin: "user",
					content: this._memoryRootSourceContent,
					visibility: "session",
					deliveryState: "delivered",
					sourceEntryId: persistedEntryId,
				});
				this._memoryAuthority.bindEvidenceSourceEntry(
					this._memoryRootPromptId,
					this._memoryRootSourceId,
					persistedEntryId,
				);
				this._memoryRootSourceId = undefined;
				this._memoryRootSourceContent = undefined;
			}
			if (
				persistedEntryId &&
				this._memoryRootPromptId &&
				(event.message.role === "assistant" || event.message.role === "custom")
			) {
				this._recordMemoryEvidence(this._memoryRootPromptId, {
					sourceId: `${this._memoryRootPromptId}:message:${this._memoryEvidenceSequence++}`,
					origin: event.message.role === "assistant" ? "assistant" : "extension",
					content: JSON.stringify(event.message.content),
					visibility: "session",
					entryId: persistedEntryId,
				});
			}

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			const calledTodoWrite =
				event.message.role === "assistant" &&
				event.message.content.some((block) => block.type === "toolCall" && block.name === "todo_write");
			this._todoNudgeTracker.recordTurnEnd(calledTodoWrite);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		if (this.subagents) return this.subagents.close();
		return this._dispose();
	}

	private async _dispose(): Promise<void> {
		this._disposed = true;
		if (this._memoryArchiveRetryTimer) clearTimeout(this._memoryArchiveRetryTimer);
		this._memoryArchiveRetryTimer = undefined;
		this._memoryArchiveService?.cancelCurrent();
		const cleanups = [
			() => this.abortRetry(),
			() => this.abortCompaction(),
			() => this.abortBranchSummary(),
			() => this.abortBash(),
			async () => {
				this.agent.abort();
				if (this._subagentRunScope) await this.agent.waitForIdle();
			},
			() => this._lspManager.disposeAll(),
			() => this._mcpManager.disposeAll(),
			async () => {
				this._taskManager.cancelAll("session disposed");
				await Promise.all(
					this._taskManager
						.list()
						.filter((task) => task.status === "running" || task.status === "cancelling")
						.map((task) => this._taskManager.awaitSettled(task.taskId)),
				);
			},
		];
		const failures: unknown[] = [];
		for (const cleanup of cleanups) {
			try {
				await cleanup();
			} catch (error) {
				// Every resource is attempted even when an earlier cleanup fails.
				failures.push(error);
			}
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
		if (this._subagentRunScope && failures.length)
			throw new AggregateError(failures, "subagent_session_cleanup_failed");
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** One gate for commit, resume, deferred scheduling and headless lifecycle. */
	getContextTransitionGate(retainedRequiredIds: readonly string[] = []): ContextTransitionGate {
		if (
			this._pendingInteractions.list().length ||
			this._taskManager
				.list()
				.some(
					(task) => task.archiveRole !== "service" && (task.status === "running" || task.status === "cancelling"),
				)
		)
			return { status: "busy" };
		const branch = this.sessionManager.getBranch();
		const window = [...branch]
			.reverse()
			.find((entry) => entry.type === "context_window" || entry.type === "context_rollover");
		const windowIndex = window ? branch.indexOf(window) : -1;
		try {
			collectCompleteToolTransactions(branch.slice(windowIndex + 1));
		} catch {
			return { status: "busy" };
		}
		try {
			const scope = resolveTaskNoteScope(branch, this.sessionManager.getLatestContextCoordinates().promptGeneration);
			return {
				status: "ready",
				...captureSubagentHandoff(this.sessionManager, scope, retainedRequiredIds),
			};
		} catch {
			return { status: "invalid", reason: "subagent_handoff_invalid" };
		}
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			const definition = this._toolDefinitions.get(name)?.definition;
			if (
				definition &&
				this._subagentPermission &&
				!canUseSubagentTool(
					this._subagentPermission(),
					subagentToolPermission(definition, name, this._baseToolDefinitions.get(name) === definition),
				)
			)
				continue;
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compactionAbortController !== undefined || this._branchSummaryAbortController !== undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._subagentRunScope?.assertActive();
		this._isAgentRunActive = true;
		this._promptAborted = false;
		try {
			await this.agent.prompt(messages);
			while (true) {
				const action = await this._handlePostAgentRun();
				if (action !== "continue" && action !== "continue_save_state") break;
				this._subagentRunScope?.assertActive();
				await this.agent.continue(
					action === "continue_save_state"
						? {
								toolNames: SAVE_STATE_TOOL_NAMES,
								maxTokens: Math.min(STATE_SAVE_OUTPUT_TOKENS, this.agent.state.model.maxTokens),
							}
						: {},
				);
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	private async _maintainContext(overflow: boolean): Promise<PostRunAction> {
		const maintenance = new ContextMaintenance(this.sessionManager);
		if (this.agent.state.messages.at(-1)?.role === "assistant") {
			this._appendContextControlMessage(
				createCustomMessage(
					"context-maintenance-start",
					"The provider rejected the context size. Context maintenance is preparing a smaller request.",
					false,
					undefined,
					new Date().toISOString(),
				),
			);
		}
		while (!this._promptAborted) {
			const tokensBefore = this._latestRequest?.budget.tokens ?? Number.POSITIVE_INFINITY;
			const step = maintenance.next(this._requestConfigFingerprint());
			if (step.stage === "decision") {
				const started = this._startSaveState(
					this._latestRequest?.requestFingerprint ?? fingerprintContextRolloverValue(this.agent.state.messages),
					overflow ? "provider_context_rejected" : "work_budget_reached",
				);
				if (started.type === "failed") {
					this.agent.setIdleOutcome(started);
					return "stop";
				}
				maintenance.begin(step);
				this._appendContextControlMessage(started.message);
				return "continue_save_state";
			}
			maintenance.begin(step);
			if (step.stage === "shake") this._commitShake(DEFAULT_SHAKE_CONFIG, "threshold");
			else {
				try {
					await this._compactContext(overflow ? "overflow" : "threshold");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (
						this._promptAborted ||
						message === "Compaction cancelled" ||
						(error instanceof Error && error.name === "AbortError")
					) {
						this.agent.setIdleOutcome({ type: "aborted", message });
						return "stop";
					}
					if (message === "Compaction source changed" || message === "Invalid or stale compaction result")
						return "continue";
				}
			}
			if (this._promptAborted) break;
			const request = await this._measureRequest();
			this._latestRequest = request;
			this._contextRemaining = contextRemaining(
				request.budget,
				{
					windowId: this.sessionManager.ensureContextWindow().windowId,
					measuredAtEntryId: this.sessionManager.getLeafId(),
					requestConfigRevision: this._requestConfigFingerprint(),
				},
				this.settingsManager.getContextWorkThresholdPercent(),
			);
			if (this._contextRemaining.phase === "normal" && (!overflow || request.budget.tokens < tokensBefore))
				return "continue";
		}
		return "stop";
	}

	private async _handlePostAgentRun(): Promise<PostRunAction> {
		while (true) {
			const msg = this._lastAssistantMessage;
			this._lastAssistantMessage = undefined;
			if (this._promptAborted) return "stop";
			const state = this.agent.state.runState;
			const outcome =
				state.status === "idle" ? (state.lastOutcome?.type ?? this.contextRolloverState.outcome) : undefined;
			const requested = this._pendingContextTransition();
			const overflow =
				msg?.stopReason === "error" &&
				msg.content.every((block) => block.type !== "toolCall") &&
				isContextOverflow(msg, this.model?.contextWindow ?? 0);
			const currentWindow = this.sessionManager.ensureContextWindow();
			const coordinates = this.sessionManager.getLatestContextCoordinates();
			const activeSaveOperation = getSaveStateOperation(
				this.sessionManager,
				currentWindow.windowId,
				coordinates.promptGeneration,
			);
			if (outcome === "failed" && activeSaveOperation && !activeSaveOperation.finished) return "stop";
			if (
				!requested &&
				!activeSaveOperation &&
				this.autoCompactionEnabled &&
				(outcome === "context_maintenance" || outcome === "context_limit" || overflow)
			) {
				return await this._maintainContext(overflow === true);
			}
			if (requested) {
				const gate = this.getContextTransitionGate();
				if (gate.status === "invalid") {
					this._deferredContextTransition = false;
					this.agent.setIdleOutcome({ type: "failed", message: gate.reason });
					return "stop";
				}
				const saveOperation = activeSaveOperation;
				if (!saveOperation) {
					const started = this._startSaveState(
						this._latestRequest?.requestFingerprint ?? fingerprintContextRolloverValue(this.agent.state.messages),
						"model_requested",
					);
					if (started.type === "failed") {
						this._extensionUIContext?.notify(started.message, "error");
						return "stop";
					}
					this._appendContextControlMessage(started.message);
					return "continue_save_state";
				}
				if (!saveOperation.finished) return "continue_save_state";
				let request = this._latestRequest;
				if (!request || this.agent.state.messages.at(-1)?.role !== "assistant")
					request = await this._measureRequest();
				if (!request) return "stop";
				const { windowId } = currentWindow;
				const result = await this._contextRollover.run({
					cause: "model_requested",
					windowId,
					requestId: requested.requestId,
					budget: request.budget,
					requestFingerprint: request.requestFingerprint,
				});
				if (result.outcome !== "dispatched") {
					if (result.outcome === "blocked" && result.reason === "continuation_state_changed")
						return "continue_save_state";
					this._deferredContextTransition =
						result.outcome === "blocked" && result.reason === "operation_in_flight";
					if (result.outcome === "blocked") {
						if (result.reason !== "operation_in_flight") {
							this.agent.setIdleOutcome({ type: "failed", message: result.reason });
						}
						this._extensionUIContext?.notify(`Context rollover stopped: ${result.reason}`, "error");
					}
					return "stop";
				}
				continue;
			}
			if (msg && this._isRetryableError(msg) && (await this._prepareRetry(msg))) return "continue";
			if (msg?.stopReason === "error" && this._retryAttempt > 0) {
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt: this._retryAttempt,
					finalError: msg.errorMessage,
				});
				this._retryAttempt = 0;
			}
			if (outcome === "failed") return "stop";
			if (activeSaveOperation) return "wait";
			if (this.agent.hasQueuedMessages()) return "continue";
			return this._maybeTriggerTodoGate() ? "continue" : "wait";
		}
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (options?.source === "extension") this._subagentRunScope?.assertActive();
		if (this.subagents) return this.subagents.run(() => this._prompt(text, options));
		if (this._subagentRunScope) return this._subagentRunScope.track(() => this._prompt(text, options));
		return this._prompt(text, options);
	}

	private async _prompt(text: string, options?: PromptOptions): Promise<void> {
		this._todoGateFireCount = 0;
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;
		let startedMemoryRun = false;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(
						expandedText,
						currentImages,
						options?.source === "extension" ? "extension" : "user",
					);
				} else {
					await this._queueSteer(
						expandedText,
						currentImages,
						options?.source === "extension" ? "extension" : "user",
					);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}
			this._startMemoryRun(text, currentText, expandedText);
			startedMemoryRun = this._memoryArchiveService !== undefined;
			const rolloverState = this.sessionManager.getContextRolloverState();
			if (
				rolloverState.dispatchState === "outcome_unknown" &&
				rolloverState.dispatchId !== undefined &&
				rolloverState.rolloverId !== undefined
			) {
				const startedDispatch = [...this.sessionManager.getBranch()]
					.reverse()
					.find(
						(entry) =>
							entry.type === "context_rollover_dispatch" && entry.dispatchId === rolloverState.dispatchId,
					);
				this.sessionManager.appendContextRolloverDispatch({
					dispatchId: rolloverState.dispatchId,
					rolloverId: rolloverState.rolloverId,
					state: "blocked",
					requestFingerprint:
						startedDispatch?.type === "context_rollover_dispatch"
							? startedDispatch.requestFingerprint
							: "unknown",
					reason: "dispatch_outcome_unknown",
				});
			}
			this._beginContextPrompt();

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// next_prompt retains its original meaning: deliver only with a new user prompt.
			const nextPromptItems = this._pendingDeliveryStore
				.snapshot()
				.items.filter((item) => item.channel === "next_prompt");
			for (const item of nextPromptItems) {
				this._pendingDeliveryStore.markDelivered(item.queueItemId);
				this._deliveredPendingMessages.add(item.message as object);
				messages.push(item.message);
			}

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Grok-aligned TodoNudge: periodically remind the model to keep the
			// visible todo list current. Purely informational — never blocks or
			// forces a continuation (see TodoGate in reminder-policy.ts for that).
			if (this.getActiveToolNames().includes("todo_write") && this._todoNudgeTracker.shouldNudge()) {
				messages.push({
					role: "custom",
					customType: "todo-nudge",
					content: [{ type: "text", text: todoNudgeReminderText() }],
					display: false,
					timestamp: Date.now(),
				});
				this._todoNudgeTracker.recordNudgeFired();
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			if (startedMemoryRun) this._settleCurrentMemoryRun("failed");
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (this.subagents) await this.subagents.scope.join(() => this._queueSteer(expandedText, images));
		else await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (this.subagents) await this.subagents.scope.join(() => this._queueFollowUp(expandedText, images));
		else await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(
		text: string,
		images?: ImageContent[],
		origin: "user" | "runtime" | "extension" = "user",
	): Promise<void> {
		this._subagentRunScope?.assertActive();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const queued = this._pendingDeliveryStore.enqueue("steering", {
			role: "user",
			content,
			timestamp: Date.now(),
		});
		this._memoryQueueOrigins.set(queued.queueItemId, origin);
		this.agent.steer(queued);
		this._emitQueueUpdate();
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(
		text: string,
		images?: ImageContent[],
		origin: "user" | "runtime" | "extension" = "user",
	): Promise<void> {
		this._subagentRunScope?.assertActive();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const queued = this._pendingDeliveryStore.enqueue("follow_up", {
			role: "user",
			content,
			timestamp: Date.now(),
		});
		this._memoryQueueOrigins.set(queued.queueItemId, origin);
		this.agent.followUp(queued);
		this._emitQueueUpdate();
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		if (options?.triggerTurn) this._subagentRunScope?.assertActive();
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingDeliveryStore.enqueue("next_prompt", appMessage);
		} else if (this.isStreaming) {
			const channel = options?.deliverAs === "followUp" ? "follow_up" : "steering";
			const queued = this._pendingDeliveryStore.enqueue(channel, appMessage);
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(queued);
			} else {
				this.agent.steer(queued);
			}
			this._emitQueueUpdate();
		} else if (options?.triggerTurn) {
			this._beginContextPrompt();
			if (this._subagentRunScope) await this._subagentRunScope.track(() => this._runAgentPrompt(appMessage));
			else await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const queueItems = this._pendingDeliveryStore
			.snapshot()
			.items.filter((item) => item.channel === "steering" || item.channel === "follow_up");
		const steering = queueItems
			.filter((item) => item.channel === "steering")
			.map((item) => messageText(item.message));
		const followUp = queueItems
			.filter((item) => item.channel === "follow_up")
			.map((item) => messageText(item.message));
		for (const item of queueItems) {
			this._pendingDeliveryStore.cancel(item.queueItemId);
			this._memoryQueueOrigins.delete(item.queueItemId);
		}
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._pendingDeliveryStore
			.snapshot()
			.items.filter((item) => item.channel === "steering" || item.channel === "follow_up").length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._pendingDeliveryStore
			.snapshot()
			.items.filter((item) => item.channel === "steering")
			.map((item) => messageText(item.message));
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._pendingDeliveryStore
			.snapshot()
			.items.filter((item) => item.channel === "follow_up")
			.map((item) => messageText(item.message));
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.subagents?.scope.abort();
		this._promptAborted = true;
		this._cancelExecutionUpgrade("User cancelled execution.");
		this.abortCompaction();
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (
			!this._isAgentRunActive &&
			this._deferredContextTransition &&
			!this._promptAborted &&
			this.getContextTransitionGate().status !== "busy"
		)
			await this._resumePreparedContextRollover();
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore" | "upgrade",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		this._selectionRevision++;
		this._cancelExecutionUpgrade("User selected a model.");
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		this._selectionRevision++;
		this._cancelExecutionUpgrade("User cycled the model.");
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const checks = await Promise.all(
			this._scopedModels.map(async (scoped) => ({
				scoped,
				auth: await this._modelRuntime.checkAuth(scoped.model.provider),
			})),
		);
		const scopedModels = checks.filter(({ auth }) => auth !== undefined).map(({ scoped }) => scoped);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRuntime.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		this._selectionRevision++;
		this._cancelExecutionUpgrade("User selected a thinking level.");
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		try {
			return await this._compactContext("manual", customInstructions);
		} finally {
			this._reconnectToAgent();
		}
	}

	private async _compactContext(
		reason: "manual" | "threshold" | "overflow",
		customInstructions?: string,
	): Promise<CompactionResult> {
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();
			const sourceFingerprint = fingerprintContextRolloverValue(pathEntries);
			const sourceRevisions = fingerprintContextRolloverValue(this._contextRolloverRevisions());

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason,
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			if (this._validateCompactionCommit(summary, firstKeptEntryId, sourceFingerprint) !== "valid") {
				throw new Error("Invalid or stale compaction result");
			}
			const scope = resolveTaskNoteScope(
				pathEntries,
				this.sessionManager.getLatestContextCoordinates().promptGeneration,
			);
			const users = new History(this.sessionManager).getItems().filter((item) => item.role === "user");
			const taskIndex = users.findIndex((item) => createTaskScopeId(item.entryId) === scope?.taskScopeId);
			const preservedEntryIds = taskIndex < 0 ? [] : users.slice(taskIndex).map((item) => item.entryId);
			const requiredDeliveries = new Set(
				pathEntries.flatMap((entry) =>
					entry.type === "pending_delivery" && preservedEntryIds.includes(entry.id) ? [entry.deliveryId] : [],
				),
			);
			preservedEntryIds.push(
				...pathEntries.flatMap((entry) =>
					entry.type === "delivery_receipt" && requiredDeliveries.has(entry.deliveryId) ? [entry.id] : [],
				),
			);
			if (reason !== "manual") {
				const candidate: CompactionEntry = {
					...this.sessionManager.ensureContextWindow(),
					type: "compaction",
					id: randomUUID(),
					parentId: this.sessionManager.getLeafId(),
					timestamp: "1970-01-01T00:00:00.000Z",
					summary,
					firstKeptEntryId,
					preservedEntryIds,
					tokensBefore,
					details,
					usage,
					fromHook: fromExtension,
				};
				const candidateMessages = buildSessionContext(
					[...this.sessionManager.getEntries(), candidate],
					candidate.id,
				).messages;
				const before = await this._measureRequest(
					this.agent.state.messages,
					this._compactionAbortController.signal,
				);
				const after = await this._measureRequest(candidateMessages, this._compactionAbortController.signal);
				if (after.budget.tokens >= before.budget.tokens)
					throw new Error("Compaction did not reduce the complete request");
				if (sourceRevisions !== fingerprintContextRolloverValue(this._contextRolloverRevisions()))
					throw new Error("Compaction source changed");
				this._compactionAbortController.signal.throwIfAborted();
				if (this._promptAborted) throw new Error("Compaction cancelled");
			}
			const compactionId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
				preservedEntryIds,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
			this.sessionManager.appendTrace({
				type: "compaction/summary",
				data: {
					turn: Math.max(0, this._nextTraceTurn - 1),
					phase: "commit",
					outcome: "completed",
					compactionId,
					sourceFingerprint,
					firstKeptEntryId,
					usage,
				},
			});

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.id === compactionId) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason,
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	private _beginContextPrompt(): void {
		this._cancelExecutionUpgrade("A new user prompt started.");
		this._executionMonitor = new ExecutionMonitor();
		this._executionMonitor.observeTodos(this._todoStateStore.toJSON());
		this._executionToolRequests.clear();
		this._deferredContextTransition = false;
		this._latestRequest = undefined;
		this._contextRemaining = undefined;
		this._lastProviderRequest = undefined;
		this._controlReadTokens = 0;
		this._controlReadBudgetByCallId.clear();
		this._recoveryNoProgressCount = 0;
		this._recoveryProgressRolloverId = undefined;
		this._recoveryProgressFingerprints.clear();
		this.sessionManager.ensureContextWindow();
		this.sessionManager.appendCustomEntry("context-prompt-generation", {
			promptGeneration: this.sessionManager.getLatestContextCoordinates().promptGeneration + 1,
			contextEpoch: 0,
		});
	}

	private _contextRolloverRevisions() {
		const todo = this._todoRevision();
		const queue = this._pendingDeliveryStore.snapshot();
		const branch = this.sessionManager.getBranch();
		const scope = resolveTaskNoteScope(branch, this.sessionManager.getLatestContextCoordinates().promptGeneration);
		const projection = scope
			? buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch))
			: undefined;
		return {
			taskNoteProjectionRevision: projection?.status === "valid" ? projection.snapshot.revision : "invalid",
			sessionLeafId: this.sessionManager.getLeafId(),
			sourceFingerprint: fingerprintContextRolloverValue(branch),
			todoStateEntryId: todo.entryId,
			todoStateFingerprint: todo.fingerprint,
			queueRevision: queue.revision,
			progressRevision: fingerprintContextRolloverValue(branch.filter((entry) => entry.type === "context_progress")),
			requestConfigFingerprint: this._requestConfigFingerprint(),
		};
	}

	private _appendTraceSafely(event: SessionTraceEvent): void {
		try {
			this.sessionManager.appendTrace(event);
		} catch {
			console.warn("Failed to append context trace event");
		}
	}

	private _requestConfigFingerprint(): string {
		return fingerprintContextRolloverValue({
			systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
			tools: this.agent.state.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			model: {
				provider: this.agent.state.model.provider,
				id: this.agent.state.model.id,
				api: this.agent.state.model.api,
				baseUrl: this.agent.state.model.baseUrl,
				contextWindow: this.agent.state.model.contextWindow,
				maxTokens: this.agent.state.model.maxTokens,
				reasoning: this.agent.state.model.reasoning,
			},
			thinkingLevel: this.agent.state.thinkingLevel,
			budget: this.agent.getContextBudgetOptions?.(this.agent.state.model) ?? {},
		});
	}

	private _todoRevision(): { entryId: string | null; fingerprint: string } {
		const latest = [...this.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === "todo-state");
		return {
			entryId: latest?.id ?? null,
			fingerprint: fingerprintContextRolloverValue(latest?.type === "custom" ? latest.data : []),
		};
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	get contextRolloverState() {
		return this.sessionManager.getContextRolloverState();
	}

	get taskNoteState(): { activeCount: number; staleCount: number; lastFailureReason?: string } {
		const branch = this.sessionManager.getBranch();
		const coordinates = this.sessionManager.getLatestContextCoordinates();
		const scope = resolveTaskNoteScope(branch, coordinates.promptGeneration);
		if (scope === undefined) return { activeCount: 0, staleCount: 0 };
		const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
		if (projection.status !== "valid") {
			return { activeCount: 0, staleCount: 0, lastFailureReason: projection.reason };
		}
		const lastFailureReason = [...this.sessionManager.getBranchWithTrace()]
			.reverse()
			.find(
				(entry) =>
					entry.type === "trace" &&
					entry.event.type === "context/task_note" &&
					entry.event.data.outcome === "rejected" &&
					entry.event.data.reasonCode !== undefined,
			);
		return {
			activeCount: projection.snapshot.items.length,
			staleCount: projection.snapshot.items.filter((item) => item.freshness === "stale").length,
			...(lastFailureReason?.type === "trace" &&
			lastFailureReason.event.type === "context/task_note" &&
			lastFailureReason.event.data.reasonCode !== undefined
				? { lastFailureReason: lastFailureReason.event.data.reasonCode }
				: {}),
		};
	}

	private async _resumePreparedContextRollover(): Promise<void> {
		if (this._subagentRunScope && !this._subagentRunScope.isCurrent) return;
		if (this._subagentRunScope) return this._subagentRunScope.track(() => this._resumePreparedContextRolloverOwned());
		return this._resumePreparedContextRolloverOwned();
	}

	private async _resumePreparedContextRolloverOwned(): Promise<void> {
		this._subagentRunScope?.assertActive();
		if (this._isAgentRunActive) return;
		const state = this.contextRolloverState;
		const resumableDispatch = this._resumableInterruptedDispatch();
		const interrupted =
			state.outcome === "context_limit" ||
			state.outcome === "context_transition" ||
			state.outcome === "context_maintenance";
		const identity = this.sessionManager.ensureContextWindow();
		const coordinates = this.sessionManager.getLatestContextCoordinates();
		const saving = getSaveStateOperation(this.sessionManager, identity.windowId, coordinates.promptGeneration);
		if (
			state.dispatchState !== "prepared" &&
			state.dispatchState !== "outcome_unknown" &&
			!this._pendingContextTransition() &&
			!this._deferredContextTransition &&
			!interrupted &&
			(saving === undefined || saving.finished)
		)
			return;
		this._isAgentRunActive = true;
		const deferred = this._deferredContextTransition;
		this._deferredContextTransition = false;
		try {
			if (saving && !saving.finished) {
				const usage = this._saveStateUsage(saving.businessCutoffEntryId);
				const savedValidation = validateContinuationState(this.sessionManager, saving);
				const validation: ContinuationStateValidation =
					savedValidation.status === "valid" && !this._pendingContextTransition()
						? { status: "invalid", reason: "model_request_missing" }
						: savedValidation;
				if (validation.status === "valid") {
					this._finishSaveState(saving, usage, validation);
					this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
					if (this.agent.state.messages.at(-1)?.role === "assistant") {
						this._appendContextControlMessage(
							createCustomMessage(
								"context-save-state-resumed",
								"The persisted continuation contract was validated after restart. Prepare the saved window transition.",
								false,
								{ operationId: saving.operationId },
								new Date().toISOString(),
							),
						);
					}
				} else {
					this.sessionManager.appendContextOperation({
						operationId: saving.operationId,
						operationKind: "save_state",
						transitionCause: saving.transitionCause,
						state: "started",
						windowId: saving.windowId,
						promptGeneration: saving.promptGeneration,
						contextEpoch: saving.contextEpoch,
						sourceFingerprint: saving.sourceFingerprint,
						businessCutoffEntryId: saving.businessCutoffEntryId,
						startTaskNoteRevision: saving.startTaskNoteRevision,
						controlBudgetTokens: saving.controlBudgetTokens,
						outputBudgetTokens: saving.outputBudgetTokens,
						samplesUsed: usage.samplesUsed,
						consumedControlTokens: usage.controlTokens,
						consumedOutputTokens: usage.outputTokens,
						outcome: validation.reason,
					});
					const remainingControl = saving.controlBudgetTokens - usage.controlTokens;
					const remainingOutput = saving.outputBudgetTokens - usage.outputTokens;
					if (
						validation.reason === "tool_transaction_incomplete" ||
						usage.samplesUsed >= SAVE_STATE_MAX_SAMPLES ||
						remainingControl <= 0 ||
						remainingOutput <= 0
					) {
						this._appendTraceSafely({
							type: "context/save_state",
							data: {
								turn: Math.max(0, this._nextTraceTurn - 1),
								operationId: saving.operationId,
								windowId: saving.windowId,
								phase: "failed",
								businessCutoffEntryId: saving.businessCutoffEntryId,
								samplesUsed: usage.samplesUsed,
								consumedControlTokens: usage.controlTokens,
								consumedOutputTokens: usage.outputTokens,
								reasonCode: validation.reason,
							},
						});
						this._extensionUIContext?.notify(`Context rollover stopped: ${validation.reason}`, "error");
						this.agent.setIdleOutcome({ type: "failed", message: validation.reason });
						return;
					}
					this._controlReadTokens = Math.max(0, remainingControl);
					if (this.agent.state.messages.at(-1)?.role === "assistant") {
						this._appendContextControlMessage(
							createCustomMessage(
								"context-save-state-correction",
								`The persisted continuation contract is incomplete (${validation.reason}). Query exact sources if needed, then update next_action/current. ${SAVE_STATE_SUPERSESSION_INSTRUCTION} ${SAVE_STATE_CONTENT_INSTRUCTION}`,
								false,
								{ operationId: saving.operationId, reason: validation.reason },
								new Date().toISOString(),
							),
						);
					}
					await this.agent.continue({
						toolNames: SAVE_STATE_TOOL_NAMES,
						maxTokens: Math.min(Math.max(1, remainingOutput), this.agent.state.model.maxTokens),
					});
				}
			}
			const recovering = resumableDispatch ? this._recoveringRollover() : undefined;
			const continueRun =
				recovering !== undefined ||
				this._completedRecoveryAwaitingBusinessRequest() ||
				resumableDispatch?.lastAssistant.content.some((block) => block.type === "toolCall") === true;
			const result = resumableDispatch
				? await this._contextRollover.resumeInterrupted(resumableDispatch.rollover, {
						continueRun,
						recovering: recovering !== undefined,
					})
				: await this._contextRollover.resume();
			if (result?.outcome === "blocked") {
				this._deferredContextTransition = result.reason === "operation_in_flight";
				if (result.reason !== "operation_in_flight") {
					this.agent.setIdleOutcome({ type: "failed", message: result.reason });
				}
				this._extensionUIContext?.notify(`Context rollover stopped: ${result.reason}`, "error");
				return;
			}
			if (
				saving ||
				result?.outcome === "dispatched" ||
				this._pendingContextTransition() ||
				deferred ||
				interrupted
			) {
				while (true) {
					const action = await this._handlePostAgentRun();
					if (action !== "continue" && action !== "continue_save_state") break;
					await this.agent.continue(
						action === "continue_save_state"
							? {
									toolNames: SAVE_STATE_TOOL_NAMES,
									maxTokens: Math.min(STATE_SAVE_OUTPUT_TOKENS, this.agent.state.model.maxTokens),
								}
							: {},
					);
				}
			}
		} finally {
			await this._emitAgentSettled();
		}
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		await this._resumePreparedContextRollover();
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					if (options?.triggerTurn || this.isStreaming) this._subagentRunScope?.assertActive();
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this._subagentRunScope?.assertActive();
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		if (this._subagentPermission) {
			for (const [name, tool] of toolRegistry) {
				const definition = definitionRegistry.get(name)!.definition;
				const required = subagentToolPermission(
					definition,
					name,
					this._baseToolDefinitions.get(name) === definition,
				);
				toolRegistry.set(name, {
					...tool,
					execute: (...args) => {
						this._subagentRunScope?.assertActive();
						if (!canUseSubagentTool(this._subagentPermission!(), required))
							throw new SubagentError("tool_permission_denied");
						if (required === "full") this._subagentRunScope?.markExternalEffect();
						return tool.execute(...args);
					},
				});
			}
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						taskManager: this._taskManager,
						...this.settingsManager.getBashBackgroundSettings(),
						sandbox: this.settingsManager.hasExplicitSandboxSettings()
							? {
									manager: new SandboxManager({ workspaceRoot: this._cwd }),
									settings: this.settingsManager.getSandboxSettings(),
								}
							: undefined,
					},
					taskManager: this._taskManager,
					todoWrite: {
						store: this._todoStateStore,
						onChange: (snapshot) => {
							this.sessionManager.appendCustomEntry("todo-state", snapshot);
							if (this._executionBusinessRequest) this._executionMonitor.observeTodos(snapshot);
						},
					},
				});
		Object.assign(baseToolDefinitions, {
			enter_plan_mode: createEnterPlanModeToolDefinition(this),
			exit_plan_mode: createExitPlanModeToolDefinition(this),
			web_fetch: createWebFetchToolDefinition(this._webFetchOps),
			history: createHistoryToolDefinition(this.sessionManager, (requestedTokens, toolCallId) =>
				this._reserveContextReadBudget(requestedTokens, toolCallId),
			),
			get_context_remaining: createContextRemainingToolDefinition(() => {
				if (!this._contextRemaining) throw new Error("No completed request measurement");
				return this._contextRemaining;
			}),
			new_context: createNewContextToolDefinition(this.sessionManager),
			context_note: createContextNoteToolDefinition({
				sessionManager: this.sessionManager,
				getPromptGeneration: () => this.sessionManager.getLatestContextCoordinates().promptGeneration,
				reserveReadBudget: (requestedTokens, toolCallId) =>
					this._reserveContextReadBudget(requestedTokens, toolCallId),
				getContextEpoch: () => this.sessionManager.getLatestContextCoordinates().contextEpoch,
				getTraceTurn: () => Math.max(0, this._nextTraceTurn - 1),
				onTrace: (event) => this._appendTraceSafely(event),
			}),
		});
		if ((this._executionUpgradeOverride ?? this.settingsManager.getExecutionUpgradeSettings()).enabled) {
			Object.assign(baseToolDefinitions, {
				upgrade_execution: createUpgradeExecutionToolDefinition((callId, request) => {
					this._executionToolRequests.set(callId, {
						request: structuredClone(request),
						revision: this._executionRequestRevision,
					});
				}),
			});
		}
		if (this.settingsManager.getMemorySettings().enabled) {
			const memoryQueryContext = () => ({
				cwd: this._cwd,
				platform: process.platform,
				runtime: process.version,
			});
			Object.assign(baseToolDefinitions, {
				memory_search: createMemorySearchToolDefinition(this._memoryAuthority, memoryQueryContext),
				memory_get: createMemoryGetToolDefinition(this._memoryAuthority, memoryQueryContext),
			});
		}
		if (this._lspEnabled) {
			Object.assign(baseToolDefinitions, { lsp: createLspToolDefinition(this._lspManager) });
		}
		if (this._webSearchOps) {
			Object.assign(baseToolDefinitions, { web_search: createWebSearchToolDefinition(this._webSearchOps) });
		}
		if (this._mcpManager.hasServers()) {
			Object.assign(baseToolDefinitions, {
				search_tool: createMcpSearchToolDefinition(this._mcpManager),
				use_tool: createMcpUseToolDefinition(this._mcpManager),
			});
		}
		Object.assign(baseToolDefinitions, Object.fromEntries(this._collaborationTools.map((tool) => [tool.name, tool])));
		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: [
					"read",
					"bash",
					"edit",
					"write",
					"todo_write",

					"get_task_output",
					"kill_task",
					"history",
					"context_note",
					"get_context_remaining",
					"new_context",
				];
		if (!this._baseToolsOverride && this.settingsManager.getMemorySettings().enabled) {
			defaultActiveToolNames.push("memory_search", "memory_get");
		}
		defaultActiveToolNames.push(...this._collaborationTools.map((tool) => tool.name));
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		if (options.activeToolNames === undefined && "upgrade_execution" in baseToolDefinitions)
			baseActiveToolNames.push("upgrade_execution");
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		const reminderPolicy = this.settingsManager.getReminderPolicy();
		this._todoNudgeTracker.updatePolicy({
			...reminderPolicy.todoNudge,
			enabled: reminderPolicy.enabled && reminderPolicy.todoNudge.enabled,
		});
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const branchTodos = getLatestCustomEntryData<ReturnType<TodoStateStore["toJSON"]>>(
				this.sessionManager.getBranch(),
				"todo-state",
			);
			this._todoStateStore.clear();
			if (branchTodos) this._todoStateStore.applyReplace(branchTodos);
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "trace" && entry.event.type === "memory/archive" && entry.event.data.usage)
				addUsageToTotals(usageTotals, entry.event.data.usage);
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		this.sessionManager.assertIndependentSession();
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			ownership: this.sessionManager.getHeader()?.ownership,
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranchWithTrace();
		const lines = [JSON.stringify(header)];

		// Re-chain logical entries to form a linear sequence. Trace entries stay anchored
		// to the current logical leaf and never become parents themselves.
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			if (entry.type !== "trace") {
				prevId = entry.id;
			}
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
