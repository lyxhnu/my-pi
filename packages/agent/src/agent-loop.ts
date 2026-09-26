/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	type ContextBudget,
	type ContextBudgetOptions,
	calculateContextBudget,
	contextFingerprint,
	EventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type { AppendOnlyContextManager } from "./append-only-context.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	QueuedAgentMessage,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Final immutable first-request snapshot created before a continuation is dispatched. */
export interface PreparedAgentRequest {
	readonly preparationId?: string;
	readonly model: Model<any>;
	readonly context: Context;
	readonly budget: ContextBudget;
	readonly reasoning: SimpleStreamOptions["reasoning"];
	readonly requestFingerprint: string;
	readonly usageContextMessages: readonly Message[];
	readonly appendOnlyContext?: AppendOnlyContextManager;
}

export function createProviderRequestFingerprint(
	context: Context,
	model: Model<any>,
	options: { reasoning?: SimpleStreamOptions["reasoning"]; budget?: ContextBudgetOptions } = {},
): string {
	const serialized = JSON.stringify({
		context: contextFingerprint(context, model),
		reasoning: options.reasoning ?? null,
		budget: options.budget ?? {},
	});
	let hash = 2166136261;
	for (let index = 0; index < serialized.length; index++) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

/**
 * How many turns in a row may be recovered from an output-token-limit truncation that produced no tool
 * call. Bounded so a model that keeps burning its whole budget on reasoning cannot spin forever; past
 * this the loop stops with the truncated message as the last one, which a host can detect via
 * `stopReason === "length"`.
 *
 * Two recoveries is exactly enough for the ladder below to reach its floor (default -> low -> minimal),
 * and it caps a truncation streak at three turns: the original plus two retries.
 */
const MAX_CONSECUTIVE_TRUNCATION_RECOVERIES = 2;

/**
 * Reasoning levels from most to least verbose. Truncation recovery walks down this ladder.
 *
 * `undefined` is not the bottom of this ladder — it sits off the *top* of it. Omitting `reasoning` tells
 * the provider "use your own default", and a turn that just spent its entire output budget thinking is
 * proof that the default is too much. Measured against dashscope/qwen3.7-plus with one prompt held
 * fixed: no parameter produced 1323 reasoning tokens, `low` produced 1114, and `minimal` produced none
 * at all. So stepping down from an unset level has to step *into* an explicit one, and `minimal` — not
 * `undefined` — is the real floor.
 */
const THINKING_LEVEL_LADDER: readonly ThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal"];

/**
 * One step down the reasoning ladder, bottoming out at `minimal`.
 *
 * Retrying a truncated turn at the same reasoning level just reproduces the truncation: the model wants
 * to say the same too-long thing again. Observed in benchmark runs as three consecutive turns each
 * ending at exactly the output cap with nothing but thinking to show for it. Telling the model to retry
 * is only half the fix; it also has to be given a smaller thinking budget to retry within.
 */
function degradeThinkingLevel(current: ThinkingLevel | undefined): ThinkingLevel {
	// Unset means the provider's own default, which the truncation has just disproven. Naming an explicit
	// level is the only way to actually ask for less — leaving it unset asks for the same thing again.
	if (current === undefined) return "low";
	const index = THINKING_LEVEL_LADDER.indexOf(current);
	// An unrecognized level cannot be stepped down one rung at a time, so go straight to the floor.
	if (index === -1) return "minimal";
	return THINKING_LEVEL_LADDER[index + 1] ?? "minimal";
}

/**
 * Position on the ladder, where a larger number is less reasoning. `undefined` sits *above* the top rung
 * because it means "whatever the provider does by default", which is more thinking than any named level.
 */
function thinkingRung(level: ThinkingLevel | undefined): number {
	if (level === undefined) return -1;
	const index = THINKING_LEVEL_LADDER.indexOf(level);
	return index === -1 ? THINKING_LEVEL_LADDER.length : index;
}

/** Whichever of the two asks for less reasoning. */
function lowerThinkingLevel(a: ThinkingLevel | undefined, b: ThinkingLevel | undefined): ThinkingLevel | undefined {
	return thinkingRung(a) >= thinkingRung(b) ? a : b;
}

/**
 * Nudge injected after a turn that hit the output token limit without producing a single tool call.
 *
 * A `length` stop with tool calls is already recoverable (see failToolCallsFromTruncatedMessage: each
 * call comes back as an error result, which both informs the model and keeps the loop running). With no
 * tool calls there is no result to carry that signal, and the truncated assistant message cannot be the
 * last thing in the context either — providers reject a request that ends on an assistant turn (the same
 * invariant agentLoopContinue enforces). This user message satisfies both needs at once.
 */
function createTruncationRecoveryMessage(): AgentMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					"Your previous response was cut off by the output token limit before it produced any tool call " +
					"or answer. Do not restate your reasoning. Take the next concrete action now — issue a tool call, " +
					"or give the final answer directly if the work is already done.",
			},
		],
		timestamp: Date.now(),
	};
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

