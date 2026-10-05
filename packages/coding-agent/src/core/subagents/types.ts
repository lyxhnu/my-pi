import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const SUBAGENT_LIMITS = Object.freeze({
	createdAgents: 8,
	activeRuns: 3,
	queuedRuns: 32,
	queuedBytes: 2 * 1024 * 1024,
	taskBytes: 64 * 1024,
	mailCount: 256,
	mailBytes: 1024 * 1024,
	messageBytes: 16 * 1024,
	responseBytes: 32 * 1024,
	defaultPageSize: 20,
	maxPageSize: 50,
	defaultWaitMs: 30_000,
	maxWaitMs: 3_600_000,
});

export type SubagentPermissionMode = "read-only" | "read-write" | "full";
export interface SubagentPermission {
	mode: SubagentPermissionMode;
}

export type SubagentRootPhase = "opening" | "open" | "closing" | "closed";
export type SubagentRunState =
	| "queued"
	| "initializing"
	| "running"
	| "waiting"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "recovering";
export type SubagentTerminalState = Extract<SubagentRunState, "completed" | "failed" | "cancelled" | "interrupted">;

export function isSubagentTerminal(state: SubagentRunState): state is SubagentTerminalState {
	return state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted";
}

/** Bound by the host for one execution; never accepted from tool arguments. */
export interface SubagentCaller {
	rootSessionId: string;
	agentId: string;
	runId: string;
	permission: SubagentPermission;
}

export interface SubagentIdentity {
	agentId: string;
	sessionId: string;
	rootSessionId: string;
	sessionFile: string;
	creatorAgentId: string;
	creatorRunId: string;
	permission: SubagentPermission;
	cwd: string;
	createdAt: number;
}

export interface SubagentRun {
	runId: string;
	agentId: string;
	issuerAgentId: string;
	issuerRunId: string;
	toolCallId: string;
	task: string;
	permission: SubagentPermission;
	state: SubagentRunState;
	createdAt: number;
	startedAt?: number;
	lastActivityAt?: number;
	lastProgressAt?: number;
	finishedAt?: number;
	stage?: string;
	blockingReason?: string;
	error?: string;
	resultRef?: string;
	resultBytes?: number;
	resultSummary?: string;
	effectsUnknown?: boolean;
}

export interface SubagentMail {
	messageId: string;
	senderAgentId: string;
	senderRunId: string;
	targetAgentId: string;
	targetRunId?: string;
	message: string;
	kind: "information" | "question" | "progress";
	createdAt: number;
	state: "pending" | "delivered" | "undelivered";
}

export type SubagentControlEvent =
	| { kind: "root_phase"; phase: SubagentRootPhase; processId: number }
	| { kind: "agent_created"; agent: SubagentIdentity; run: SubagentRun }
	| { kind: "run_accepted"; run: SubagentRun }
	| { kind: "run_updated"; run: SubagentRun }
	| { kind: "run_finished"; run: SubagentRun & { state: SubagentTerminalState } }
	| { kind: "run_cancelled"; runId: string; scope: "run" | "subtree"; reason: string }
	| { kind: "mail"; mail: SubagentMail }
	| { kind: "updates_read"; agentId: string; through: number }
	| {
			kind: "wait_timed_out";
			agentId: string;
			waiterRunId: string;
			runId: string;
			condition: "result" | "update" | "subtree_stopped";
	  };

export interface SubagentControlRecord {
	type: "subagent_control";
	id: string;
	parentId: string | null;
	timestamp: string;
	rootSessionId: string;
	sequence: number;
	previousChecksum: string;
	control: SubagentControlEvent;
	checksum: string;
}

export type SubagentContextSelection = "all" | "none" | number;
export type SubagentSafePoint = (receive: (mail: SubagentMail) => void, notify: (through: number) => void) => void;
export interface SubagentSpawnInput {
	task: string;
	permission: SubagentPermission;
	context: SubagentContextSelection;
}
export interface SubagentFollowupInput {
	agentId: string;
	task: string;
	permission?: SubagentPermission;
}

/** The coordinator owns this lifetime, including awaited hooks and tools. */
export interface SubagentRuntime {
	readonly sessionId: string;
	readonly processId: number;
	run(
		run: SubagentRun,
		signal: AbortSignal,
		safePoint: SubagentSafePoint,
	): Promise<{ text: string; effectsUnknown?: boolean }>;
	context(selection: SubagentContextSelection): AgentMessage[];
	close(): Promise<void>;
}

export interface SubagentRuntimeFactory {
	recover(agent: SubagentIdentity, pendingMailIds: readonly string[]): Promise<string[]>;
	prepare(agent: SubagentIdentity, context: AgentMessage[], signal: AbortSignal): Promise<void>;
	discard(agent: SubagentIdentity): Promise<void>;
	open(agent: SubagentIdentity, signal: AbortSignal): Promise<SubagentRuntime>;
}

export interface SubagentPage<T> {
	items: T[];
	hasMore: boolean;
	nextCursor?: string;
}

export class SubagentError extends Error {
	readonly code: string;
	constructor(code: string, message = code) {
		super(message);
		this.name = "SubagentError";
		this.code = code;
	}
}
