import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ExecutionMonitor } from "../src/core/execution-monitor.ts";
import { executionUpgradeOptions, resolveExecutionUpgradeSettings } from "../src/core/execution-upgrade.ts";

describe("execution observations", () => {
	it("deduplicates tool events and normalizes arguments for repeated errors", () => {
		const monitor = new ExecutionMonitor();
		for (let i = 0; i < 3; i++) {
			const start: AgentEvent = {
				type: "tool_execution_start",
				toolCallId: String(i),
				toolName: "read",
				args: i % 2 ? { offset: 0, path: "file" } : { path: "file", offset: 0 },
			};
			const end: AgentEvent = {
				type: "tool_execution_end",
				toolCallId: String(i),
				toolName: "read",
				result: { content: [{ type: "text", text: "missing" }], details: {} },
				isError: true,
			};
			monitor.observe(start);
			monitor.observe(start);
			monitor.observe(end);
			monitor.observe(end);
		}
		monitor.observe({
			type: "turn_end",
			message: fauxAssistantMessage("error", { stopReason: "error" }),
			toolResults: [],
		});
		expect(monitor.snapshot()).toMatchObject({ rounds: 0, toolCalls: 3, toolErrors: 3, repeatedErrors: 3 });
		monitor.resetObservation();
		expect(monitor.snapshot()).toMatchObject({ toolCalls: 3, repeatedErrors: 0, toolsSinceReminder: 0 });
	});

	it("counts only actual todo completion transitions and labels absent progress", () => {
		const monitor = new ExecutionMonitor();
		expect(monitor.snapshot().todos).toBeNull();
		monitor.observeTodos([{ id: "a", content: "work", priority: "medium", status: "pending" }]);
		monitor.observeTodos([{ id: "a", content: "renamed", priority: "medium", status: "pending" }]);
		expect(monitor.snapshot().todoCompletionTransitions).toBe(0);
		monitor.observeTodos([{ id: "a", content: "renamed", priority: "medium", status: "completed" }]);
		monitor.observeTodos([{ id: "a", content: "renamed", priority: "medium", status: "completed" }]);
		expect(monitor.snapshot().todoCompletionTransitions).toBe(1);
	});

	it("does not offer aliases that map to the same effective reasoning", () => {
		const model = {
			id: "m",
			name: "m",
			api: "test",
			provider: "test",
			baseUrl: "",
			reasoning: true,
			input: ["text"] as "text"[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 10000,
			thinkingLevelMap: { medium: "high", high: "high", xhigh: "max", max: "max" },
		};
		expect(
			executionUpgradeOptions(model, "medium", resolveExecutionUpgradeSettings({ enabled: true }), [model]),
		).toEqual([{ targetModel: "test/m", thinkingLevels: ["xhigh", "max"] }]);
	});
});
