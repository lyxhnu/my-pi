import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PendingDeliveryStore } from "../src/core/pending-delivery.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { committedSubagentContext, recoverSubagentSession } from "../src/core/subagents/session-context.ts";

describe("subagent session context", () => {
	it("copies complete tool batches and excludes in-flight calls and orphan results", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "inspect", timestamp: 0 },
			fauxAssistantMessage([{ type: "toolCall", id: "done", name: "read", arguments: { path: "first" } }]),
			{
				role: "toolResult",
				toolCallId: "done",
				toolName: "read",
				content: [{ type: "text", text: "kept" }],
				isError: false,
				timestamp: 1,
			},
			fauxAssistantMessage([
				{ type: "toolCall", id: "pending", name: "spawn_agent", arguments: {} },
				{ type: "toolCall", id: "partial", name: "read", arguments: {} },
			]),
			{ role: "toolResult", toolCallId: "partial", toolName: "read", content: [], isError: false, timestamp: 2 },
		];
		const snapshot = committedSubagentContext(messages);
		expect(snapshot).toEqual(messages.slice(0, 3));
		expect(snapshot[1]).not.toBe(messages[1]);
		expect(committedSubagentContext(messages.slice(2, 3))).toEqual([]);
	});

	it("cancels old startup queues and appends one unknown result without replacing successful results", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			fauxAssistantMessage([
				{ type: "toolCall", id: "success", name: "read", arguments: {} },
				{ type: "toolCall", id: "unknown", name: "write", arguments: {} },
			]),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "success",
			toolName: "read",
			content: [{ type: "text", text: "real success" }],
			isError: false,
			timestamp: 1,
		});
		const pending = new PendingDeliveryStore(manager);
		pending.enqueue("follow_up", { role: "user", content: "must not replay", timestamp: 2 });
		recoverSubagentSession(manager);
		recoverSubagentSession(manager);
		expect(pending.snapshot().items).toEqual([]);
		const results = manager.buildSessionContext().messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results[0].isError).toBe(false);
		expect(results[1]).toMatchObject({ toolCallId: "unknown", isError: true });
		expect(JSON.stringify(results[1])).toContain("not replayed");
	});
});
