import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { TodoStateStore, type TodoUpdate } from "../todo/todo-state.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const todoStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

const todoUpdateSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the todo item" }),
	content: Type.Optional(Type.String({ description: "The description/content of the todo item" })),
	status: Type.Optional(todoStatusSchema),
});

const todoWriteSchema = Type.Object({
	merge: Type.Optional(
		Type.Boolean({
			description:
				"When true (default), merge the provided todos into the existing list by id — send only the items " +
				"you are changing, and to flip status without changing content send just id + status. " +
				"When false, the provided todos replace the existing list.",
		}),
	),
	todos: Type.Array(todoUpdateSchema, { description: "Array of todo items to write to the workspace" }),
});

export type TodoWriteToolInput = Static<typeof todoWriteSchema>;

export interface TodoWriteToolDetails {
	todos: Array<{ id: string; content: string; priority: string; status: string }>;
}

export interface TodoWriteToolOptions {
	/** Store backing this tool instance. Defaults to a fresh in-memory store. Pass one to share/observe state (e.g. for TodoNudge or session persistence). */
	store?: TodoStateStore;
	/**
	 * Persist the candidate snapshot before publishing the mutation to the store. Used by
	 * AgentSession to persist TodoState into a session custom entry (spec 6.4: "session custom entry：
	 * 供resume/reload恢复") so it survives session resume/reload, not just the live process.
	 */
	onChange?: (snapshot: ReturnType<TodoStateStore["toJSON"]>) => void;
}

export function createTodoWriteToolDefinition(
	_cwd: string,
	options?: TodoWriteToolOptions,
): ToolDefinition<typeof todoWriteSchema, TodoWriteToolDetails> {
	const store = options?.store ?? new TodoStateStore();
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Create and manage a structured task list. The user sees this list live — it is your primary way to " +
			"show progress.\n\nUse for any task with 3+ steps. Skip for trivial single-step work.",
		promptSnippet: "Track multi-step work with a visible todo list",
		parameters: todoWriteSchema,
		async execute(_toolCallId, { merge, todos }: { merge?: boolean; todos: TodoUpdate[] }, _signal, _onUpdate, _ctx) {
			const candidate = TodoStateStore.fromJSON(store.toJSON());
			// Throws `DuplicateTodoIdError` on a duplicate id within this call; the
			// agent loop turns that into a normal error tool result (see
			// executePreparedToolCall's catch in packages/agent/src/agent-loop.ts).
			if (merge === false) {
				candidate.applyReplace(todos);
			} else {
				candidate.applyMerge(todos);
			}
			const snapshot = candidate.toJSON();
			options?.onChange?.(snapshot);
			store.replaceWith(candidate);
			return {
				content: [{ type: "text", text: store.summarize() }],
				details: { todos: snapshot },
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args?.todos) ? args.todos.length : 0;
			const mergeSuffix = args?.merge === false ? " (replace)" : "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`todo_write${mergeSuffix} (${count} item${count === 1 ? "" : "s"})`)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text ?? "";
			return new Text(
				text
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n"),
				0,
				0,
			);
		},
	};
}

export function createTodoWriteTool(cwd: string, options?: TodoWriteToolOptions): AgentTool<typeof todoWriteSchema> {
	return wrapToolDefinition(createTodoWriteToolDefinition(cwd, options));
}