/**
 * Continue from an already prepared first provider request.
 * Transform, conversion, budgeting, and queue selection have already happened.
 */
export async function runAgentLoopPrepared(
	context: AgentContext,
	injectedItems: QueuedAgentMessage[],
	preparedRequest: PreparedAgentRequest | undefined,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const injectedMessages = injectedItems.map((item) => item.message);
	const newMessages = injectedMessages.slice();
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...injectedMessages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	if (injectedItems.length > 0) {
		await emit({ type: "queue_delivery", preparationId: preparedRequest?.preparationId, items: injectedItems });
	}
	for (const message of injectedMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn(), preparedRequest);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	preparedFirstRequest?: PreparedAgentRequest,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Consecutive turns recovered from an output-limit truncation that yielded no tool call.
	// Reset by any turn that produces a tool call or stops for any other reason.
	let consecutiveTruncations = 0;
	// Lowest reasoning level the truncation recovery has asked for, kept across turns. Hosts commonly
	// re-assert their session thinking level from prepareNextTurn on every single turn (coding-agent's
	// AgentSession does), which would otherwise undo each step-down as soon as it was taken and pin the
	// recovery to its first rung forever.
	let truncationFloor: ThinkingLevel | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = preparedFirstRequest ? [] : (await config.getSteeringMessages?.()) || [];
	let preparedRequest = preparedFirstRequest;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			if (!preparedRequest) {
				preparedRequest = await prepareAgentRequest(currentContext, config, signal, {
					mode: "dispatch",
					truncationFloor,
				});
				config = { ...config, model: preparedRequest.model, reasoning: preparedRequest.reasoning };
			}
			const control = config.controlRequest?.(
				preparedRequest.budget,
				preparedRequest.requestFingerprint,
				preparedRequest.context,
			);
			if (control?.type === "context_transition" || control?.type === "context_maintenance") {
				await emit({ type: "context_budget", budget: preparedRequest.budget });
				await emit({ type: "agent_end", messages: newMessages, outcome: { type: control.type } });
				return;
			}
			if (control?.type === "failed") {
				await emit({
					type: "agent_end",
					messages: newMessages,
					outcome: { type: "failed", message: control.message },
				});
				return;
			}
			if (control?.type === "save_state") {
				await emit({ type: "message_start", message: control.message });
				await emit({ type: "message_end", message: control.message });
				currentContext = {
					...currentContext,
					messages: [...currentContext.messages, control.message],
					tools: currentContext.tools?.filter((tool) => control.toolNames.includes(tool.name)),
				};
				newMessages.push(control.message);
				config = { ...config, maxTokens: control.maxTokens };
				preparedRequest = await prepareAgentRequest(currentContext, config, signal);
				if (preparedRequest.budget.decision === "context_limit") {
					await emit({ type: "context_budget", budget: preparedRequest.budget });
					await emit({
						type: "agent_end",
						messages: newMessages,
						outcome: { type: "failed", message: control.failureMessage },
					});
					return;
				}
			}
			// Stream assistant response
			const message = await streamAssistantResponse(
				currentContext,
				config,
				signal,
				emit,
				streamFunction,
				preparedRequest,
			);
			preparedRequest = undefined;
			if ("decision" in message) {
				await emit({
					type: "agent_end",
					messages: newMessages,
					outcome: { type: "context_limit", budget: message },
				});
				return;
			}
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			let nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					maxTokens: nextTurnSnapshot.maxTokens ?? config.maxTokens,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
				// A step-down already paid for by a truncated turn must not be raised again by the host's
				// routine per-turn refresh, or the recovery below can never get past its first rung.
				if (truncationFloor !== undefined) {
					config = { ...config, reasoning: lowerThinkingLevel(config.reasoning, truncationFloor) };
				}
			}

			nextTurnContext = { ...nextTurnContext, context: currentContext };
			const turnControl = await config.afterTurnControl?.(nextTurnContext);
			if (turnControl?.type === "context_transition") {
				await emit({ type: "agent_end", messages: newMessages, outcome: { type: "context_transition" } });
				return;
			}
			if (turnControl?.type === "failed") {
				await emit({
					type: "agent_end",
					messages: newMessages,
					outcome: { type: "failed", message: turnControl.message },
				});
				return;
			}
			if (turnControl?.type === "continue") {
				if (turnControl.update) {
					currentContext = turnControl.update.context ?? currentContext;
					config = {
						...config,
						model: turnControl.update.model ?? config.model,
						maxTokens: turnControl.update.maxTokens ?? config.maxTokens,
						reasoning:
							turnControl.update.thinkingLevel === undefined
								? config.reasoning
								: turnControl.update.thinkingLevel === "off"
									? undefined
									: turnControl.update.thinkingLevel,
					};
				}
				for (const controlMessage of turnControl.messages ?? []) {
					await emit({ type: "message_start", message: controlMessage });
					await emit({ type: "message_end", message: controlMessage });
					currentContext.messages.push(controlMessage);
					newMessages.push(controlMessage);
				}
				pendingMessages = (await config.getSteeringMessages?.()) || [];
				hasMoreToolCalls = true;
				continue;
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];

			// An output-limit truncation that produced no tool call is not the model finishing: it ran out
			// of budget mid-thought. Without this the loop reads "no tool calls" as "nothing left to do" and
			// reports success, which is the worst possible failure shape — a reasoning model that spends its
			// whole budget thinking exits silently having done nothing. Recovery is bounded, and must come
			// after the steering fetch above so the nudge is not overwritten, and after prepareNextTurn
			// above so the host's own config refresh cannot undo the reasoning step-down.
			if (message.stopReason === "length" && toolCalls.length === 0) {
				if (consecutiveTruncations < MAX_CONSECUTIVE_TRUNCATION_RECOVERIES) {
					consecutiveTruncations++;
					pendingMessages.push(createTruncationRecoveryMessage());
					// Retrying at the same reasoning level reproduces the same truncation, so shrink the
					// thinking budget on the way in. Stepping down from the running floor rather than from
					// whatever the host just re-asserted is what lets successive truncations actually descend.
					// Not restored afterwards: a turn that finally lands is evidence the smaller budget fits.
					truncationFloor = degradeThinkingLevel(truncationFloor ?? config.reasoning);
					config = { ...config, reasoning: truncationFloor };
				}
			} else {
				consecutiveTruncations = 0;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	preparedRequest?: PreparedAgentRequest,
): Promise<AssistantMessage | ContextBudget> {
	const request = preparedRequest ?? (await prepareAgentRequest(context, config, signal));
	const { budget } = request;
	await emit({ type: "context_budget", budget });
	if (budget.decision === "context_limit") return budget;
	await emit({
		type: "request_start",
		model: request.model,
		context: request.context,
		reasoning: request.reasoning,
	});

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(request.model.provider) : undefined) || config.apiKey;
	signal?.throwIfAborted();
	if (request.appendOnlyContext && config.appendOnlyContext) {
		config.appendOnlyContext.replaceWith(request.appendOnlyContext);
	}

	const response = await streamFunction(request.model, request.context, {
		...config,
		reasoning: request.reasoning,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				finalMessage.usageContextFingerprint = contextFingerprint(
					{ ...request.context, messages: [...request.usageContextMessages, finalMessage] },
					request.model,
				);
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	finalMessage.usageContextFingerprint = contextFingerprint(
		{ ...request.context, messages: [...request.usageContextMessages, finalMessage] },
		request.model,
	);
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/** Build the exact first provider request without sending it or mutating append-only live state. */
export async function prepareAgentRequest(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	ordinary?: { mode: "dispatch" | "measure"; truncationFloor?: ThinkingLevel },
): Promise<PreparedAgentRequest> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const usageContextMessages = config.projectUsageContext?.(llmMessages) ?? llmMessages;
	const baseRequest = prepareProviderRequest(
		{ systemPrompt: context.systemPrompt, messages: llmMessages, tools: context.tools },
		usageContextMessages,
		config,
		signal,
	);
	if (!ordinary || !config.prepareRequest) return baseRequest;
	return (
		(await config.prepareRequest(
			baseRequest.context,
			async (update) => {
				let reasoning =
					update?.thinkingLevel === undefined
						? config.reasoning
						: update.thinkingLevel === "off"
							? undefined
							: update.thinkingLevel;
				if (ordinary.truncationFloor !== undefined)
					reasoning = lowerThinkingLevel(reasoning, ordinary.truncationFloor);
				return prepareProviderRequest(
					update?.context ?? baseRequest.context,
					baseRequest.usageContextMessages,
					{ ...config, model: update?.model ?? config.model, reasoning },
					signal,
				);
			},
			signal,
			ordinary.mode,
		)) ?? baseRequest
	);
}

/** Measure an already converted candidate without re-entering host transformations. */
function prepareProviderRequest(
	context: Context,
	usageContextMessages: readonly Message[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): PreparedAgentRequest {
	const lastMessage = context.messages[context.messages.length - 1];
	if (!lastMessage) {
		throw new Error("Cannot prepare continuation: final provider context has no messages");
	}
	if (lastMessage.role === "assistant") {
		throw new Error("Cannot prepare continuation from message role: assistant");
	}

	const preparedAppendOnlyContext = config.appendOnlyContext?.fork();
	preparedAppendOnlyContext?.noteModel(config.model.provider, config.model.id);
	let llmContext: Context;
	if (preparedAppendOnlyContext) {
		preparedAppendOnlyContext.syncMessages(context.messages);
		llmContext = preparedAppendOnlyContext.build(context);
	} else {
		llmContext = context;
	}

	llmContext = detachRequestContext(llmContext);
	signal?.throwIfAborted();
	const budgetOptions = {
		outputReserveTokens: config.maxTokens,
		...config.getContextBudgetOptions?.(config.model),
	};
	const budget = calculateContextBudget(config.model, llmContext, budgetOptions);
	return {
		model: config.model,
		context: llmContext,
		budget,
		reasoning: config.reasoning,
		usageContextMessages: detachRequestContext({
			systemPrompt: context.systemPrompt,
			messages: [...usageContextMessages],
			tools: context.tools,
		}).messages,
		requestFingerprint: createProviderRequestFingerprint(llmContext, config.model, {
			reasoning: config.reasoning,
			budget: budgetOptions,
		}),
		appendOnlyContext: preparedAppendOnlyContext,
	};
}

function detachRequestContext(context: Context): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			const snapshot = { ...message };
			snapshot.content = structuredClone(message.content);
			if (snapshot.role === "toolResult" && snapshot.addedToolNames) {
				snapshot.addedToolNames = [...snapshot.addedToolNames];
			}
			return snapshot;
		}),
		tools: context.tools?.map(({ name, description, parameters, constrainedSampling }) => ({
			name,
			description,
			parameters: structuredClone(parameters),
			...(constrainedSampling ? { constrainedSampling: structuredClone(constrainedSampling) } : {}),
		})),
	};
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		let finalArgs = validatedArgs;
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}

			// `beforeToolCall` handlers may mutate `validatedArgs` in place (this is the
			// documented extension-mutation contract). Re-validate against the tool's
			// schema so a handler cannot hand `guardToolCall` or `tool.execute` malformed
			// or unvalidated arguments. `validateToolArguments` also structured-clones the
			// arguments, detaching `finalArgs` from any reference an extension still holds.
			try {
				finalArgs = validateToolArguments(tool, { ...toolCall, arguments: validatedArgs as Record<string, any> });
			} catch (error) {
				return {
					kind: "immediate",
					result: createErrorToolResult(
						`Tool arguments became invalid after extension mutation: ${error instanceof Error ? error.message : String(error)}`,
					),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		if (config.guardToolCall) {
			const guardResult = await config.guardToolCall(
				{
					assistantMessage,
					toolCall,
					args: finalArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (guardResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(guardResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: finalArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
