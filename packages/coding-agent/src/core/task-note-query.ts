import { estimateTextTokens } from "@earendil-works/pi-ai";
import { currentContextRecoveryReferences, fingerprintContextRolloverValue } from "./context-rollover.ts";
import { currentContextWindow } from "./context-window.ts";
import { contextReadFragments } from "./history.ts";
import type { SessionManager } from "./session-manager.ts";
import { subagentRecoveryRecords } from "./subagent-continuation.ts";
import {
	buildTaskNoteProjectionFromBranch,
	createTaskNoteFreshnessResolver,
	resolveTaskNoteScope,
	resolveTaskNoteScopeByTaskSource,
	type TaskNoteKind,
} from "./task-note-projection.ts";

export interface TaskNoteQuery {
	operation: "query";
	kind?: TaskNoteKind;
	key?: string;
	text?: string;
	item?: string;
	resumeRef?: string;
	taskSourceEntryId?: string;
	cursor?: string;
	budgetTokens?: number;
	verify?: boolean;
}

export function queryTaskNotes(
	manager: SessionManager,
	promptGeneration: number,
	input: TaskNoteQuery,
	remaining?: number | null,
): Record<string, unknown> {
	const branch = manager.getBranch();
	if (input.resumeRef !== undefined && input.taskSourceEntryId !== undefined)
		throw new Error("resumeRef and taskSourceEntryId are mutually exclusive");
	const scope =
		input.taskSourceEntryId === undefined
			? resolveTaskNoteScope(branch, promptGeneration)
			: resolveTaskNoteScopeByTaskSource(branch, input.taskSourceEntryId);
	if (!scope) throw new Error("task_scope_unavailable");
	const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
	if (projection.status !== "valid") throw new Error(projection.reason);
	const budget = Math.min(2048, input.budgetTokens ?? 2048, remaining ?? 2048);
	if (!Number.isInteger(budget) || budget < 128) throw new Error("Insufficient Note read budget");
	const { cursor: encoded, budgetTokens: _budget, verify: _verify, ...conditions } = input;
	const query = fingerprintContextRolloverValue({
		conditions,
		sessionId: manager.getSessionId(),
		windowId: currentContextWindow(branch)?.windowId,
		revision: projection.snapshot.revision,
	});
	let index = 0;
	let offset = 0;
	if (encoded) {
		const cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
			query: string;
			index: number;
			offset: number;
		};
		if (
			cursor.query !== query ||
			![cursor.index, cursor.offset].every((value) => Number.isSafeInteger(value) && value >= 0)
		)
			throw new Error("Note cursor does not match current query and revision");
		index = cursor.index;
		offset = cursor.offset;
	}
	const records: Record<string, unknown>[] = [];
	if (input.resumeRef !== undefined) {
		const rollover = [...branch]
			.reverse()
			.find((entry) => entry.type === "context_rollover" && entry.rolloverId === input.resumeRef);
		if (
			rollover?.type !== "context_rollover" ||
			[...branch].reverse().find((entry) => entry.type === "context_rollover") !== rollover ||
			rollover.recovery.taskScopeId !== scope.taskScopeId
		)
			throw new Error("Resume reference is not applicable to the current task/window");
		const recovery = currentContextRecoveryReferences(manager, rollover.recovery);
		const nextAction = projection.snapshot.items.find((item) => item.eventId === recovery.nextActionEventId);
		if (!nextAction) throw new Error("recovery_reference_invalid");
		records.push(...subagentRecoveryRecords(manager, recovery, nextAction));
		records.push({
			type: "requirements",
			entryId: recovery.taskSourceEntryId,
			operation: "read_item",
			tool: "history",
		});
		records.push({
			type: "effective_requirements",
			tool: "history",
			operation: "list_items",
			role: "user",
			startEntryId: recovery.requirementsStartEntryId,
			instruction:
				"Read applicable task requirements and subsequently delivered user constraints before dependent actions.",
		});
		records.push({
			type: "next_action",
			eventId: nextAction.eventId,
			tool: "context_note",
			operation: "query",
			item: nextAction.eventId,
		});
		for (const eventId of recovery.relatedNoteEventIds) {
			const note = projection.snapshot.items.find((item) => item.eventId === eventId);
			if (!note) throw new Error("recovery_reference_invalid");
			records.push({
				type: "related_note",
				eventId,
				kind: note.kind,
				key: note.key,
				tool: "context_note",
				operation: "query",
				item: eventId,
			});
		}
		for (const reference of recovery.requirementSourceRefs) {
			records.push({ type: "requirement_source", tool: "history", operation: "read_item", ...reference });
		}
		for (const reference of recovery.requiredHistoryRefs) {
			records.push({ type: "required_history", tool: "history", operation: "read_item", ...reference });
		}
		for (const todoId of recovery.todoIds) {
			if (recovery.todoStateEntryId === null) throw new Error("recovery_reference_invalid");
			records.push({
				type: "todo",
				tool: "history",
				operation: "read_item",
				entryId: recovery.todoStateEntryId,
				todoId,
			});
		}
		records.push({
			type: "history",
			cutoffEntryId: recovery.historyCutoffEntryId,
			retrievalStartEntryId: recovery.historyStartEntryId,
		});
	}
	for (const item of projection.snapshot.items) {
		if (
			(input.kind !== undefined && item.kind !== input.kind) ||
			(input.key !== undefined && item.key !== input.key) ||
			(input.text !== undefined && !item.text.includes(input.text)) ||
			(input.item !== undefined && item.eventId !== input.item)
		)
			continue;
		records.push(
			input.item === undefined
				? { type: "note", eventId: item.eventId, kind: item.kind, key: item.key, freshness: item.freshness }
				: {
						type: "note",
						...item,
						...(item.resume
							? {
									resume: {
										relatedNotes: item.resume.relatedNotes,
										requiredHistoryRefs: item.resume.requiredHistoryRefs,
										requirementSourceRefs: item.resume.requirementSourceRefs,
										todoIds: item.resume.todoIds,
									},
									subagentContinuations:
										"Resolve resumeRef and read every subagent_task page for delegation and continuation bodies.",
								}
							: {}),
					},
		);
	}
	if (input.item !== undefined && records.length === 0) throw new Error("Note item is no longer active");
	const result: Record<string, unknown> = {
		source: "task_notes",
		revision: projection.snapshot.revision,
		scope: {
			...scope,
			historical: input.taskSourceEntryId !== undefined && scope.promptGeneration !== promptGeneration,
		},
		items: [],
		exhausted: false,
		cursor: null,
	};
	const items: Record<string, unknown>[] = [];
	const fragments = input.verify ? [] : contextReadFragments(manager, "task_notes", projection.snapshot.revision);
	const encode = (nextIndex = index, nextOffset = offset) =>
		Buffer.from(JSON.stringify({ query, index: nextIndex, offset: nextOffset })).toString("base64url");
	while (index < records.length) {
		const record = records[index];
		if (typeof record.text === "string") {
			const text = record.text;
			for (const fragment of fragments
				.filter(
					(fragment) =>
						fragment.type === record.type &&
						fragment.eventId === record.eventId &&
						fragment.taskId === record.taskId,
				)
				.sort((a, b) => Number(a.offset) - Number(b.offset))) {
				if (
					typeof fragment.offset === "number" &&
					typeof fragment.end === "number" &&
					fragment.offset <= offset &&
					fragment.end > offset
				)
					offset = fragment.end;
			}
			let end = Math.min(text.length, offset + budget * 4);
			const value = () => ({
				...record,
				text: text.slice(offset, end),
				offset,
				end,
				total: text.length,
				unit: "utf16",
			});
			while (
				end > offset &&
				estimateTextTokens(
					JSON.stringify({ ...result, items: [...items, value()], cursor: encode(index + 1, end) }),
				) > budget
			)
				end--;
			if (end > offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
			if (end === offset && end < text.length) break;
			items.push(value());
			offset = end;
			if (end < text.length) break;
			offset = 0;
		} else {
			if (
				estimateTextTokens(JSON.stringify({ ...result, items: [...items, record], cursor: encode(index + 1, 0) })) >
				budget
			)
				break;
			items.push(record);
		}
		index++;
	}
	if (items.length === 0 && index < records.length) throw new Error("Note metadata exceeds read budget");
	const page = {
		...result,
		items,
		exhausted: index === records.length,
		cursor: index === records.length ? null : encode(),
	};
	if (estimateTextTokens(JSON.stringify(page)) > budget) throw new Error("Note page exceeds read budget");
	return page;
}
