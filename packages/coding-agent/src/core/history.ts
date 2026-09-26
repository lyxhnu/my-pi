import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "@earendil-works/pi-ai";
import { currentContextWindow } from "./context-window.ts";
import { bashExecutionToText, formatTodoStateProjection } from "./messages.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

export const HISTORY_PAGE_TOKENS = 2048;
const SCAN_CHARS = 65536;
const SCAN_ITEMS = 256;
const VISIBILITY_VERSION = 1;

export interface HistoryQuery {
	operation: "list_windows" | "list_items" | "read_item" | "search";
	windowId?: string;
	role?: string;
	toolName?: string;
	toolCallId?: string;
	text?: string;
	entryId?: string;
	todoId?: string;
	blockIndex?: number;
	offset?: number;
	cursor?: string;
	budgetTokens?: number;
	verify?: boolean;
	startEntryId?: string;
}

export interface HistoryBlock {
	blockIndex: number;
	type: string;
	text?: string;
	toolCallId?: string;
	toolName?: string;
	mimeType?: string;
}

export interface HistoryItem {
	entryId: string;
	windowId: string | null;
	timestamp: string;
	role: string;
	toolName?: string;
	toolCallId?: string;
	taskSourceEntryId?: string;
	todoRevision?: string;
	todoItems?: Array<Record<string, unknown>>;
	isError?: boolean;
	blocks: HistoryBlock[];
}

interface HistoryCursor {
	version: number;
	query: string;
	sessionId: string;
	leafId: string;
	windowId: string | null;
	index: number;
	block: number;
	offset: number;
}

export interface HistoryPage {
	source: "session_history";
	items: unknown[];
	exhausted: boolean;
	cursor: string | null;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Derive read fragments from existing window results; never persist a second read ledger. */
export function contextReadFragments(
	manager: SessionManager,
	source: string,
	revision?: string,
): Record<string, unknown>[] {
	const branch = manager.getBranch();
	const window = currentContextWindow(branch);
	const boundary = branch.findIndex(
		(entry) =>
			(entry.type === "context_window" || entry.type === "context_rollover") && entry.windowId === window?.windowId,
	);
	const visibleResults = new Set(
		manager
			.buildSessionContext()
			.messages.flatMap((message) =>
				message.role === "toolResult" &&
				message.content.some((block) => block.type === "text" && block.text === JSON.stringify(message.details))
					? [message.toolCallId]
					: [],
			),
	);
	return branch.slice(boundary + 1).flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return [];
		if (!visibleResults.has(entry.message.toolCallId)) return [];
		const details = entry.message.details;
		if (
			!details ||
			typeof details !== "object" ||
			!("source" in details) ||
			details.source !== source ||
			!("items" in details) ||
			!Array.isArray(details.items)
		)
			return [];
		if (revision !== undefined && (!("revision" in details) || details.revision !== revision)) return [];
		return details.items.filter(
			(item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object",
		);
	});
}

function messageBlocks(message: AgentMessage): HistoryBlock[] {
	if (message.role === "bashExecution") {
		return message.excludeFromContext ? [] : [{ blockIndex: -1, type: "text", text: bashExecutionToText(message) }];
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return [{ blockIndex: -1, type: "text", text: message.summary }];
	}
	if (
		message.role === "toolResult" &&
		["memory_get", "memory_search", "history", "context_note"].includes(message.toolName)
	)
		return [];
	if (typeof message.content === "string") return [{ blockIndex: -1, type: "text", text: message.content }];
	const blocks = message.content.flatMap((block, blockIndex): HistoryBlock[] => {
		if (block.type === "text") return [{ blockIndex, type: "text", text: block.text }];
		if (block.type === "toolCall")
			return [
				{
					blockIndex,
					type: "tool_call",
					text: JSON.stringify(block.arguments),
					toolCallId: block.id,
					toolName: block.name,
				},
			];
		if (block.type === "image") return [{ blockIndex, type: "attachment", mimeType: block.mimeType }];
		return [];
	});
	return blocks;
}

