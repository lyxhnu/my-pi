import {
	SUBAGENT_LIMITS,
	type SubagentControlRecord,
	SubagentError,
	type SubagentMail,
	type SubagentPage,
	type SubagentRun,
} from "./types.ts";

export interface SubagentQueryOptions {
	cursor?: string;
	limit?: number;
}

interface QueryCursor {
	root: string;
	scope: string;
	through: number;
	checksum: string;
	after: number;
}

export interface SubagentRunSummary {
	runId: string;
	agentId: string;
	issuerAgentId: string;
	issuerRunId: string;
	state: SubagentRun["state"];
	createdAt: number;
	startedAt?: number;
	lastActivityAt?: number;
	lastProgressAt?: number;
	finishedAt?: number;
	stage?: string;
	blockingReason?: string;
	error?: string;
	effectsUnknown?: boolean;
	task: { summary: string; bytes: number; incomplete: boolean; contentRef: string };
	result?: { summary: string; bytes: number; incomplete: boolean; contentRef: string };
}

/** Bound UTF-8 content before JSON serialization, without splitting a code point. */
export function contentChunk(
	text: string,
	offset = 0,
	size = 4096,
): {
	text: string;
	nextOffset?: number;
	complete: boolean;
} {
	const buffer = Buffer.from(text);
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > buffer.length ||
		(offset < buffer.length && (buffer[offset] & 0xc0) === 0x80)
	)
		throw new SubagentError("invalid_content_cursor");
	let end = Math.min(offset + size, buffer.length);
	while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
	return {
		text: buffer.subarray(offset, end).toString("utf8"),
		nextOffset: end === buffer.length ? undefined : end,
		complete: end === buffer.length,
	};
}

export function summarizeRun(rootSessionId: string, run: SubagentRun): SubagentRunSummary {
	const task = contentChunk(run.task, 0, 512);
	const result = contentChunk(run.resultSummary ?? "", 0, 512).text;
	return {
		runId: run.runId,
		agentId: run.agentId,
		issuerAgentId: run.issuerAgentId,
		issuerRunId: run.issuerRunId,
		state: run.state,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		lastActivityAt: run.lastActivityAt,
		lastProgressAt: run.lastProgressAt,
		finishedAt: run.finishedAt,
		stage: run.stage === undefined ? undefined : contentChunk(run.stage, 0, 512).text,
		blockingReason: run.blockingReason === undefined ? undefined : contentChunk(run.blockingReason, 0, 512).text,
		error: run.error === undefined ? undefined : contentChunk(run.error, 0, 512).text,
		effectsUnknown: run.effectsUnknown,
		task: {
			summary: task.text,
			bytes: Buffer.byteLength(run.task),
			incomplete: !task.complete,
			contentRef: `${rootSessionId}:task:${run.runId}`,
		},
		result: run.resultRef
			? {
					summary: result,
					bytes: run.resultBytes ?? 0,
					incomplete: Buffer.byteLength(result) !== run.resultBytes,
					contentRef: `${rootSessionId}:result:${run.runId}`,
				}
			: undefined,
	};
}

export function summarizeMail(rootSessionId: string, mail: SubagentMail) {
	const content = contentChunk(mail.message, 0, 512);
	return {
		messageId: mail.messageId,
		senderAgentId: mail.senderAgentId,
		senderRunId: mail.senderRunId,
		targetAgentId: mail.targetAgentId,
		targetRunId: mail.targetRunId,
		kind: mail.kind,
		state: mail.state,
		createdAt: mail.createdAt,
		message: {
			summary: content.text,
			bytes: Buffer.byteLength(mail.message),
			incomplete: !content.complete,
			contentRef: `${rootSessionId}:mail:${mail.messageId}`,
		},
	};
}

/**
 * The selector visits only creation records. It rechecks current visibility and
 * state for each candidate; it never materializes a complete historical index.
 * Cursor scope includes the requesting agent and all query filters.
 */
export function queryControlPage<T>(options: {
	rootSessionId: string;
	scope: string;
	query: SubagentQueryOptions;
	read: () => Iterable<SubagentControlRecord>;
	select: (record: SubagentControlRecord) => T | undefined;
}): SubagentPage<T> {
	const limit = options.query.limit ?? SUBAGENT_LIMITS.defaultPageSize;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUBAGENT_LIMITS.maxPageSize)
		throw new SubagentError("invalid_page_limit");
	let cursor: QueryCursor;
	if (options.query.cursor !== undefined) {
		if (Buffer.byteLength(options.query.cursor) > 2048) throw new SubagentError("invalid_query_cursor");
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(options.query.cursor, "base64url").toString("utf8"));
		} catch {
			throw new SubagentError("invalid_query_cursor");
		}
		if (typeof value !== "object" || value === null) throw new SubagentError("invalid_query_cursor");
		cursor = value as QueryCursor;
		if (
			cursor.root !== options.rootSessionId ||
			cursor.scope !== options.scope ||
			!Number.isSafeInteger(cursor.through) ||
			!Number.isSafeInteger(cursor.after) ||
			cursor.after < 0 ||
			cursor.through <= cursor.after ||
			typeof cursor.checksum !== "string"
		)
			throw new SubagentError("invalid_query_cursor");
	} else {
		cursor = { root: options.rootSessionId, scope: options.scope, through: 0, checksum: "", after: 0 };
		for (const record of options.read()) {
			cursor.through = record.sequence;
			cursor.checksum = record.checksum;
		}
	}
	let boundaryFound = cursor.through === 0;
	const selected: { sequence: number; item: T }[] = [];
	let hasMore = false;
	for (const record of options.read()) {
		if (record.sequence === cursor.through) {
			if (record.checksum !== cursor.checksum) throw new SubagentError("invalid_query_cursor");
			boundaryFound = true;
		}
		if (record.sequence > cursor.through) break;
		if (record.sequence <= cursor.after || hasMore) continue;
		const item = options.select(record);
		if (item === undefined) continue;
		if (selected.length === limit) hasMore = true;
		else selected.push({ sequence: record.sequence, item });
	}
	if (!boundaryFound) throw new SubagentError("invalid_query_cursor");
	const page = (): SubagentPage<T> => ({
		items: selected.map(({ item }) => item),
		hasMore,
		nextCursor: hasMore
			? Buffer.from(JSON.stringify({ ...cursor, after: selected.at(-1)!.sequence })).toString("base64url")
			: undefined,
	});
	// Leave room for the tool envelope. Counting JSON bytes also covers escaping.
	while (
		Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page()) }] })) >
		SUBAGENT_LIMITS.responseBytes - 1024
	) {
		if (selected.length <= 1) throw new SubagentError("query_item_too_large");
		selected.pop();
		hasMore = true;
	}
	return page();
}
