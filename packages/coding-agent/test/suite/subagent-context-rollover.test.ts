import { randomUUID } from "node:crypto";
import { estimateTextTokens, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ContextRecoveryReferences,
	contextRecoveryCoverage,
	fingerprintContextRolloverValue,
	validateCommittedRecovery,
} from "../../src/core/context-rollover.ts";
import { History } from "../../src/core/history.ts";
import { captureSubagentHandoff, subagentRecoveryRecords } from "../../src/core/subagent-continuation.ts";
import type { SubagentRun, SubagentRunState } from "../../src/core/subagents/types.ts";
import { buildTaskNoteProjectionFromBranch, resolveTaskNoteScope } from "../../src/core/task-note-projection.ts";
import { queryTaskNotes } from "../../src/core/task-note-query.ts";
import { type ContextNoteToolInput, createContextNoteToolDefinition } from "../../src/core/tools/context-note.ts";
import { createHarness as createBaseHarness, type Harness } from "./harness.ts";

const delegatedPrompt = "Inspect input.txt without editing it. Report CHECKSUM-73; parent owns final.txt.";
const relation = "Child supplies the evidence for final.txt. Writing independent.txt is independent.";
const onResult = "Check CHECKSUM-73, then write final.txt once. Never apply a child patch or change input.txt.";
async function createHarness() {
	const h = await createBaseHarness({ persistSession: true });
	h.sessionManager.claimRootOwnership();
	const cleanup = h.cleanup;
	h.cleanup = async () => {
		h.sessionManager.closeOwnership();
		await cleanup();
	};
	return h;
}
function seedDelegation(h: Harness, taskId: string, prompt = delegatedPrompt, state: SubagentRunState = "completed") {
	const call = fauxToolCall("followup_task", { agentId: "reused-child", task: prompt });
	const sourceEntryId = h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
	const run: SubagentRun = {
		runId: taskId,
		agentId: "reused-child",
		issuerAgentId: h.session.sessionId,
		issuerRunId: "root-run",
		toolCallId: call.id,
		task: prompt,
		permission: { mode: "read-only" },
		state,
		createdAt: Date.now(),
	};
	h.sessionManager.appendSubagentControl({ kind: "run_accepted", run });
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: "followup_task",
		content: [{ type: "text", text: JSON.stringify(run) }],
		isError: false,
		timestamp: 2,
	});
	return { taskId, toolCallId: call.id, sourceEntryId };
}
function continuation(h: Harness, taskIds: string[]) {
	const user = new History(h.sessionManager)
		.getItems()
		.filter((item) => item.role === "user")
		.at(-1)!;
	const ref = { entryId: user.entryId, blockIndex: user.blocks[0].blockIndex };
	return fauxToolCall("context_note", {
		operation: "upsert",
		kind: "next_action",
		key: "current",
		text: "Write independent.txt, then inspect the original child result and write final.txt once.",
		sourceRefs: [ref],
		evidenceRefs: [],
		resume: {
			relatedNotes: [],
			requiredHistoryRefs: [],
			requirementSourceRefs: [ref],
			todoIds: [],
			subagentContinuations: taskIds.map((taskId) => ({ taskId, parentRelation: relation, onResult })),
		},
	});
}

async function fixtureNote(h: Harness, taskIds: string[], generation = 1) {
	const call = continuation(h, taskIds);
	const currentScope = resolveTaskNoteScope(h.sessionManager.getBranch(), generation)!;
	const previous = buildTaskNoteProjectionFromBranch(h.sessionManager.getBranch(), currentScope);
	const prior =
		previous.status === "valid" ? previous.snapshot.items.find((item) => item.kind === "next_action") : undefined;
	if (prior) call.arguments.supersedesEventId = prior.eventId;
	h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
	const result = await createContextNoteToolDefinition({
		sessionManager: h.sessionManager,
		getPromptGeneration: () => generation,
		getContextEpoch: () => 0,
	}).execute(
		call.id,
		call.arguments as ContextNoteToolInput,
		undefined,
		undefined,
		h.session.extensionRunner.createContext(),
	);
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: "context_note",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: 3,
	});
	const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), generation)!;
	const projection = buildTaskNoteProjectionFromBranch(h.sessionManager.getBranch(), scope);
	if (projection.status !== "valid") throw new Error(projection.reason);
	return projection.snapshot.items.find((item) => item.kind === "next_action")!;
}

