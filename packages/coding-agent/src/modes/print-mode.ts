/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		while (
			session.state.runState.status === "idle" &&
			session.state.runState.lastOutcome?.type === "context_transition"
		) {
			const gate = session.getContextTransitionGate();
			if (gate.status !== "busy") {
				await session.waitForIdle();
				break;
			}
			const activeTaskIds = session.taskManager
				.list()
				.filter((task) => task.kind !== "subagent" && (task.status === "running" || task.status === "cancelling"))
				.map((task) => task.taskId);
			if (activeTaskIds.length === 0) break;
			await Promise.all(activeTaskIds.map((taskId) => session.taskManager.awaitSettled(taskId)));
			// The terminal Task transition queues the deferred rollover in a microtask. Let it start before
			// waiting for the complete session-level continuation, otherwise print mode would dispose the
			// Session in the gap and cancel the Task/rollover it is meant to preserve.
			await Promise.resolve();
			await session.waitForIdle();
		}

		if (session.contextRolloverState.dispatchState === "outcome_unknown") {
			console.error(
				"Context rollover stopped: Provider or tool outcome is unknown. Nothing was replayed automatically; inspect external state before sending a new prompt.",
			);
			return 1;
		}

		if (
			session.state.runState.status === "idle" &&
			session.state.runState.lastOutcome &&
			session.state.runState.lastOutcome.type !== "completed"
		) {
			const outcome = session.state.runState.lastOutcome;
			console.error(
				`${outcome.type}: ${"message" in outcome && outcome.message ? outcome.message : "task not completed; inspect the context/rollover trace for the blocking reason."}`,
			);
			return 1;
		}
		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
					// Ending on a truncated turn is a failure, not an answer: the agent loop only lets a
					// `length` stop be the last word after its truncation retries are spent. Reporting it is
					// what keeps the run from looking like a clean success — a reasoning model that burns its
					// whole output budget thinking leaves no text at all, so without this the process printed
					// nothing and still exited 0, which is indistinguishable from having finished the work.
					// The interactive UI already surfaces this; print mode must not be quieter than the TUI.
					if (assistantMsg.stopReason === "length") {
						console.error(
							"Model stopped at the maximum output token limit and did not recover after retrying with " +
								"a reduced thinking budget. Any response above is incomplete. Try a smaller task, a lower " +
								"thinking level, or a model with a larger output limit.",
						);
						exitCode = 1;
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