/** A branch-local, rebuildable index. All operations use the same delivered-content projection. */
export class History {
	private manager: SessionManager;
	private path: readonly SessionEntry[] = [];
	private items: HistoryItem[] = [];
	private windowId: string | null = null;
	private pending = new Map<string, Extract<SessionEntry, { type: "pending_delivery" }>>();
	private delivered = new Set<string>();
	private authoritativeToolCalls = new Set<string>();

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	private update(branch: readonly SessionEntry[]): void {
		if (this.path.length > branch.length || this.path.some((entry, index) => entry !== branch[index])) {
			this.path = [];
			this.items = [];
			this.windowId = null;
			this.pending.clear();
			this.delivered.clear();
			this.authoritativeToolCalls.clear();
		}
		for (const entry of branch.slice(this.path.length)) {
			if (entry.type === "context_window" || entry.type === "context_rollover") this.windowId = entry.windowId;
			if (entry.type === "pending_delivery") this.pending.set(entry.deliveryId, entry);
			const deliveries =
				entry.type === "delivery_receipt"
					? [entry.deliveryId]
					: entry.type === "context_rollover_dispatch" && entry.state === "started"
						? (entry.reservedDeliveryIds ?? [])
						: [];
			for (const id of deliveries) {
				const pending = this.pending.get(id);
				if (pending && !this.delivered.has(id)) {
					this.addMessage(pending.id, entry.timestamp, pending.message);
					this.delivered.add(id);
				}
			}
			if (entry.type === "tool_result_source") {
				this.authoritativeToolCalls.add(entry.toolCallId);
				if (!["memory_get", "memory_search", "history", "context_note"].includes(entry.toolName)) {
					this.addMessage(entry.id, entry.timestamp, {
						role: "toolResult",
						toolCallId: entry.toolCallId,
						toolName: entry.toolName,
						content: entry.content,
						details: entry.details,
						isError: entry.isError,
						timestamp: Date.parse(entry.timestamp),
					});
				}
			} else if (
				entry.type === "message" &&
				!(entry.message.role === "toolResult" && this.authoritativeToolCalls.has(entry.message.toolCallId))
			)
				this.addMessage(entry.id, entry.timestamp, entry.message);
			else if (entry.type === "custom_message")
				this.addMessage(entry.id, entry.timestamp, {
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					timestamp: Date.parse(entry.timestamp),
				});
			else if (entry.type === "custom" && entry.customType === "todo-state") {
				const todoItems = Array.isArray(entry.data)
					? entry.data.filter(
							(value): value is Record<string, unknown> => value !== null && typeof value === "object",
						)
					: [];
				this.items.push({
					entryId: entry.id,
					windowId: this.windowId,
					timestamp: entry.timestamp,
					role: "todo",
					todoRevision: digest(todoItems),
					todoItems,
					blocks: [{ blockIndex: -1, type: "text", text: formatTodoStateProjection(entry.data) }],
				});
			}
		}
		this.path = branch.slice();
	}

