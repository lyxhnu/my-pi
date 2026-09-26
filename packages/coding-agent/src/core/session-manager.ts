import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	applyRedactions,
	type ShakenIndex,
	type ShakeRedaction,
	WHOLE_TOOL_RESULT,
} from "@earendil-works/pi-agent-core";
import { type ImageContent, type Message, type TextContent, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import type {
	ContextControlCause,
	ContextRecoveryReferences,
	ContextRolloverBlockedReason,
	ContextRolloverRevisions,
	ContextTransitionCause,
} from "./context-rollover.ts";
import {
	type ContextWindowIdentity,
	createContextWindowIdentity,
	currentContextWindow,
	formatContextWindow,
} from "./context-window.ts";
import type { ExecutionUpgradeOutcome } from "./execution-upgrade.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";
import type { SessionTraceEvent } from "./trace.ts";

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

/** Full post-hook tool result retained outside the bounded provider projection. */
export interface ToolResultSourceEntry extends SessionEntryBase {
	type: "tool_result_source";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details: unknown;
	isError: boolean;
}

export type PendingDeliveryChannel = "steering" | "follow_up" | "next_prompt";

export interface PendingDeliveryEntry extends SessionEntryBase {
	type: "pending_delivery";
	deliveryId: string;
	channel: PendingDeliveryChannel;
	message: AgentMessage;
}

export interface DeliveryReceiptEntry extends SessionEntryBase {
	type: "delivery_receipt";
	deliveryId: string;
	preparationId?: string;
}

export interface DeliveryCancelledEntry extends SessionEntryBase {
	type: "delivery_cancelled";
	deliveryId: string;
}

export interface ContextOperationEntry extends SessionEntryBase {
	type: "context_operation";
	operationId: string;
	operationKind: "save_state";
	transitionCause: ContextControlCause;
	state: "started" | "finished";
	windowId: string;
	promptGeneration: number;
	contextEpoch: number;
	sourceFingerprint: string;
	businessCutoffEntryId: string;
	startTaskNoteRevision: string;
	controlBudgetTokens: number;
	outputBudgetTokens: number;
	samplesUsed: number;
	consumedControlTokens: number;
	consumedOutputTokens: number;
	finalTaskNoteRevision?: string;
	nextActionEventId?: string;
	relatedNoteEventIds?: string[];
	noteFreshness?: ContextRecoveryReferences["noteFreshness"];
	requiredHistoryRefs?: Array<{ entryId: string; blockIndex?: number }>;
	requirementSourceRefs?: Array<{ entryId: string; blockIndex?: number }>;
	todoIds?: string[];
	outcome?: string;
}

export interface ContextProgressEntry extends SessionEntryBase {
	type: "context_progress";
	evidenceId: string;
	evidenceKind: "non_read_effect" | "verification" | "task_completed";
	targetFingerprint: string;
	subjectId?: string;
	inputFingerprint?: string;
	resultFingerprint: string;
	outcome: "succeeded" | "failed";
	toolCallId?: string;
	taskId?: string;
}

export interface ContextWindowEntry extends SessionEntryBase, ContextWindowIdentity {
	type: "context_window";
	reason: "initial" | "branch";
}

export interface ContextTransitionRequestEntry extends SessionEntryBase {
	type: "context_transition_request";
	requestId: string;
	windowId: string;
	promptGeneration: number;
	toolCallId: string;
	reason: string;
}

export interface ContextRolloverEntry extends SessionEntryBase, ContextWindowIdentity {
	type: "context_rollover";
	rolloverId: string;
	dispatchId: string;
	promptGeneration: number;
	sourceContextEpoch: number;
	targetContextEpoch: number;
	requestId: string;
	cause: ContextTransitionCause;
	recovery: ContextRecoveryReferences;
	expectedRevisions: ContextRolloverRevisions;
	sourceTokens: number;
	preparedTokens: number;
	configuredContextWindow: number;
	sourceRequestFingerprint: string;
	preparedRequestFingerprint: string;
	preparationBaseFingerprint: string;
	reservedDeliveryIds: string[];
}

export interface ContextRolloverDispatchEntry extends SessionEntryBase {
	type: "context_rollover_dispatch";
	dispatchId: string;
	rolloverId: string;
	state: "started" | "finished" | "blocked" | "cancelled";
	requestFingerprint: string;
	reservedDeliveryIds?: string[];
	outcome?: "completed" | "context_limit" | "context_maintenance" | "context_transition" | "aborted" | "failed";
	reason?: ContextRolloverBlockedReason;
}

/** Log-only execution trace. It is anchored to the current leaf but never becomes a tree node. */
export interface SessionTraceEntry extends SessionEntryBase {
	type: "trace";
	event: SessionTraceEvent;
}

/** Raw archive evidence. It is persisted and branch-anchored, but never becomes a tree node or model message. */
export interface MemoryEvidenceEntry extends SessionEntryBase {
	type: "memory_evidence";
	evidenceEventId: string;
	rootPromptId: string;
	origin: "user" | "runtime" | "extension" | "tool" | "subagent" | "assistant";
	content: string;
	visibility: "session" | "project_rule";
	deliveryState?: "pending" | "delivered";
	completeness?: "complete" | "partial";
	sourceEntryId?: string;
	toolCallId?: string;
	taskId?: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
	/** When present, model and reasoning are a single committed execution profile. */
	thinkingLevel?: string;
	executionUpgrade?: ExecutionUpgradeOutcome;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase, ContextWindowIdentity {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	/** Authoritative requirements retained verbatim outside the summarized prefix. */
	preservedEntryIds?: string[];
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, undefined/false if pi-generated (backward compatible) */
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** Usage from the LLM call that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, false if pi-generated */
	fromHook?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * A mechanical context reduction ("shake"): heavy regions replaced by placeholders.
 *
 * Recorded as its own entry rather than by editing the target entries, because the session log is
 * append-only — an in-place edit would be lost on the next load, and the freed context with it. The
 * redactions are replayed over the target entries in {@link buildContextEntries}.
 */
export interface ShakeEntry extends SessionEntryBase {
	type: "shake";
	redactions: ShakeRedaction[];
	/** Estimated tokens freed, for reporting. */
	tokensSaved: number;
	/** What triggered the shake, for diagnosis. */
	reason: string;
}

export type { ShakeRedaction };

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content is converted to a user message in buildSessionContext().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ToolResultSourceEntry
	| PendingDeliveryEntry
	| DeliveryReceiptEntry
	| DeliveryCancelledEntry
	| ContextOperationEntry
	| ContextProgressEntry
	| ContextRolloverEntry
	| ContextWindowEntry
	| ContextTransitionRequestEntry
	| ContextRolloverDispatchEntry
	| SessionTraceEntry
	| MemoryEvidenceEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| ShakeEntry;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getBranchWithTrace"
	| "buildContextEntries"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/**
 * Finds the most recently appended custom entry of a given `customType` (e.g. "todo-state",
 * "plan-mode-state"), scanning *all* entries regardless of the current branch/leaf — same rationale as
 * getSessionName()'s reverse scan: this is global session state, not something that should vary by
 * which branch happens to be checked out. Returns its `data` payload, or undefined if none was ever
 * written (e.g. a brand-new session).
 */
export function getLatestCustomEntryData<T>(entries: SessionEntry[], customType: string): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === customType) {
			return entry.data as T;
		}
	}
	return undefined;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function isLogOnlyEntry(entry: SessionEntry): entry is SessionTraceEntry | MemoryEvidenceEntry {
	return entry.type === "trace" || entry.type === "memory_evidence";
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	if (!leaf) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (!isLogOnlyEntry(entries[i])) {
				leaf = entries[i];
				break;
			}
		}
	}
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
			if (entry.thinkingLevel !== undefined) thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		return [normalizeContextMessage(entry.message)];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

