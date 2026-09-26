import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

/**
 * Spec 6: todo_write (not "todo"/"update_todo"/"write_todos") + merge semantics. Hard gate: "Todo
 * duplicate id 未报错" must stay at 0 — see the dedicated assertion below.
 */
describe("todo_write (M9 eval: todo-write)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	const createTodoHarness = () => createHarness({ initialActiveToolNames: ["todo_write"] });

	async function callTodoWrite(harness: Harness, args: Record<string, unknown>) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("update todos");
		return harness.session.messages.filter((m) => m.role === "toolResult").pop();
	}

	it("is registered and active by default under the exact name todo_write", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getAllTools().map((t) => t.name)).toContain("todo_write");
		expect(harness.session.getActiveToolNames()).toContain("todo_write");
	});

	it("merge=true (default): existing items can be updated by status alone, without repeating content", async () => {
		const harness = await createTodoHarness();
		harnesses.push(harness);
		await callTodoWrite(harness, { todos: [{ id: "1", content: "write the spec", status: "pending" }] });
		const result = await callTodoWrite(harness, { todos: [{ id: "1", status: "in_progress" }] });
		expect(getMessageText(result)).toContain("[in_progress] 1: write the spec");
	});

	it("merge=false replaces the whole todo list", async () => {
		const harness = await createTodoHarness();
		harnesses.push(harness);
		await callTodoWrite(harness, { todos: [{ id: "1", content: "old", status: "pending" }] });
		const result = await callTodoWrite(harness, {
			merge: false,
			todos: [{ id: "2", content: "new", status: "pending" }],
		});
		expect(getMessageText(result)).not.toContain("old");
		expect(getMessageText(result)).toContain("new");
	});

	it('reports "No tasks currently tracked." when the list is empty', async () => {
		const harness = await createTodoHarness();
		harnesses.push(harness);
		const result = await callTodoWrite(harness, { merge: false, todos: [] });
		expect(getMessageText(result)).toBe("No tasks currently tracked.");
	});

	it("hard gate: a duplicate id within one call always errors (DuplicateTodoID), never silently merges", async () => {
		const harness = await createTodoHarness();
		harnesses.push(harness);
		const result = await callTodoWrite(harness, {
			todos: [
				{ id: "1", content: "a", status: "pending" },
				{ id: "1", content: "b", status: "pending" },
			],
		});
		expect(result?.role === "toolResult" ? result.isError : undefined).toBe(true);
		expect(getMessageText(result)).toContain("Duplicate todo id");
	});

	it("TodoState survives session resume/reload: it is persisted to a session custom entry (spec 6.4), not just held in memory", async () => {
		const harness = await createTodoHarness();
		harnesses.push(harness);
		await callTodoWrite(harness, {
			todos: [
				{ id: "1", content: "write the spec", status: "in_progress" },
				{ id: "2", content: "ship it", status: "pending" },
			],
		});

		// Simulate resuming this exact session in a fresh process: a brand-new AgentSession built on top
		// of the *same* SessionManager (which by now has the "todo-state" custom entry appended above)
		// must restore TodoState from it on construction, not start from an empty store.
		const resumedAgent = new Agent({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: { model: harness.getModel(), systemPrompt: "resumed", tools: [] },
			convertToLlm,
		});
		const resumed = new AgentSession({
			agent: resumedAgent,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: createTestResourceLoader(),
			memoryRootDir: harness.session.memoryStore.rootDir,
		});
		try {
			const summary = resumed.todoStateStore.summarize();
			expect(summary).toContain("[in_progress] 1: write the spec");
			expect(summary).toContain("[pending] 2: ship it");
		} finally {
			await resumed.dispose();
		}
	});
});
