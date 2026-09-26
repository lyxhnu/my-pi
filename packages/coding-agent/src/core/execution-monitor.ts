import { createHash } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExecutionUpgradeConfig } from "./execution-upgrade.ts";
import type { TodoItem } from "./todo/todo-state.ts";

export interface ExecutionMetrics {
	rounds: number;
	toolCalls: number;
	toolSuccesses: number;
	toolErrors: number;
	repeatedErrors: number;
	roundsSinceReminder: number;
	toolsSinceReminder: number;
	todoCompletionTransitions: number;
	roundsSinceTodoCompletion: number | null;
	todos: { total: number; completed: number; pending: number } | null;
	recentTools: Array<{ name: string; isError: boolean }>;
}

/** Observations only. A successful tool or a todo edit is not proof of task progress. */
export class ExecutionMonitor {
	private rounds = 0;
	private calls = new Map<string, unknown>();
	private finished = new Set<string>();
	private successes = 0;
	private errors = 0;
	private errorsByFingerprint = new Map<string, number>();
	private recent: ExecutionMetrics["recentTools"] = [];
	private observedRounds = 0;
	private observedTools = 0;
	private todoSnapshot: Array<{ id: string } & TodoItem> = [];
	private completions = 0;
	private lastCompletionRound: number | null = null;

	observe(event: AgentEvent): void {
		if (event.type === "tool_execution_start" && !this.calls.has(event.toolCallId)) {
			this.calls.set(event.toolCallId, structuredClone(event.args));
		} else if (event.type === "tool_execution_end" && !this.finished.has(event.toolCallId)) {
			this.finished.add(event.toolCallId);
			if (event.isError) {
				this.errors++;
				const fingerprint = createHash("sha256")
					.update(
						JSON.stringify([event.toolName, normalize(this.calls.get(event.toolCallId)), event.result.content]),
					)
					.digest("hex");
				this.errorsByFingerprint.set(fingerprint, (this.errorsByFingerprint.get(fingerprint) ?? 0) + 1);
			} else this.successes++;
			this.recent.push({ name: event.toolName, isError: event.isError });
			this.recent = this.recent.slice(-5);
		} else if (
			event.type === "turn_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted"
		) {
			this.rounds++;
		}
	}

	observeTodos(snapshot: Array<{ id: string } & TodoItem>): void {
		for (const todo of snapshot) {
			const previous = this.todoSnapshot.find((item) => item.id === todo.id);
			if (previous && previous.status !== "completed" && todo.status === "completed") {
				this.completions++;
				this.lastCompletionRound = this.rounds;
			}
		}
		this.todoSnapshot = structuredClone(snapshot);
	}

	snapshot(): ExecutionMetrics {
		return {
			rounds: this.rounds,
			toolCalls: this.calls.size,
			toolSuccesses: this.successes,
			toolErrors: this.errors,
			repeatedErrors: Math.max(0, ...this.errorsByFingerprint.values()),
			roundsSinceReminder: this.rounds - this.observedRounds,
			toolsSinceReminder: this.calls.size - this.observedTools,
			todoCompletionTransitions: this.completions,
			roundsSinceTodoCompletion: this.lastCompletionRound === null ? null : this.rounds - this.lastCompletionRound,
			todos:
				this.todoSnapshot.length === 0
					? null
					: {
							total: this.todoSnapshot.length,
							completed: this.todoSnapshot.filter((todo) => todo.status === "completed").length,
							pending: this.todoSnapshot.filter(
								(todo) => todo.status === "pending" || todo.status === "in_progress",
							).length,
						},
			recentTools: this.recent.slice(),
		};
	}

	reminderDue(config: ExecutionUpgradeConfig): boolean {
		const metrics = this.snapshot();
		return (
			metrics.roundsSinceReminder >= config.reminderCooldownRounds &&
			(metrics.roundsSinceReminder >= config.reminderRounds ||
				metrics.toolsSinceReminder >= config.reminderToolCalls ||
				metrics.repeatedErrors >= config.reminderRepeatedErrors)
		);
	}

	resetObservation(): void {
		this.observedRounds = this.rounds;
		this.observedTools = this.calls.size;
		this.errorsByFingerprint.clear();
	}
}

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, normalize(item)]),
		);
	return value;
}