function normalizeContextMessage(message: AgentMessage): AgentMessage {
	// Session files are parsed without validation; old versions, forks, or
	// hand-edited files can contain messages with null/missing content.
	if (
		(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
		message.content == null
	) {
		return { ...message, content: [] };
	}
	return message;
}

/**
 * Collect every shake redaction recorded along a path, in the order they were made.
 *
 * Order matters only in that a later redaction of the same target wins, which is what makes
 * replaying an accumulated log converge on the same result however many shakes it holds.
 */
export function collectShakeRedactions(path: readonly SessionEntry[]): ShakeRedaction[] {
	const redactions: ShakeRedaction[] = [];
	for (const entry of path) {
		if (entry.type === "shake") redactions.push(...entry.redactions);
	}
	return redactions;
}

/** Index of what a path has already shaken, so a later pass does not re-offer the same regions. */
export function collectShakenIndex(path: readonly SessionEntry[]): ShakenIndex {
	const index = new Map<string, Set<number>>();
	for (const redaction of collectShakeRedactions(path)) {
		const blockIndex = redaction.kind === "toolResult" ? WHOLE_TOOL_RESULT : redaction.blockIndex;
		const existing = index.get(redaction.targetId);
		if (existing) {
			existing.add(blockIndex);
		} else {
			index.set(redaction.targetId, new Set([blockIndex]));
		}
	}
	return index;
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted. Shake redactions
 * recorded on the path are replayed over the surviving entries.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | ContextRolloverEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction" || entry.type === "context_rollover") {
			compaction = entry;
		}
	}

	// Shake redactions are replayed last so they apply to whatever survived compaction. Redactions
	// aimed at entries the compaction dropped simply find no target and are skipped.
	const redactions = collectShakeRedactions(path);

	if (!compaction) {
		return applyRedactions(path, redactions);
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return applyRedactions(path, redactions);
	}

	if (compaction.type === "context_rollover") return applyRedactions(path.slice(compactionIdx), redactions);
	const contextEntries: SessionEntry[] = [compaction];
	const preserved = new Set(compaction.preservedEntryIds);
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept || preserved.has(entry.id)) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return applyRedactions(contextEntries, redactions);
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const pendingByDeliveryId = new Map(
		path
			.filter((entry): entry is PendingDeliveryEntry => entry.type === "pending_delivery")
			.map((entry) => [entry.deliveryId, entry]),
	);
	const projectEntry = (entry: SessionEntry): AgentMessage[] => {
		if (entry.type === "delivery_receipt") {
			const pending = pendingByDeliveryId.get(entry.deliveryId);
			return pending ? [normalizeContextMessage(pending.message)] : [];
		}
		if (entry.type === "context_rollover_dispatch" && entry.state === "started") {
			return (entry.reservedDeliveryIds ?? []).flatMap((deliveryId) => {
				const pending = pendingByDeliveryId.get(deliveryId);
				return pending ? [normalizeContextMessage(pending.message)] : [];
			});
		}
		return sessionEntryToContextMessages(entry);
	};
	const active = buildContextEntries(entries, leafId, byId);
	const rollover = active.find((entry) => entry.type === "context_rollover");
	if (rollover?.type === "context_rollover") {
		return {
			messages: [
				createCustomMessage(
					"context-window",
					formatContextWindow(currentContextWindow(path)!.windowId, rollover.rolloverId),
					false,
					undefined,
					"1970-01-01T00:00:00.000Z",
				),
				...active.filter((entry) => entry !== rollover).flatMap(projectEntry),
			],
			thinkingLevel,
			model,
		};
	}

	const messages = buildContextEntries(entries, leafId, byId).flatMap(projectEntry);
	const identity = currentContextWindow(path);
	if (identity)
		messages.unshift(
			createCustomMessage(
				"context-window",
				formatContextWindow(identity.windowId),
				false,
				undefined,
				"1970-01-01T00:00:00.000Z",
			),
		);
	return { messages, thinkingLevel, model };
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/.
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// Skip malformed lines
		return null;
	}
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (pending.trim() && !finalEntry)
			throw new Error("Session ends with an incomplete record; automatic recovery is unsafe");
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank and malformed lines are skipped to match loadEntriesFromFile().
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a final header without a newline is allowed when it ends
		// exactly at the scan limit. Any additional byte exceeds the bounded scan.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: unreadable or oversized files are not sessions,
		// and one corrupt file must not prevent other sessions from being found.
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeaderForDiscovery(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		// Directory access and stat races make recent-session discovery unavailable.
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);

			// If file was empty, initialize it with a valid session header. If it was
			// non-empty but did not parse as a pi session, fail without modifying it.
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid pi session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			if (!isLogOnlyEntry(entry)) {
				this.leafId = entry.id;
			}
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const mustPersist = this.fileEntries.some(
			(e) =>
				(e.type === "message" && e.message.role === "assistant") ||
				e.type === "tool_result_source" ||
				e.type === "pending_delivery" ||
				e.type === "delivery_receipt" ||
				e.type === "delivery_cancelled" ||
				e.type === "context_operation" ||
				e.type === "context_progress" ||
				e.type === "context_window" ||
				e.type === "context_transition_request" ||
				e.type === "context_rollover" ||
				e.type === "context_rollover_dispatch" ||
				e.type === "compaction" ||
				e.type === "memory_evidence" ||
				(e.type === "custom" && e.customType === "task-note-event") ||
				(e.type === "trace" &&
					e.event.type === "context/budget" &&
					e.event.data.budget.decision === "context_limit"),
		);
		if (!mustPersist) {
			if (this.flushed) {
				appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
			} else {
				// Mark as not flushed so when assistant arrives, all entries get written
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			const fd = openSync(this.sessionFile, "wx");
			let written = false;
			try {
				for (const e of this.fileEntries) {
					writeFileSync(fd, `${JSON.stringify(e)}\n`);
				}
				written = true;
			} finally {
				closeSync(fd);
				if (!written) rmSync(this.sessionFile);
			}
			this.flushed = true;
		} else {
			const fd = openSync(this.sessionFile, "a+");
			const originalSize = fstatSync(fd).size;
			try {
				if (originalSize > 0) {
					const lastByte = Buffer.alloc(1);
					readSync(fd, lastByte, 0, 1, originalSize - 1);
					if (lastByte[0] !== 10) writeFileSync(fd, "\n");
				}
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			} catch (error) {
				ftruncateSync(fd, originalSize);
				throw error;
			} finally {
				closeSync(fd);
			}
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		const previousLeafId = this.leafId;
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		try {
			this._persist(entry);
		} catch (error) {
			this.fileEntries.pop();
			this.byId.delete(entry.id);
			this.leafId = previousLeafId;
			throw error;
		}
	}

	/** Append a log-only trace event anchored to the current leaf without advancing the tree. */
	appendTrace(event: SessionTraceEvent): string {
		const entry: SessionTraceEntry = {
			type: "trace",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			event,
		};
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		try {
			this._persist(entry);
		} catch (error) {
			this.fileEntries.pop();
			this.byId.delete(entry.id);
			throw error;
		}
		return entry.id;
	}

	/** Persist raw archive evidence without advancing the logical conversation tree. */
	appendMemoryEvidence(evidence: Omit<MemoryEvidenceEntry, "type" | "id" | "parentId" | "timestamp">): string {
		const entry: MemoryEvidenceEntry = {
			type: "memory_evidence",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...evidence,
		};
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		try {
			this._persist(entry);
		} catch (error) {
			this.fileEntries.pop();
			this.byId.delete(entry.id);
			throw error;
		}
		return entry.id;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Persist the complete post-hook result before constructing its bounded model-facing message. */
	appendToolResultSource(
		toolCallId: string,
		toolName: string,
		content: (TextContent | ImageContent)[],
		details: unknown,
		isError: boolean,
	): string {
		const entry: ToolResultSourceEntry = {
			type: "tool_result_source",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			toolCallId,
			toolName,
			content: structuredClone(content),
			details: structuredClone(details),
			isError,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Persist a queue item before exposing it to the Agent. */
	appendPendingDelivery(deliveryId: string, channel: PendingDeliveryChannel, message: AgentMessage): string {
		const entry: PendingDeliveryEntry = {
			type: "pending_delivery",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			deliveryId,
			channel,
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Record ordinary queue delivery at the point the message enters Agent context. */
	appendDeliveryReceipt(deliveryId: string, preparationId?: string): string {
		const entry: DeliveryReceiptEntry = {
			type: "delivery_receipt",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			deliveryId,
			preparationId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Persist an explicit queue clear without projecting the message into model context. */
	appendDeliveryCancelled(deliveryId: string): string {
		const entry: DeliveryCancelledEntry = {
			type: "delivery_cancelled",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			deliveryId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendContextOperation(input: Omit<ContextOperationEntry, keyof SessionEntryBase | "type">): string {
		const entry: ContextOperationEntry = {
			type: "context_operation",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...input,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendContextProgress(input: Omit<ContextProgressEntry, keyof SessionEntryBase | "type">): string {
		const entry: ContextProgressEntry = {
			type: "context_progress",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...input,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	ensureContextWindow(): ContextWindowIdentity {
		return currentContextWindow(this.getBranch()) ?? this.startContextWindow("initial");
	}

	startContextWindow(reason: "initial" | "branch"): ContextWindowIdentity {
		const identity = createContextWindowIdentity(this.getBranch());
		this._appendEntry({
			type: "context_window",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			reason,
			...identity,
		});
		return identity;
	}

	requestContextTransition(toolCallId: string, reason: string): string {
		const { windowId } = this.ensureContextWindow();
		const requestId = `${windowId}:${toolCallId}`;
		if (
			!this.getBranch().some((entry) => entry.type === "context_transition_request" && entry.requestId === requestId)
		)
			this._appendEntry({
				type: "context_transition_request",
				id: generateId(this.byId),
				parentId: this.leafId,
				timestamp: new Date().toISOString(),
				requestId,
				windowId,
				promptGeneration: this.getLatestContextCoordinates().promptGeneration,
				toolCallId,
				reason,
			});
		return requestId;
	}

	appendContextRollover(input: Omit<ContextRolloverEntry, keyof SessionEntryBase | "type">): string {
		const entry: ContextRolloverEntry = {
			type: "context_rollover",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...input,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	appendContextRolloverDispatch(input: Omit<ContextRolloverDispatchEntry, keyof SessionEntryBase | "type">): string {
		const entry: ContextRolloverDispatchEntry = {
			type: "context_rollover_dispatch",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...input,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	getLatestContextCoordinates(): { promptGeneration: number; contextEpoch: number } {
		let promptGeneration = 0;
		let contextEpoch = 0;
		for (const entry of this.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === "context-prompt-generation" &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				"promptGeneration" in entry.data &&
				typeof entry.data.promptGeneration === "number"
			) {
				promptGeneration = entry.data.promptGeneration;
				contextEpoch = 0;
			} else if (entry.type === "context_operation") {
				if (entry.promptGeneration > promptGeneration) {
					promptGeneration = entry.promptGeneration;
					contextEpoch = entry.contextEpoch;
				} else if (entry.promptGeneration === promptGeneration) {
					contextEpoch = Math.max(contextEpoch, entry.contextEpoch);
				}
			} else if (entry.type === "context_rollover") {
				if (entry.promptGeneration > promptGeneration) {
					promptGeneration = entry.promptGeneration;
					contextEpoch = entry.targetContextEpoch;
				} else if (entry.promptGeneration === promptGeneration) {
					contextEpoch = Math.max(contextEpoch, entry.targetContextEpoch);
				}
			}
		}
		return { promptGeneration, contextEpoch };
	}

	getContextRolloverState(): {
		windowId: string | null;
		contextEpoch: number;
		rolloverCount: number;
		dispatchState: "none" | "prepared" | "started" | "finished" | "blocked" | "cancelled" | "outcome_unknown";
		dispatchId?: string;
		rolloverId?: string;
		outcome?: ContextRolloverDispatchEntry["outcome"];
	} {
		const branch = this.getBranch();
		const coordinates = this.getLatestContextCoordinates();
		let currentPromptStart = -1;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (
				entry.type === "custom" &&
				entry.customType === "context-prompt-generation" &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				"promptGeneration" in entry.data &&
				entry.data.promptGeneration === coordinates.promptGeneration
			) {
				currentPromptStart = index;
				break;
			}
		}
		const rollovers = branch.filter(
			(entry): entry is ContextRolloverEntry =>
				entry.type === "context_rollover" && entry.promptGeneration === coordinates.promptGeneration,
		);
		const latestRollover = rollovers.at(-1);
		const latestDispatch = branch
			.slice(currentPromptStart + 1)
			.reverse()
			.find(
				(entry): entry is ContextRolloverDispatchEntry =>
					entry.type === "context_rollover_dispatch" &&
					(latestRollover === undefined || entry.dispatchId === latestRollover.dispatchId),
			);
		let dispatchState: ReturnType<SessionManager["getContextRolloverState"]>["dispatchState"] = latestRollover
			? "prepared"
			: "none";
		if (latestDispatch?.state === "started") dispatchState = "outcome_unknown";
		else if (latestDispatch) dispatchState = latestDispatch.state;
		return {
			windowId: currentContextWindow(branch)?.windowId ?? null,
			contextEpoch: coordinates.contextEpoch,
			rolloverCount: rollovers.length,
			dispatchState,
			...(latestDispatch?.state === "finished" ? { outcome: latestDispatch.outcome } : {}),
			...(latestDispatch?.dispatchId === undefined ? {} : { dispatchId: latestDispatch.dispatchId }),
			...(latestDispatch?.rolloverId === undefined
				? latestRollover === undefined
					? {}
					: { rolloverId: latestRollover.rolloverId }
				: { rolloverId: latestDispatch.rolloverId }),
		};
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string, executionUpgrade?: ExecutionUpgradeOutcome): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
			...(executionUpgrade === undefined
				? {}
				: { thinkingLevel: executionUpgrade.requested.thinkingLevel, executionUpgrade }),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
		preservedEntryIds?: string[],
	): string {
		const entry: CompactionEntry<T> = {
			...this.ensureContextWindow(),
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			preservedEntryIds,
			tokensBefore,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a shake record as child of current leaf, then advance leaf. Returns entry id.
	 *
	 * The redactions are not applied to the stored entries; they are replayed by
	 * {@link buildContextEntries} on every context build. See {@link ShakeEntry}.
	 */
	appendShake(redactions: ShakeRedaction[], tokensSaved: number, reason: string): string {
		const entry: ShakeEntry = {
			type: "shake",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			redactions,
			tokensSaved,
			reason,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (!isLogOnlyEntry(entry) && entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * Return the selected logical branch plus trace events from requests anchored to that branch.
	 * The result stays in append order so it can be inspected or exported as a replay timeline.
	 */
	getBranchWithTrace(fromId?: string): SessionEntry[] {
		const branch = this.getBranch(fromId);
		const branchIds = new Set(branch.map((entry) => entry.id));
		const traceTurns = new Set<number>();
		for (const entry of this.getEntries()) {
			if (
				entry.type === "trace" &&
				(entry.event.type === "request/header" || entry.event.type === "context/budget") &&
				entry.parentId !== null &&
				branchIds.has(entry.parentId)
			) {
				traceTurns.add(entry.event.data.turn);
			}
		}
		return this.getEntries().filter(
			(entry) =>
				branchIds.has(entry.id) ||
				(entry.type === "memory_evidence" && (entry.parentId === null || branchIds.has(entry.parentId))) ||
				(entry.type === "trace" &&
					(traceTurns.has(entry.event.data.turn) ||
						(entry.event.type === "memory/archive" &&
							((entry.event.data.compactionId !== undefined && branchIds.has(entry.event.data.compactionId)) ||
								(entry.event.data.sourceEntryId !== undefined &&
									branchIds.has(entry.event.data.sourceEntryId)))) ||
						(entry.event.type === "compaction/summary" && branchIds.has(entry.event.data.firstKeptEntryId)))),
		);
	}

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries().filter((entry) => !isLogOnlyEntry(entry));
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		const entry = this.byId.get(branchFromId);
		if (!entry || isLogOnlyEntry(entry)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		this.startContextWindow("branch");
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null) {
			const branchEntry = this.byId.get(branchFromId);
			if (branchEntry && isLogOnlyEntry(branchEntry)) throw new Error(`Entry ${branchFromId} not found`);
		}
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		this.startContextWindow("branch");
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Keep trace events for requests on the selected branch. Labels are recreated from
		// the resolved map, while logical entries are re-chained around removed labels.
		const logicalPathIds = new Set(path.filter((entry) => entry.type !== "label").map((entry) => entry.id));
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of this.getBranchWithTrace(leafId)) {
			if (entry.type === "label") continue;
			if (isLogOnlyEntry(entry)) {
				pathWithoutLabels.push({
					...entry,
					parentId: entry.parentId !== null && logicalPathIds.has(entry.parentId) ? entry.parentId : pathParentId,
				});
			} else {
				pathWithoutLabels.push({ ...entry, parentId: pathParentId });
				pathParentId = entry.id;
			}
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			let parentId = pathParentId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// Preserve authority records and preflight-only diagnostics on branch export too.
			const hasAssistant = this.fileEntries.some(
				(e) =>
					(e.type === "message" && e.message.role === "assistant") ||
					e.type === "compaction" ||
					e.type === "context_rollover" ||
					e.type === "context_window" ||
					(e.type === "trace" &&
						e.event.type === "context/budget" &&
						e.event.data.budget.decision === "context_limit"),
			);
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			this.startContextWindow("branch");
			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathParentId;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		this.startContextWindow("branch");
		return undefined;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// The bounded scan is only a discovery optimization. A full load remains
				// authoritative for legacy files with very large headers or prefixes.
				preloadedFileEntries = loadEntriesFromFile(resolvedPath);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });

		// Copy all non-header entries from source
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		const fork = new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
		fork.startContextWindow("branch");
		return fork;
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (await listSessionsFromDir(dir, onProgress)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
		);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
		if (customSessionDir) {
			const sessions = await listSessionsFromDir(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}
