/**
 * Todo list state, aligned with Grok Build's `todo_write` tool
 * (see xai-grok-tools/src/implementations/grok_build/todo/mod.rs):
 * same status set, same merge-by-id semantics, same content/status fallback
 * rules, same duplicate-id rejection.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
	content: string;
	priority: TodoPriority;
	status: TodoStatus;
}

/** A single update from the model. `content`/`status` are optional so partial updates (just flip status) are cheap. */
export interface TodoUpdate {
	id: string;
	content?: string;
	status?: TodoStatus;
}

export class DuplicateTodoIdError extends Error {
	constructor(id: string) {
		super(`Duplicate todo id in response: ${id}`);
		this.name = "DuplicateTodoIdError";
	}
}

/** Throws `DuplicateTodoIdError` if the same id appears twice in one `todo_write` call. */
export function validateNoDuplicateIds(updates: TodoUpdate[]): void {
	const seen = new Set<string>();
	for (const update of updates) {
		if (seen.has(update.id)) {
			throw new DuplicateTodoIdError(update.id);
		}
		seen.add(update.id);
	}
}

function hasNoContent(update: TodoUpdate): boolean {
	return update.content === undefined || update.content.length === 0;
}

/**
 * In-memory, ordered todo list. Preserves insertion order (like Grok's
 * `IndexMap`) so `summarize()` renders items in the order they were first
 * created, not alphabetically/by-status.
 */
export class TodoStateStore {
	private todos = new Map<string, TodoItem>();

	isEmpty(): boolean {
		return this.todos.size === 0;
	}

	entries(): Array<[string, TodoItem]> {
		return [...this.todos.entries()];
	}

	get(id: string): TodoItem | undefined {
		return this.todos.get(id);
	}

	clear(): void {
		this.todos.clear();
	}

	/** Publish an already persisted candidate without changing this store's identity. */
	replaceWith(candidate: TodoStateStore): void {
		this.todos = new Map(candidate.entries().map(([id, item]) => [id, { ...item }]));
	}

	/** Snapshot for session persistence (custom entry payload). */
	toJSON(): Array<{ id: string } & TodoItem> {
		return this.entries().map(([id, item]) => ({ id, ...item }));
	}

	/** Restore from a persisted snapshot (e.g. on session resume/reload). */
	static fromJSON(snapshot: Array<{ id: string } & Partial<TodoItem>>): TodoStateStore {
		const store = new TodoStateStore();
		for (const entry of snapshot) {
			if (!entry.id || !entry.content || !entry.status) continue;
			store.todos.set(entry.id, {
				content: entry.content,
				priority: entry.priority ?? "medium",
				status: entry.status,
			});
		}
		return store;
	}

	/**
	 * `merge=false`: the incoming list fully replaces the existing state.
	 * Missing `content` falls back to `id`; missing `status` defaults to
	 * "pending".
	 */
	applyReplace(updates: TodoUpdate[]): void {
		validateNoDuplicateIds(updates);
		this.todos.clear();
		for (const update of updates) {
			this.todos.set(update.id, {
				content: hasNoContent(update) ? update.id : (update.content as string),
				priority: "medium",
				status: update.status ?? "pending",
			});
		}
	}

	/**
	 * `merge=true` (default): updates are merged into the existing state by
	 * id. Existing items can omit `content` to change only `status`. New
	 * items (id not yet tracked) fall back to using `id` as `content` when
	 * omitted, so a merge call never errors due to a missing field.
	 */
	applyMerge(updates: TodoUpdate[]): void {
		validateNoDuplicateIds(updates);
		for (const update of updates) {
			const existing = this.todos.get(update.id);
			if (existing) {
				this.todos.set(update.id, {
					content: update.content ?? existing.content,
					priority: existing.priority,
					status: update.status ?? existing.status,
				});
				continue;
			}
			this.todos.set(update.id, {
				content: hasNoContent(update) ? update.id : (update.content as string),
				priority: "medium",
				status: update.status ?? "pending",
			});
		}
	}

	/** True if any tracked item is still pending or in_progress. */
	hasPendingWork(): boolean {
		for (const item of this.todos.values()) {
			if (item.status === "pending" || item.status === "in_progress") return true;
		}
		return false;
	}

	private static readonly STATUS_TAG: Record<TodoStatus, string> = {
		pending: "[pending]",
		in_progress: "[in_progress]",
		completed: "[completed]",
		cancelled: "[cancelled]",
	};

	/** Grok-aligned display format, one line per item: "- [status] id: content". */
	summarize(): string {
		if (this.isEmpty()) return "No tasks currently tracked.";
		return this.entries()
			.map(([id, item]) => `- ${TodoStateStore.STATUS_TAG[item.status]} ${id}: ${item.content}`)
			.join("\n");
	}
}
