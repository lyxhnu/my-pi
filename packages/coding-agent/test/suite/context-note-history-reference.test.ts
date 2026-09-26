import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { History } from "../../src/core/history.ts";
import { createHarness } from "./harness.ts";

describe("History references in task Notes", () => {
	it.each(["todo", "user"])("accepts the exact whole-text %s reference returned by History", async (sourceRole) => {
		const h = await createHarness({ initialActiveToolNames: ["todo_write", "history", "context_note"] });
		try {
			h.sessionManager.appendMessage({ role: "user", content: "Only verify locally.", timestamp: 1 });
			h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			h.setResponses([
				fauxAssistantMessage(
					fauxToolCall("todo_write", { todos: [{ id: "verify", content: "Verify locally", status: "pending" }] }),
					{ stopReason: "toolUse" },
				),
				() => {
					const item = new History(h.sessionManager)
						.getItems()
						.find((entry) => entry.role === sourceRole && entry.blocks[0]?.blockIndex === -1);
					if (!item) throw new Error("Missing visible Todo source");
					expect(item.blocks[0].blockIndex).toBe(-1);
					return fauxAssistantMessage(
						fauxToolCall("context_note", {
							operation: "upsert",
							kind: "decision",
							key: "verification",
							text: "Continue local verification from the pending task.",
							sourceRefs: [{ entryId: item.entryId, blockIndex: item.blocks[0].blockIndex }],
						}),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage(fauxToolCall("context_note", { operation: "query" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Saved the pending task state."),
			]);
			await h.session.prompt("Record a verification task and preserve its pending state in a Note.");
			const noteResult = h.eventsOfType("tool_execution_end").find((event) => event.toolName === "context_note");
			expect(noteResult?.isError, JSON.stringify(noteResult?.result)).toBe(false);
			expect(
				h.eventsOfType("tool_execution_end").filter((event) => event.toolName === "context_note" && event.isError),
			).toHaveLength(0);
			expect(
				h.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "task-note-event"),
			).toBe(true);
		} finally {
			await h.cleanup();
		}
	});
});
