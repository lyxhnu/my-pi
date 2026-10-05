import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { convertToLlm } from "../messages.ts";
import { PendingDeliveryStore } from "../pending-delivery.ts";
import type { SessionManager } from "../session-manager.ts";
import { SubagentError } from "./types.ts";

/** Copy completed transactions only; an in-flight delegation is never inherited as work. */
export function committedSubagentContext(messages: AgentMessage[]): AgentMessage[] {
	const source = convertToLlm(structuredClone(messages));
	const result: AgentMessage[] = [];
	for (let index = 0; index < source.length; index++) {
		const message = source[index];
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") {
			result.push(message);
			continue;
		}
		const calls = message.content.filter((part) => part.type === "toolCall");
		if (!calls.length) {
			result.push(message);
			continue;
		}
		let end = index + 1;
		while (source[end]?.role === "toolResult") end++;
		const outputs = source.slice(index + 1, end);
		if (
			outputs.length === calls.length &&
			calls.every((call) => outputs.some((output) => output.role === "toolResult" && output.toolCallId === call.id))
		)
			result.push(message, ...outputs);
		index = end - 1;
	}
	return result;
}

/** Runs under root ownership after old local operations have actually stopped. */
export function recoverSubagentSession(manager: SessionManager): void {
	const pending = new PendingDeliveryStore(manager);
	for (const item of pending.snapshot().items) pending.cancel(item.queueItemId);
	const calls = new Map<string, ToolCall>();
	for (const message of manager.buildSessionContext().messages) {
		if (message.role === "assistant" || message.role === "user") {
			if (calls.size) throw new SubagentError("child_history_incomplete_transaction");
			if (message.role === "assistant")
				for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
		} else if (message.role === "toolResult") calls.delete(message.toolCallId);
	}
	for (const call of calls.values())
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [
				{
					type: "text",
					text: "Execution interrupted when the previous host closed. The result and external effects are unknown; this operation was not replayed.",
				},
			],
			isError: true,
			timestamp: Date.now(),
		});
	manager.flush();
}