	private addMessage(entryId: string, timestamp: string, message: AgentMessage): void {
		const blocks = messageBlocks(message);
		if (blocks.length === 0) return;
		this.items.push({
			entryId,
			timestamp,
			windowId: this.windowId,
			role: message.role,
			...(message.role === "user" ? { taskSourceEntryId: entryId } : {}),
			blocks,
			...(message.role === "toolResult"
				? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError }
				: {}),
		});
	}

	/** Used by recovery validation and Note evidence checks, with the same visibility as queries. */
	getItems(): readonly HistoryItem[] {
		this.update(this.manager.getBranch());
		return this.items;
	}

	query(input: HistoryQuery, remainingTokens?: number | null): HistoryPage {
		if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
			throw new Error("History offset must be a nonnegative integer");
		if (input.blockIndex !== undefined && (!Number.isSafeInteger(input.blockIndex) || input.blockIndex < -1))
			throw new Error("Invalid history blockIndex");
		if (input.todoId !== undefined && input.operation !== "read_item")
			throw new Error("todoId is only valid for read_item");
		const budget = Math.min(
			input.budgetTokens ?? HISTORY_PAGE_TOKENS,
			HISTORY_PAGE_TOKENS,
			remainingTokens ?? HISTORY_PAGE_TOKENS,
		);
		if (!Number.isInteger(budget) || budget < 128)
			throw new Error("Insufficient history read budget (minimum 128 tokens)");
		const branch = this.manager.getBranch();
		const { cursor: encoded, budgetTokens: _budget, verify: _verify, ...conditions } = input;
		const query = digest(conditions);
		let cursor: HistoryCursor = {
			version: VISIBILITY_VERSION,
			query,
			sessionId: this.manager.getSessionId(),
			leafId: branch.at(-1)?.id ?? "",
			windowId: currentContextWindow(branch)?.windowId ?? null,
			index: 0,
			block: 0,
			offset: input.offset ?? 0,
		};
		if (encoded !== undefined) {
			try {
				cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as HistoryCursor;
			} catch {
				throw new Error("Invalid history cursor");
			}
			if (
				cursor.version !== VISIBILITY_VERSION ||
				cursor.query !== query ||
				cursor.sessionId !== this.manager.getSessionId() ||
				cursor.windowId !== (currentContextWindow(branch)?.windowId ?? null) ||
				!branch.some((entry) => entry.id === cursor.leafId) ||
				![cursor.index, cursor.block, cursor.offset].every((value) => Number.isSafeInteger(value) && value >= 0)
			)
				throw new Error("History cursor does not match this branch and query");
		}
		const cutoff = branch.findIndex((entry) => entry.id === cursor.leafId);
		this.update(branch.slice(0, cutoff + 1));
		const start =
			input.startEntryId === undefined ? 0 : this.items.findIndex((item) => item.entryId === input.startEntryId);
		if (start < 0) throw new Error("History start item is not visible");
		const items = this.items
			.slice(start)
			.filter(
				(item) =>
					(input.windowId === undefined || item.windowId === input.windowId) &&
					(input.role === undefined || item.role === input.role) &&
					(input.toolName === undefined ||
						item.toolName === input.toolName ||
						item.blocks.some((block) => block.toolName === input.toolName)) &&
					(input.toolCallId === undefined ||
						item.toolCallId === input.toolCallId ||
						item.blocks.some((block) => block.toolCallId === input.toolCallId)) &&
					(input.entryId === undefined || item.entryId === input.entryId),
			);
		const result: HistoryPage = { source: "session_history", items: [], exhausted: false, cursor: null };
		const encode = () => Buffer.from(JSON.stringify(cursor)).toString("base64url");
		const fits = (item: unknown, next: Partial<HistoryCursor> = {}) =>
			estimateTextTokens(
				JSON.stringify({
					...result,
					items: [...result.items, item],
					cursor: Buffer.from(JSON.stringify({ ...cursor, ...next })).toString("base64url"),
				}),
			) <= budget;
		if (input.operation === "list_windows") {
			const windows = new Map<
				string | null,
				{
					windowId: string | null;
					previousWindowId?: string | null;
					timestamp: string;
					startEntryId: string;
					endEntryId: string;
				}
			>();
			for (const entry of branch.slice(0, cutoff + 1)) {
				if (
					(entry.type === "context_window" || entry.type === "context_rollover") &&
					(input.windowId === undefined || input.windowId === entry.windowId)
				)
					windows.set(entry.windowId, {
						windowId: entry.windowId,
						previousWindowId: entry.previousWindowId,
						timestamp: entry.timestamp,
						startEntryId: entry.id,
						endEntryId: entry.id,
					});
			}
			for (const item of items) {
				const existing = windows.get(item.windowId);
				if (existing) existing.endEntryId = item.entryId;
				else
					windows.set(item.windowId, {
						windowId: item.windowId,
						timestamp: item.timestamp,
						startEntryId: item.entryId,
						endEntryId: item.entryId,
					});
			}
			const values = [...windows.values()];
			while (
				cursor.index < values.length &&
				result.items.length < SCAN_ITEMS &&
				fits(values[cursor.index], { index: cursor.index + 1 })
			)
				result.items.push(values[cursor.index++]);
			result.exhausted = cursor.index === values.length;
		} else if (input.operation === "list_items") {
			while (cursor.index < items.length && result.items.length < SCAN_ITEMS) {
				const item = items[cursor.index];
				const { text, ...block } = item.blocks[cursor.block];
				const { blocks: _blocks, todoItems: _todoItems, ...itemMetadata } = item;
				const metadata = { ...itemMetadata, blocks: [{ ...block, characters: text?.length }] };
				if (!fits(metadata, { index: cursor.index + 1, block: cursor.block + 1 })) break;
				result.items.push(metadata);
				if (++cursor.block === item.blocks.length) {
					cursor.index++;
					cursor.block = 0;
				}
			}
			result.exhausted = cursor.index === items.length;
		} else if (input.operation === "read_item") {
			const item = items.find((value) => value.entryId === input.entryId);
			if (!item) throw new Error("History item is not visible on this branch");
			if (input.todoId !== undefined) {
				if (item.role !== "todo" || item.todoItems === undefined || item.todoRevision === undefined)
					throw new Error("todoId is only valid for a todo-state entry");
				const todo = item.todoItems.find((value) => value.id === input.todoId);
				if (!todo) throw new Error("Todo item is not present in this revision");
				const text = JSON.stringify(todo);
				const requestedOffset = cursor.offset;
				if (!input.verify) {
					const fragments = contextReadFragments(this.manager, "session_history")
						.filter((fragment) => fragment.entryId === item.entryId && fragment.todoId === input.todoId)
						.sort((a, b) => Number(a.offset) - Number(b.offset));
					for (const fragment of fragments) {
						if (
							typeof fragment.offset === "number" &&
							typeof fragment.end === "number" &&
							fragment.offset <= cursor.offset &&
							fragment.end > cursor.offset
						)
							cursor.offset = fragment.end;
					}
				}
				if (cursor.offset > text.length) throw new Error("History offset exceeds saved Todo");
				let end = Math.min(text.length, cursor.offset + budget * 4);
				const page = () => ({
					entryId: item.entryId,
					windowId: item.windowId,
					role: item.role,
					todoId: input.todoId,
					revision: item.todoRevision,
					text: text.slice(cursor.offset, end),
					offset: cursor.offset,
					end,
					total: text.length,
					unit: "utf16",
					...(requestedOffset < cursor.offset ? { alreadyReadThrough: cursor.offset } : {}),
					savedContentOnly: true,
				});
				while (end > cursor.offset && !fits(page(), { offset: end })) end--;
				if (end > cursor.offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
				if (!fits(page(), { offset: end }) || (end === cursor.offset && end < text.length))
					throw new Error("History Todo metadata exceeds read budget");
				result.items.push(page());
				cursor.offset = end;
				result.exhausted = end === text.length;
			} else {
				const block =
					input.blockIndex === undefined && item.blocks.length === 1
						? item.blocks[0]
						: item.blocks.find((value) => value.blockIndex === input.blockIndex);
				if (!block) throw new Error("Specify a readable blockIndex");
				const text = block.text ?? "";
				const requestedOffset = cursor.offset;
				if (!input.verify) {
					const fragments = contextReadFragments(this.manager, "session_history")
						.filter((fragment) => fragment.entryId === item.entryId && fragment.blockIndex === block.blockIndex)
						.sort((a, b) => Number(a.offset) - Number(b.offset));
					for (const fragment of fragments) {
						if (
							typeof fragment.offset === "number" &&
							typeof fragment.end === "number" &&
							fragment.offset <= cursor.offset &&
							fragment.end > cursor.offset
						)
							cursor.offset = fragment.end;
					}
				}
				if (cursor.offset > text.length) throw new Error("History offset exceeds saved text");
				let end = Math.min(text.length, cursor.offset + budget * 4);
				const page = () => ({
					entryId: item.entryId,
					windowId: item.windowId,
					timestamp: item.timestamp,
					role: item.role,
					blockIndex: block.blockIndex,
					type: block.type,
					mimeType: block.mimeType,
					attachmentRef:
						block.type === "attachment" ? { entryId: item.entryId, blockIndex: block.blockIndex } : undefined,
					offset: cursor.offset,
					end,
					total: text.length,
					unit: "utf16",
					text: text.slice(cursor.offset, end),
					...(requestedOffset < cursor.offset ? { alreadyReadThrough: cursor.offset } : {}),
					savedContentOnly: true,
				});
				while (end > cursor.offset && !fits(page(), { offset: end })) end--;
				if (end > cursor.offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
				if (!fits(page(), { offset: end }) || (end === cursor.offset && end < text.length))
					throw new Error("History metadata exceeds read budget");
				result.items.push(page());
				cursor.offset = end;
				result.exhausted = end === text.length;
			}
		} else {
			if (!input.text || input.text.length > 1024) throw new Error("Search requires 1–1024 literal characters");
			let scanned = 0;
			let visited = 0;
			while (cursor.index < items.length && scanned < SCAN_CHARS && visited < SCAN_ITEMS) {
				visited++;
				const item = items[cursor.index];
				const block = item.blocks[cursor.block];
				if (!block) {
					cursor.index++;
					cursor.block = 0;
					cursor.offset = 0;
					continue;
				}
				const text = block.text ?? "";
				const end = Math.min(text.length, cursor.offset + SCAN_CHARS - scanned);
				const match = text
					.slice(cursor.offset, Math.min(text.length, end + input.text.length - 1))
					.indexOf(input.text);
				if (match >= 0) {
					const offset = cursor.offset + match;
					const hit = {
						entryId: item.entryId,
						windowId: item.windowId,
						blockIndex: block.blockIndex,
						offset,
						snippet: text.slice(Math.max(0, offset - 40), offset + Math.min(input.text.length, 160) + 40),
					};
					if (
						!fits(hit, {
							offset: offset + input.text.length,
							block: cursor.block + 1,
							index: cursor.index + SCAN_ITEMS,
						})
					)
						break;
					result.items.push(hit);
					scanned += match + input.text.length;
					cursor.offset = offset + input.text.length;
				} else {
					scanned += end - cursor.offset;
					cursor.offset = end;
				}
				if (cursor.offset >= text.length) {
					cursor.block++;
					cursor.offset = 0;
				}
			}
			result.exhausted = cursor.index === items.length;
		}
		result.cursor = result.exhausted ? null : encode();
		if (result.items.length === 0 && !result.exhausted && input.operation !== "search")
			throw new Error("History metadata exceeds read budget");
		if (estimateTextTokens(JSON.stringify(result)) > budget) throw new Error("History page exceeds read budget");
		return result;
	}
}
