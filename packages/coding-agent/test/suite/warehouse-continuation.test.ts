import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { History } from "../../src/core/history.ts";
import { queryTaskNotes } from "../../src/core/task-note-query.ts";
import { createCodingTools } from "../../src/core/tools/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const fixtureDir = fileURLToPath(new URL("../fixtures/context-window-warehouse", import.meta.url));

const cliImplementation = `#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { DomainError } from './errors.js';
import { WarehouseService } from './warehouse.js';

const eventFile = process.argv[2];
if (!eventFile) throw new Error('Event file path is required');

const warehouse = await WarehouseService.open({ eventFile });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function invalidCommand(message) {
  return new DomainError('INVALID_COMMAND', message);
}

async function execute(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw invalidCommand('Command must be an object');
  }
  switch (command.op) {
    case 'receive': return warehouse.receiveStock(command);
    case 'reserve': return warehouse.createReservation(command);
    case 'commit': return warehouse.commitReservation(command);
    case 'cancel': return warehouse.cancelReservation(command);
    case 'expire': return warehouse.expireDue(command);
    case 'inventory': return warehouse.getInventory(command.sku);
    case 'reservation': return warehouse.getReservation(command.reservationId);
    case 'audit': return warehouse.getAuditLog();
    default: throw invalidCommand('Unknown operation');
  }
}

for await (const line of lines) {
  try {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      throw invalidCommand('Malformed JSON');
    }
    console.log(JSON.stringify({ ok: true, result: await execute(command) }));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    console.log(JSON.stringify({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }));
  }
}
`;

const warehouseEdits = [
	{
		oldText: "return copy(existing.result);",
		newText: "return copy(name === 'receive' ? this.getInventory(args.sku) : existing.result);",
	},
	{
		oldText: "this.checkIdempotency('reserve', args);",
		newText: "const replay = this.replay('reserve', args);\n    if (replay !== undefined) return replay;",
	},
	{
		oldText:
			"const reservation = this.reservations.get(args.reservationId); if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation not found');",
		newText:
			"const replay = this.replay(name, args); if (replay !== undefined) return replay; const reservation = this.reservations.get(args.reservationId); if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation not found');",
	},
	{
		oldText: "this.checkIdempotency('expire', args);",
		newText: "const replay = this.replay('expire', args); if (replay !== undefined) return replay;",
	},
	{
		oldText: `checkIdempotency(name, args) {
    const existing = this.commands.get(args.commandId);
    if (!existing) return;
    if (existing.name !== name || JSON.stringify(existing.args) !== JSON.stringify(args)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'commandId was already used with different arguments');
    throw new ReplayResult(existing.result);
  }`,
		newText: `replay(name, args) {
    const existing = this.commands.get(args.commandId);
    if (!existing) return undefined;
    if (existing.name !== name || JSON.stringify(existing.args) !== JSON.stringify(args)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'commandId was already used with different arguments');
    return copy(existing.result);
  }`,
	},
];

function parsedToolPages(context: Context): Record<string, unknown>[] {
	return context.messages.flatMap((message) => {
		if (message.role !== "toolResult") return [];
		return message.content.flatMap((block): Record<string, unknown>[] => {
			if (block.type !== "text") return [];
			try {
				const value: unknown = JSON.parse(block.text);
				return value !== null && typeof value === "object" ? [value as Record<string, unknown>] : [];
			} catch {
				return [];
			}
		});
	});
}

function itemReference(item: ReturnType<History["getItems"]>[number]) {
	const block = item.blocks.find((candidate) => candidate.type === "text");
	if (!block) throw new Error(`missing text block for ${item.entryId}`);
	return { entryId: item.entryId, blockIndex: block.blockIndex };
}

function copiedWarehouseTools(cwd: string) {
	for (const name of readdirSync(fixtureDir)) {
		cpSync(join(fixtureDir, name), join(cwd, name), { recursive: true });
	}
	return createCodingTools(cwd);
}