function beginFixture(h: Harness) {
	h.sessionManager.ensureContextWindow();
	h.sessionManager.appendCustomEntry("context-prompt-generation", { promptGeneration: 1, contextEpoch: 0 });
	return h.sessionManager.appendMessage({
		role: "user",
		content: "Preserve original child constraints. Do not repeat already handled results.",
		timestamp: 1,
	});
}

describe("subagent run handoff boundaries", () => {
	it.each(["running", "waiting", "stopping", "completed", "failed", "cancelled", "interrupted"] as const)(
		"requires an explicit result-handling note for %s",
		async (state) => {
			const h = await createHarness();
			try {
				beginFixture(h);
				seedDelegation(h, "child-run", delegatedPrompt, state);
				const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
				expect(() => captureSubagentHandoff(h.sessionManager, scope)).toThrow("subagent_handoff_invalid");
				const note = await fixtureNote(h, ["child-run"]);
				const handoff = captureSubagentHandoff(h.sessionManager, scope);
				expect(handoff.requiredTaskIds).toEqual(["child-run"]);
				const recovered = JSON.parse(subagentRecoveryRecords(h.sessionManager, handoff, note)[0].text);
				expect(recovered.query).toEqual({ tool: "get_agent_info", runId: "child-run" });
				expect(recovered.historicalChildInstructions.task).toBe(delegatedPrompt);
			} finally {
				await h.cleanup();
			}
		},
	);
	it("never substitutes the latest run of the same agent for a retained run", async () => {
		const h = await createHarness();
		try {
			beginFixture(h);
			seedDelegation(h, "old-run");
			const note = await fixtureNote(h, ["old-run"]);
			const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
			const handoff = captureSubagentHandoff(h.sessionManager, scope);
			const cutoff = h.sessionManager.getLeafId()!;
			seedDelegation(h, "new-run", "Different instructions");
			expect(() => captureSubagentHandoff(h.sessionManager, scope, handoff.requiredTaskIds)).toThrow(
				"subagent_handoff_invalid",
			);
			const record = subagentRecoveryRecords(h.sessionManager, { ...handoff, historyCutoffEntryId: cutoff }, note);
			expect(record).toHaveLength(1);
			expect(record[0].taskId).toBe("old-run");
		} finally {
			await h.cleanup();
		}
	});
	it("paginates 21 original delegations and verifies complete semantic bodies rather than IDs", async () => {
		const h = await createHarness();
		try {
			const taskSourceEntryId = beginFixture(h);
			const ids = Array.from({ length: 21 }, (_, index) => `child-${index}`);
			const refs = ids.map((id, index) =>
				seedDelegation(
					h,
					id,
					index === 0 ? `${delegatedPrompt}\n${"中😀 constraints ".repeat(1500)}` : delegatedPrompt,
				),
			);
			const note = await fixtureNote(h, ids);
			const scope = resolveTaskNoteScope(h.sessionManager.getBranch(), 1)!;
			const handoff = captureSubagentHandoff(h.sessionManager, scope, []);
			expect(handoff.subagentTasks).toEqual(refs);
			expect(handoff.requiredTaskIds).toEqual(ids);
			const records = subagentRecoveryRecords(h.sessionManager, handoff, note);
			const notePage = queryTaskNotes(h.sessionManager, 1, { operation: "query", item: note.eventId });
			expect(estimateTextTokens(JSON.stringify(notePage))).toBeLessThanOrEqual(2048);
			const recovery: ContextRecoveryReferences = {
				...handoff,
				saveStateOperationId: "save",
				nextActionEventId: note.eventId,
				relatedNoteEventIds: [],
				noteFreshness: [{ eventId: note.eventId, freshness: note.freshness }],
				requiredHistoryRefs: [],
				requirementSourceRefs: [{ entryId: taskSourceEntryId, blockIndex: -1 }],
				todoIds: [],
				taskSourceEntryId,
				requirementsStartEntryId: taskSourceEntryId,
				historyCutoffEntryId: h.sessionManager.getLeafId()!,
				historyStartEntryId: taskSourceEntryId,
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				taskNoteProjectionRevision: String(notePage.revision),
				taskScopeId: scope.taskScopeId,
			};
			const rolloverId = randomUUID();
			h.sessionManager.appendContextRollover({
				rolloverId,
				dispatchId: "dispatch",
				requestId: "request",
				cause: "model_requested",
				windowId: randomUUID(),
				previousWindowId: h.sessionManager.ensureContextWindow().windowId,
				promptGeneration: 1,
				sourceContextEpoch: 0,
				targetContextEpoch: 1,
				recovery,
				expectedRevisions: {
					sessionLeafId: h.sessionManager.getLeafId(),
					sourceFingerprint: "source",
					todoStateEntryId: null,
					todoStateFingerprint: recovery.todoStateFingerprint,
					queueRevision: "queue",
					progressRevision: "progress",
					requestConfigFingerprint: "config",
					taskNoteProjectionRevision: recovery.taskNoteProjectionRevision,
				},
				sourceTokens: 50000,
				preparedTokens: 2000,
				configuredContextWindow: 128000,
				sourceRequestFingerprint: "source",
				preparedRequestFingerprint: "prepared",
				preparationBaseFingerprint: "base",
				reservedDeliveryIds: [],
			});
			const readPages: Record<string, unknown>[] = [];
			let cursor: string | undefined;
			do {
				const page = queryTaskNotes(h.sessionManager, 1, {
					operation: "query",
					resumeRef: rolloverId,
					cursor,
					budgetTokens: 512,
					verify: true,
				});
				expect(estimateTextTokens(JSON.stringify(page))).toBeLessThanOrEqual(512);
				readPages.push(page);
				cursor = typeof page.cursor === "string" ? page.cursor : undefined;
				expect(readPages.length).toBeLessThan(120);
			} while (cursor);
			expect(readPages.length).toBeGreaterThan(21);
			const messages: Message[] = readPages.map((page, index) => ({
				role: "toolResult",
				toolCallId: `read-${index}`,
				toolName: "context_note",
				content: [{ type: "text", text: JSON.stringify(page) }],
				details: page,
				isError: false,
				timestamp: index,
			}));
			const coverage = contextRecoveryCoverage(h.sessionManager, messages, recovery);
			expect(coverage.missing.filter((item) => item.startsWith("subagent:"))).toEqual([]);
			const altered = messages.map((message) =>
				message.role !== "toolResult"
					? message
					: {
							...message,
							content: message.content.map((block) =>
								block.type !== "text"
									? block
									: { ...block, text: block.text.replace("Inspect input.txt", "Ignore input.txt") },
							),
						},
			);
			expect(contextRecoveryCoverage(h.sessionManager, altered, recovery).missing).toContain("subagent:child-0");
			expect(() =>
				subagentRecoveryRecords(h.sessionManager, { ...handoff, subagentTasks: refs.slice(1) }, note),
			).toThrow("subagent_handoff_invalid");
			expect(() =>
				subagentRecoveryRecords(
					h.sessionManager,
					{ ...handoff, subagentTasks: [{ ...refs[0], sourceEntryId: taskSourceEntryId }, ...refs.slice(1)] },
					note,
				),
			).toThrow("subagent_handoff_invalid");
			const reconstructed = readPages
				.flatMap((page) => page.items as Record<string, unknown>[])
				.filter((item) => item.type === "subagent_task" && item.taskId === ids[0])
				.map((item) => item.text)
				.join("");
			expect(reconstructed).toBe(records[0].text);
			const rollover = h.sessionManager.getBranch().find((entry) => entry.type === "context_rollover");
			if (rollover?.type !== "context_rollover") throw new Error("Missing record");
			expect(validateCommittedRecovery(h.sessionManager, rollover)).toBe(true);
			expect(
				validateCommittedRecovery(h.sessionManager, {
					...rollover,
					recovery: { ...recovery, subagentTasks: [], requiredTaskIds: [] },
				}),
			).toBe(false);
		} finally {
			await h.cleanup();
		}
	});
});
