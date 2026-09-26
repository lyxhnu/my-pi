import type {
	ContextBudget,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "@earendil-works/pi-ai";
import { type PreparedAgentRequest, prepareAgentRequest, runAgentLoop, runAgentLoopPrepared } from "./agent-loop.ts";
import { AppendOnlyContextManager } from "./append-only-context.ts";
import { reduceAgentRunState } from "./run-state.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentRunOutcome,
	AgentRunState,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	GuardToolCallContext,
	PrepareNextTurnContext,
	QueuedAgentMessage,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

/** Opaque summary of an exact first provider request prepared by an Agent. */
export interface PreparedContinuation {
	readonly preparationId: string;
	readonly baseContextFingerprint: string;
	readonly requestFingerprint: string;
	readonly budget: ContextBudget;
	readonly queueRevision: string;
	readonly reservedQueueItemIds: readonly string[];
}

export interface PrepareContinuationOptions {
	signal?: AbortSignal;
	requiredQueueItemIds?: readonly string[];
	toolNames?: readonly string[];
	maxTokens?: number;
}

export interface MeasurePreparedContinuationOptions {
	toolNames?: readonly string[];
	maxTokens?: number;
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "runState"> & { runState: AgentRunState };

function createMutableAgentState(initialState?: Partial<Omit<AgentState, "runState">>): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		runState: { status: "idle" },
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	prepareRequest?: AgentLoopConfig["prepareRequest"];
	controlRequest?: AgentLoopConfig["controlRequest"];
	afterTurnControl?: AgentLoopConfig["afterTurnControl"];
	getContextBudgetOptions?: AgentLoopConfig["getContextBudgetOptions"];
	initialState?: Partial<Omit<AgentState, "runState">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	projectUsageContext?: AgentLoopConfig["projectUsageContext"];
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	guardToolCall?: (context: GuardToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/**
	 * Asked after every turn whether the loop should stop before starting another provider request.
	 *
	 * Exists so a host can act on per-turn state that only it can judge — chiefly context pressure: a
	 * single prompt can run dozens of tool-calling turns, and anything the host only checks after the
	 * whole run (compaction, for one) never gets a say while that run is filling the window.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
	/**
	 * Enable append-only context mode, which keeps the provider's prompt cache warm by reusing a
	 * stable prefix and only appending new messages. Off by default.
	 */
	appendOnlyContext?: boolean;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
}

class PendingMessageQueue {
	private items: Array<{ item: QueuedAgentMessage; reservationId?: string }> = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(item: QueuedAgentMessage): void {
		this.items.push({ item });
	}

	hasItems(): boolean {
		return this.items.some((entry) => entry.reservationId === undefined);
	}

	drainItems(): QueuedAgentMessage[] {
		const selected = this.availableItems();
		const selectedIds = new Set(selected.map((item) => item.queueItemId));
		this.items = this.items.filter((entry) => !selectedIds.has(entry.item.queueItemId));
		return selected;
	}

	availableItems(): QueuedAgentMessage[] {
		const available = this.items.filter((entry) => entry.reservationId === undefined).map((entry) => entry.item);
		return this.mode === "all" ? available : available.slice(0, 1);
	}

	allItems(): QueuedAgentMessage[] {
		return this.items.map((entry) => entry.item);
	}

	hasItem(queueItemId: string): boolean {
		return this.items.some((entry) => entry.item.queueItemId === queueItemId);
	}

	reserve(queueItemIds: readonly string[], reservationId: string): void {
		for (const queueItemId of queueItemIds) {
			const entry = this.items.find((candidate) => candidate.item.queueItemId === queueItemId);
			if (!entry || entry.reservationId !== undefined) {
				throw new Error(`Queue item cannot be reserved: ${queueItemId}`);
			}
			entry.reservationId = reservationId;
		}
	}

	consumeReservation(reservationId: string): void {
		this.items = this.items.filter((entry) => entry.reservationId !== reservationId);
	}

	releaseReservation(reservationId: string): void {
		for (const entry of this.items) {
			if (entry.reservationId === reservationId) entry.reservationId = undefined;
		}
	}

	clear(): void {
		this.items = this.items.filter((entry) => entry.reservationId !== undefined);
	}

	removeItems(queueItemIds: ReadonlySet<string>): void {
		this.items = this.items.filter((entry) => !queueItemIds.has(entry.item.queueItemId));
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

type PreparedContinuationRecord = {
	key: string;
	handle: PreparedContinuation;
	baseContext: AgentContext;
	config: AgentLoopConfig;
	request: PreparedAgentRequest;
	injectedItems: QueuedAgentMessage[];
	state: "prepared" | "dispatching";
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	public prepareRequest?: AgentLoopConfig["prepareRequest"];
	public controlRequest?: AgentLoopConfig["controlRequest"];
	public afterTurnControl?: AgentLoopConfig["afterTurnControl"];
	public getContextBudgetOptions?: AgentLoopConfig["getContextBudgetOptions"];
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public projectUsageContext?: AgentLoopConfig["projectUsageContext"];
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public guardToolCall?: (
		context: GuardToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	/**
	 * Append-only context manager, present only when the mode is enabled. Lives on the Agent rather
	 * than per run because the provider cache it protects spans requests.
	 */
	public readonly appendOnlyContext?: AppendOnlyContextManager;
	private activeRun?: ActiveRun;
	private nextRunId = 1;
	private nextPreparationId = 1;
	private preparedContinuation?: PreparedContinuationRecord;
	private preparationInFlight?: { key: string; promise: Promise<PreparedContinuation> };
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		this.prepareRequest = runtimeOptions.prepareRequest;
		this.controlRequest = runtimeOptions.controlRequest;
		this.afterTurnControl = runtimeOptions.afterTurnControl;
		this._state = createMutableAgentState(runtimeOptions.initialState);
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		this.projectUsageContext = runtimeOptions.projectUsageContext;
		this.transformContext = runtimeOptions.transformContext;
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.guardToolCall = runtimeOptions.guardToolCall;
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.shouldStopAfterTurn = runtimeOptions.shouldStopAfterTurn;
		this.getContextBudgetOptions = runtimeOptions.getContextBudgetOptions;
		this.appendOnlyContext = runtimeOptions.appendOnlyContext ? new AppendOnlyContextManager() : undefined;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Replace the outcome after caller-owned orchestration that runs only once the agent loop is idle. */
	setIdleOutcome(outcome: AgentRunOutcome): void {
		if (this._state.runState.status !== "idle") {
			throw new Error("Cannot replace an agent outcome while a run is active");
		}
		this._state.runState = { status: "idle", lastOutcome: outcome };
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(item: QueuedAgentMessage): void {
		this.assertUniqueQueueItemId(item.queueItemId);
		this.steeringQueue.enqueue(item);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(item: QueuedAgentMessage): void {
		this.assertUniqueQueueItemId(item.queueItemId);
		this.followUpQueue.enqueue(item);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Remove specific queued messages, including items held by a preparation reservation. */
	discardQueuedItems(queueItemIds: readonly string[]): void {
		const ids = new Set(queueItemIds);
		this.steeringQueue.removeItems(ids);
		this.followUpQueue.removeItems(ids);
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		if (!this.activeRun || this._state.runState.status === "idle") return;
		if (this._state.runState.phase.type !== "settling") {
			this._state.runState = { ...this._state.runState, phase: { type: "cancelling" } };
		}
		this.activeRun.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		if (this.activeRun) throw new Error("Cannot reset while the agent is processing.");
		this._state.messages = [];
		this._state.runState = { status: "idle" };
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(options: PrepareContinuationOptions = {}): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}
		if (this._state.messages.length === 0) throw new Error("No messages to continue from");
		if (this.preparedContinuation || this.preparationInFlight) {
			throw new Error("Settle the prepared continuation before starting an ordinary continuation.");
		}
		const lastMessage = this._state.messages.at(-1);
		if (lastMessage?.role === "assistant" && !this.hasQueuedMessages()) {
			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runWithLifecycle(async (signal) => {
			const onAbort = () => this.abort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				options.signal?.throwIfAborted();
				const context = this.createContextSnapshot();
				if (options.toolNames)
					context.tools = context.tools?.filter((tool) => options.toolNames!.includes(tool.name));
				const items = this.selectQueueItems(context.messages, options.requiredQueueItemIds);
				const reservationId = `continuation-${this.nextPreparationId++}`;
				this.reserveQueueItems(
					items.map((item) => item.queueItemId),
					reservationId,
				);
				this.consumeQueueReservation(reservationId);
				await runAgentLoopPrepared(
					context,
					items,
					undefined,
					this.createLoopConfig({ skipInitialSteeringPoll: true, maxTokens: options.maxTokens }),
					(event) => this.processEvents(event),
					signal,
					this.streamFunction,
				);
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
		});
	}

	/** Prepare and freeze the first provider request for a future continuation. */
	async prepareContinuation(
		candidateMessages: AgentMessage[],
		options: PrepareContinuationOptions = {},
	): Promise<PreparedContinuation> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before preparing a continuation.");
		}
		const baseContext: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: candidateMessages.slice(),
			tools:
				options.toolNames === undefined
					? this._state.tools.slice()
					: this._state.tools.filter((tool) => options.toolNames!.includes(tool.name)),
		};
		const key = fingerprintValue({
			baseContextFingerprint: fingerprintAgentContext(baseContext),
			model: {
				provider: this._state.model.provider,
				id: this._state.model.id,
				api: this._state.model.api,
				baseUrl: this._state.model.baseUrl,
				contextWindow: this._state.model.contextWindow,
				maxTokens: this._state.model.maxTokens,
			},
			thinkingLevel: this._state.thinkingLevel,
			queueRevision: this.queueRevision(),
			requiredQueueItemIds: options.requiredQueueItemIds ?? null,
			toolNames: options.toolNames ?? null,
			maxTokens: options.maxTokens ?? null,
		});
		if (this.preparedContinuation) {
			if (this.preparedContinuation.key === key) return this.preparedContinuation.handle;
			throw new Error("Agent already has an unsettled prepared continuation from a different source");
		}
		if (this.preparationInFlight) {
			if (this.preparationInFlight.key === key) return await this.preparationInFlight.promise;
			throw new Error("Agent is preparing a continuation from a different source");
		}

		const promise = this.createPreparedContinuation(key, baseContext, options);
		this.preparationInFlight = { key, promise };
		try {
			return await promise;
		} finally {
			if (this.preparationInFlight?.promise === promise) this.preparationInFlight = undefined;
		}
	}

	private async createPreparedContinuation(
		key: string,
		baseContext: AgentContext,
		options: PrepareContinuationOptions,
	): Promise<PreparedContinuation> {
		const preparationId = `preparation-${this.nextPreparationId++}`;
		const selectedQueueItems = this.selectQueueItems(baseContext.messages, options.requiredQueueItemIds);
		const selectedIds = selectedQueueItems.map((item) => item.queueItemId);
		this.reserveQueueItems(selectedIds, preparationId);
		const requestContext: AgentContext = {
			...baseContext,
			messages: [...baseContext.messages, ...selectedQueueItems.map((item) => item.message)],
		};
		const config = this.createLoopConfig({ maxTokens: options.maxTokens });
		let request: PreparedAgentRequest;
		try {
			request = { ...(await prepareAgentRequest(requestContext, config, options.signal)), preparationId };
		} catch (error) {
			this.releaseQueueReservation(preparationId);
			throw error;
		}
		const handle: PreparedContinuation = Object.freeze({
			preparationId,
			baseContextFingerprint: fingerprintAgentContext(baseContext),
			requestFingerprint: request.requestFingerprint,
			budget: request.budget,
			queueRevision: this.queueRevision(),
			reservedQueueItemIds: Object.freeze(selectedIds.slice()),
		});
		this.preparedContinuation = {
			key,
			handle,
			baseContext,
			config,
			request,
			injectedItems: selectedQueueItems,
			state: "prepared",
		};
		return handle;
	}

	/** Dispatch a previously prepared continuation exactly once. */
	async dispatchPreparedContinuation(preparation: PreparedContinuation): Promise<void> {
		const record = this.preparedContinuation;
		if (!record || record.handle.preparationId !== preparation.preparationId) {
			throw new Error("Prepared continuation is unknown or already settled");
		}
		if (record.state !== "prepared") {
			throw new Error("Prepared continuation is already dispatching");
		}
		record.state = "dispatching";
		this.consumeQueueReservation(record.handle.preparationId);
		this._state.messages = record.baseContext.messages;
		if (record.request.appendOnlyContext && this.appendOnlyContext) {
			this.appendOnlyContext.replaceWith(record.request.appendOnlyContext);
		}

		try {
			await this.runWithLifecycle(async (signal) => {
				await runAgentLoopPrepared(
					record.baseContext,
					record.injectedItems,
					record.request,
					record.config,
					(event) => this.processEvents(event),
					signal,
					this.streamFunction,
				);
			});
		} finally {
			this.preparedContinuation = undefined;
		}
	}

	/** Measure an augmented form of a reserved continuation without changing its queue reservation. */
	async measurePreparedContinuation(
		preparation: PreparedContinuation,
		additionalMessages: AgentMessage[],
		options: MeasurePreparedContinuationOptions = {},
	): Promise<ContextBudget> {
		const record = this.preparedContinuation;
		if (!record || record.handle.preparationId !== preparation.preparationId || record.state !== "prepared") {
			throw new Error("Prepared continuation is unknown or already settled");
		}
		const context: AgentContext = {
			...record.baseContext,
			messages: [
				...record.baseContext.messages,
				...record.injectedItems.map((item) => item.message),
				...additionalMessages,
			],
			tools:
				options.toolNames === undefined
					? this._state.tools.slice()
					: this._state.tools.filter((tool) => options.toolNames!.includes(tool.name)),
		};
		return (
			await prepareAgentRequest(context, this.createLoopConfig({ maxTokens: options.maxTokens }), undefined, {
				mode: "measure",
			})
		).budget;
	}

	/** Release a prepared continuation without mutating transcript or append-only state. */
	releasePreparedContinuation(preparation: PreparedContinuation): void {
		const record = this.preparedContinuation;
		if (!record || record.handle.preparationId !== preparation.preparationId) {
			throw new Error("Prepared continuation is unknown or already settled");
		}
		if (record.state !== "prepared") {
			throw new Error("Cannot release a continuation after dispatch started");
		}
		this.releaseQueueReservation(record.handle.preparationId);
		this.preparedContinuation = undefined;
	}

	private selectQueueItems(
		candidateMessages: AgentMessage[],
		requiredQueueItemIds?: readonly string[],
	): QueuedAgentMessage[] {
		if (requiredQueueItemIds) {
			if (requiredQueueItemIds.length === 0) return [];
			const steeringItems = this.steeringQueue.allItems();
			const followUpItems = this.followUpQueue.allItems();
			const firstId = requiredQueueItemIds[0];
			const sourceItems = steeringItems.some((item) => item.queueItemId === firstId) ? steeringItems : followUpItems;
			const expectedPrefix = sourceItems.slice(0, requiredQueueItemIds.length);
			if (expectedPrefix.length !== requiredQueueItemIds.length) {
				throw new Error("Required queue item is missing or already delivered");
			}
			if (expectedPrefix.some((item, index) => item.queueItemId !== requiredQueueItemIds[index])) {
				throw new Error("Required queue item order does not match the pending delivery order");
			}
			return expectedPrefix;
		}

		const lastMessage = candidateMessages[candidateMessages.length - 1];
		if (!lastMessage) return [];
		const steering = this.steeringQueue.availableItems();
		if (steering.length > 0) return steering;
		return lastMessage.role === "assistant" ? this.followUpQueue.availableItems() : [];
	}

	private reserveQueueItems(queueItemIds: readonly string[], reservationId: string): void {
		const steeringIds = queueItemIds.filter((queueItemId) => this.steeringQueue.hasItem(queueItemId));
		const followUpIds = queueItemIds.filter((queueItemId) => this.followUpQueue.hasItem(queueItemId));
		this.steeringQueue.reserve(steeringIds, reservationId);
		this.followUpQueue.reserve(followUpIds, reservationId);
	}

	private releaseQueueReservation(reservationId: string): void {
		this.steeringQueue.releaseReservation(reservationId);
		this.followUpQueue.releaseReservation(reservationId);
	}

	private consumeQueueReservation(reservationId: string): void {
		this.steeringQueue.consumeReservation(reservationId);
		this.followUpQueue.consumeReservation(reservationId);
	}

	private assertUniqueQueueItemId(queueItemId: string): void {
		if (this.steeringQueue.hasItem(queueItemId) || this.followUpQueue.hasItem(queueItemId)) {
			throw new Error(`Duplicate queue item ID: ${queueItemId}`);
		}
	}

	private queueRevision(): string {
		return fingerprintValue({
			steering: this.steeringQueue.allItems(),
			followUp: this.followUpQueue.allItems(),
		});
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean; maxTokens?: number } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		// A provider switch leaves nothing of ours cached, so let the manager reset before the run.
		this.appendOnlyContext?.noteModel(this._state.model.provider, this._state.model.id);
		return {
			model: this._state.model,
			prepareRequest: this.prepareRequest,
			maxTokens: options.maxTokens,
			controlRequest: this.controlRequest,
			afterTurnControl: this.afterTurnControl,
			getContextBudgetOptions: this.getContextBudgetOptions,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			guardToolCall: this.guardToolCall,
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			shouldStopAfterTurn: this.shouldStopAfterTurn
				? async (context) => await this.shouldStopAfterTurn!(context, this.signal)
				: undefined,
			appendOnlyContext: this.appendOnlyContext,
			convertToLlm: this.convertToLlm,
			projectUsageContext: this.projectUsageContext,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return await this.deliverQueuedItems(this.steeringQueue.drainItems());
			},
			getFollowUpMessages: async () => await this.deliverQueuedItems(this.followUpQueue.drainItems()),
		};
	}

	private async deliverQueuedItems(items: QueuedAgentMessage[]): Promise<AgentMessage[]> {
		if (items.length > 0) {
			await this.processEvents({ type: "queue_delivery", items });
		}
		return items.map((item) => item.message);
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };
		this._state.runState = {
			status: "running",
			runId: this.nextRunId++,
			turn: 0,
			phase: { type: "preparing" },
		};

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		let outcome: AgentRunOutcome;
		if (this._state.runState.status === "running" && this._state.runState.phase.type === "settling") {
			outcome = this._state.runState.phase.outcome;
		} else if (this.activeRun?.abortController.signal.aborted) {
			outcome = { type: "aborted" };
		} else {
			outcome = { type: "failed", message: "Agent run ended without agent_end" };
		}
		this._state.runState = { status: "idle", lastOutcome: outcome };
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		this._state.runState = reduceAgentRunState(this._state.runState, event);
		switch (event.type) {
			case "message_end":
				this._state.messages.push(event.message);
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}

function fingerprintAgentContext(context: AgentContext): string {
	return fingerprintValue({
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools?.map(({ name, description, parameters, constrainedSampling }) => ({
			name,
			description,
			parameters,
			constrainedSampling,
		})),
	});
}

function fingerprintValue(value: unknown): string {
	const serialized = JSON.stringify(value);
	let hash = 2166136261;
	for (let index = 0; index < serialized.length; index++) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
