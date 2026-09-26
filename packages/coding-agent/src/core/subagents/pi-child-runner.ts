/**
 * Runs one built-in subagent (general-purpose / explore / plan) to completion, in-process, by
 * constructing a nested `AgentSession`. This is the actual "child agent" referenced by
 * subagent-coordinator.ts — kept in its own module so the coordinator stays runtime-agnostic (it could,
 * in principle, be swapped for an out-of-process runner without touching TaskManager wiring).
 *
 * NOTE: this module imports `AgentSession` from "../agent-session.ts", which itself imports
 * `SubagentCoordinator` (and, transitively, this module) to build the coordinator it hands to the `task`
 * tool. This import cycle is safe: `AgentSession` is only referenced inside function bodies below, which
 * run long after both modules have finished their initial (synchronous) evaluation.
 */

import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { AgentSession } from "../agent-session.ts";
import type { ExecutionUpgradeConfig, ExecutionUpgradeOutcome } from "../execution-upgrade.ts";
import { convertToLlm } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { WebSearchOperations } from "../tools/web-search.ts";
import { createTraceRequestHeader, type TraceRequestHeader } from "../trace.ts";
import type { BlockedSubagentSubmission, CompletedSubagentSubmission } from "./protocol.ts";
import { createSubagentSubmissionChannel, SUBMIT_SUBAGENT_RESULT_TOOL_NAME } from "./submit-result-tool.ts";

export interface ChildAgentSessionDeps {
	cwd: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	executionUpgrade: ExecutionUpgradeConfig;
	modelRuntime: ModelRuntime;
	resourceLoader: ResourceLoader;
	settingsManager: SettingsManager;
	webSearchOperations?: WebSearchOperations;
	/** Tool names the child is allowed to see at all (capability_mode boundary) and starts with active. */
	activeToolNames: string[];
	systemPrompt: string;
	/** Depth of the child being created; the parent's depth + 1. */
	subagentDepth: number;
	/**
	 * Sandbox profile bound to the child's own bash tool (spec 12: "subagent read-only使用read-only
	 * profile，subagent writer使用workspace profile"). Set by SubagentCoordinator from capability_mode.
	 */
	sandboxProfile: "read-only" | "workspace";
}

/** Builds a fresh, isolated `AgentSession` for a subagent run: its own Agent, transcript, and tool registry. */
function createChildAgentSession(
	deps: ChildAgentSessionDeps,
	submissionChannel: ReturnType<typeof createSubagentSubmissionChannel>,
): AgentSession {
	const activeToolNames = [...deps.activeToolNames, SUBMIT_SUBAGENT_RESULT_TOOL_NAME];
	const agent = new Agent({
		initialState: {
			model: deps.model,
			thinkingLevel: deps.thinkingLevel,
			systemPrompt: deps.systemPrompt,
			tools: [],
		},
		convertToLlm,
		streamFn: async (model, context, options) => deps.modelRuntime.streamSimple(model, context, options),
	});

	return new AgentSession({
		agent,
		// A fresh in-memory session manager: subagent transcripts are not persisted as top-level
		// sessions. Their result is surfaced to the parent via the TaskManager output buffer instead.
		sessionManager: SessionManager.inMemory(),
		settingsManager: deps.settingsManager,
		executionUpgrade: deps.executionUpgrade,
		cwd: deps.cwd,
		modelRuntime: deps.modelRuntime,
		resourceLoader: deps.resourceLoader,
		customTools: [submissionChannel.definition],
		webSearchOperations: deps.webSearchOperations,
		initialActiveToolNames: activeToolNames,
		allowedToolNames: activeToolNames,
		subagentDepth: deps.subagentDepth,
		sandboxProfileOverride: deps.sandboxProfile,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
}

export interface RunPiChildAgentOptions {
	deps: ChildAgentSessionDeps;
	prompt: string;
	signal: AbortSignal;
	onUpgrade?: (outcome: ExecutionUpgradeOutcome, sessionId: string, promptGeneration: number) => void;
	onRequest?: (header: TraceRequestHeader, sessionId: string, promptGeneration: number) => void;
}

export type RunPiChildAgentResult =
	| { status: "completed"; submission: CompletedSubagentSubmission }
	| { status: "blocked"; submission: BlockedSubagentSubmission }
	| {
			status: "failed" | "cancelled";
			errorCode: "missing_submission" | "execution_failed" | "cancelled";
			errorMessage: string;
	  };

/** Runs a subagent to a validated submit_subagent_result call. Never throws. */
export async function runPiChildAgent(options: RunPiChildAgentOptions): Promise<RunPiChildAgentResult> {
	const submissionChannel = createSubagentSubmissionChannel();
	const session = createChildAgentSession(options.deps, submissionChannel);
	session.subscribe((event) => {
		if (event.type === "execution_upgrade")
			options.onUpgrade?.(
				event.outcome,
				session.sessionId,
				session.sessionManager.getLatestContextCoordinates().promptGeneration,
			);
	});
	const unsubscribeRequest = session.agent.subscribe((event) => {
		if (event.type === "request_start")
			options.onRequest?.(
				createTraceRequestHeader(event),
				session.sessionId,
				session.sessionManager.getLatestContextCoordinates().promptGeneration,
			);
	});
	const onAbort = () => session.agent.abort();
	if (options.signal.aborted) onAbort();
	options.signal.addEventListener("abort", onAbort);
	try {
		await session.prompt(options.prompt);
		const state = session.agent.state.runState;
		if (state.status === "idle" && state.lastOutcome && state.lastOutcome.type !== "completed") {
			const outcome = state.lastOutcome;
			return {
				status: outcome.type === "aborted" ? "cancelled" : "failed",
				errorCode: outcome.type === "aborted" ? "cancelled" : "execution_failed",
				errorMessage:
					"message" in outcome && outcome.message ? outcome.message : `${outcome.type}: unable to submit a result`,
			};
		}
		const submission = submissionChannel.getSubmission();
		if (!submission) {
			for (let index = session.messages.length - 1; index >= 0; index--) {
				const message = session.messages[index];
				if (message.role !== "assistant") continue;
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					return {
						status: options.signal.aborted || message.stopReason === "aborted" ? "cancelled" : "failed",
						errorCode:
							options.signal.aborted || message.stopReason === "aborted" ? "cancelled" : "execution_failed",
						errorMessage: message.errorMessage ?? "Subagent execution failed before submitting a result.",
					};
				}
				break;
			}
			return {
				status: "failed",
				errorCode: "missing_submission",
				errorMessage: "Subagent ended without calling submit_subagent_result.",
			};
		}
		return submission.status === "completed"
			? { status: "completed", submission }
			: { status: "blocked", submission };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			status: options.signal.aborted ? "cancelled" : "failed",
			errorCode: options.signal.aborted ? "cancelled" : "execution_failed",
			errorMessage,
		};
	} finally {
		unsubscribeRequest();
		options.signal.removeEventListener("abort", onAbort);
		await session.dispose();
	}
}