describe("warehouse continuation acceptance", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("uses recovered failure Notes to continue a real 18/22 to 22/22 repair", async () => {
		harness = await createHarness({
			persistSession: true,
			tools: copiedWarehouseTools,
			initialActiveToolNames: [
				"read",
				"bash",
				"edit",
				"write",
				"history",
				"context_note",
				"get_context_remaining",
				"new_context",
			],
		});
		const h = harness;
		let failedAttemptEventId = "";
		let sawRecoveredFailureBeforeBusinessRead = false;
		let providerToolNamesAtFirstBusiness: string[] = [];
		let failureReference: { entryId: string; blockIndex: number } | undefined;
		const responses: FauxResponseStep[] = [
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toMatch(/pass\s+18/);
				expect(JSON.stringify(context.messages)).toMatch(/fail\s+4/);
				return fauxAssistantMessage(
					fauxToolCall("new_context", { reason: "Repair the four observed warehouse acceptance failures" }),
					{ stopReason: "toolUse" },
				);
			},
			() => {
				const history = new History(h.sessionManager).getItems();
				const failure = history.find(
					(item) =>
						item.role === "toolResult" &&
						item.toolName === "bash" &&
						item.blocks.some((block) => block.type === "text" && /pass\s+18/.test(block.text ?? "")),
				);
				if (!failure) throw new Error("missing persisted 18/22 failure result");
				const failureRef = itemReference(failure);
				failureReference = failureRef;
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "failed_attempt",
						key: "warehouse-acceptance",
						text: "npm test passed 18 of 22 tests. Failures are both CLI cases, cross-command idempotency conflict, and restarted receive replay after reservations changed inventory.",
						sourceRefs: [failureRef],
						evidenceRefs: [failureRef],
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				fauxToolCall("context_note", {
					operation: "query",
					kind: "failed_attempt",
					key: "warehouse-acceptance",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const failedAttempt = parsedToolPages(context)
					.flatMap((page) => (Array.isArray(page.items) ? page.items : []))
					.find(
						(item): item is Record<string, unknown> =>
							item !== null &&
							typeof item === "object" &&
							item.type === "note" &&
							typeof item.eventId === "string",
					);
				if (typeof failedAttempt?.eventId !== "string") throw new Error("missing failed-attempt Note event");
				failedAttemptEventId = failedAttempt.eventId;
				const history = new History(h.sessionManager).getItems();
				const task = history.find((item) => item.role === "user");
				const failure = history.find(
					(item) =>
						item.role === "toolResult" &&
						item.toolName === "bash" &&
						item.blocks.some((block) => block.type === "text" && /pass\s+18/.test(block.text ?? "")),
				);
				if (!task || !failure) throw new Error("missing authoritative task or failure source");
				const taskRef = itemReference(task);
				const failureRef = itemReference(failure);
				return fauxAssistantMessage(
					fauxToolCall("context_note", {
						operation: "upsert",
						kind: "next_action",
						key: "current",
						text: "Read src/warehouse.js first, then implement CLI handling and repair idempotency replay; rerun all 22 tests and the syntax check.",
						sourceRefs: [taskRef, failureRef],
						evidenceRefs: [failureRef],
						resume: {
							relatedNotes: [{ kind: "failed_attempt", key: "warehouse-acceptance" }],
							requiredHistoryRefs: [failureRef],
							requirementSourceRefs: [taskRef],
							todoIds: [],
							subagentContinuations: [],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const match = JSON.stringify(context.messages).match(/resume_ref: ([a-f0-9-]{36})/i);
				if (!match) throw new Error("missing visible resume reference");
				return fauxAssistantMessage(fauxToolCall("context_note", { operation: "query", resumeRef: match[1] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const records = parsedToolPages(context).flatMap((page) =>
					Array.isArray(page.items)
						? page.items.filter(
								(item): item is Record<string, unknown> => item !== null && typeof item === "object",
							)
						: [],
				);
				const noteIds = records.flatMap((item) =>
					(item.type === "next_action" || item.type === "related_note") && typeof item.eventId === "string"
						? [item.eventId]
						: [],
				);
				const references = records.flatMap((item) =>
					(item.type === "requirement_source" || item.type === "required_history") &&
					typeof item.entryId === "string"
						? [
								{
									entryId: item.entryId,
									...(typeof item.blockIndex === "number" ? { blockIndex: item.blockIndex } : {}),
								},
							]
						: [],
				);
				if (!noteIds.includes(failedAttemptEventId)) throw new Error("resume page omitted failed-attempt Note");
				return fauxAssistantMessage(
					[
						...noteIds.map((eventId) => fauxToolCall("context_note", { operation: "query", item: eventId })),
						...references.map((reference) =>
							fauxToolCall("history", { operation: "read_item", ...reference, budgetTokens: 512 }),
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				if (!failureReference) throw new Error("missing saved failure reference");
				expect(JSON.stringify(context.messages)).toContain("Recovery is incomplete");
				return fauxAssistantMessage(
					fauxToolCall("history", { operation: "read_item", ...failureReference, budgetTokens: 2048 }),
					{
						stopReason: "toolUse",
					},
				);
			},
			fauxAssistantMessage(
				"The task requirement, next action, failed-attempt Note, and raw 18/22 output are loaded.",
			),
			(context) => {
				const visible = JSON.stringify(context.messages);
				providerToolNamesAtFirstBusiness = context.tools?.map((tool) => tool.name) ?? [];
				sawRecoveredFailureBeforeBusinessRead =
					context.tools?.some((tool) => tool.name === "read") === true &&
					visible.includes("both CLI cases") &&
					visible.includes("Read src/warehouse.js first");
				return fauxAssistantMessage(fauxToolCall("read", { path: "src/warehouse.js" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(
				[
					fauxToolCall("edit", { path: "src/warehouse.js", edits: warehouseEdits }),
					fauxToolCall("write", { path: "src/cli.js", content: cliImplementation }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toMatch(/pass\s+22/);
				expect(JSON.stringify(context.messages)).toMatch(/fail\s+0/);
				return fauxAssistantMessage(fauxToolCall("bash", { command: "npm run check" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Implemented the warehouse service; 22/22 tests and all syntax checks pass."),
		];
		h.setResponses(responses);

		await h.session.prompt(
			"Read README.md and the acceptance tests, finish the warehouse service, run all tests and syntax checks, and report the exact results.",
		);

		expect(sawRecoveredFailureBeforeBusinessRead).toBe(true);
		expect(providerToolNamesAtFirstBusiness).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		expect(h.getPendingResponseCount()).toBe(0);
		const branch = h.sessionManager.getBranch();
		const rollover = branch.find((entry) => entry.type === "context_rollover");
		if (rollover?.type !== "context_rollover") throw new Error("missing warehouse rollover");
		const targetBusinessResults = new History(h.sessionManager)
			.getItems()
			.filter(
				(item) =>
					item.windowId === rollover.windowId &&
					item.role === "toolResult" &&
					item.toolName !== undefined &&
					["read", "edit", "write", "bash"].includes(item.toolName),
			);
		expect(targetBusinessResults[0]?.toolName).toBe("read");
		expect(targetBusinessResults.filter((item) => item.toolName === "bash")).toHaveLength(2);
		expect(targetBusinessResults.every((item) => item.isError !== true)).toBe(true);
		const failedAttempt = queryTaskNotes(h.sessionManager, 1, {
			operation: "query",
			item: failedAttemptEventId,
			verify: true,
		});
		expect(JSON.stringify(failedAttempt)).toContain("passed 18 of 22 tests");
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});
});
