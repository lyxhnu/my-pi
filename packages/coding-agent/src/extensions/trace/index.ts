import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { SessionEntry, SessionTraceEntry } from "../../core/session-manager.ts";

interface TraceTurnView {
	turn: number;
	entries: SessionEntry[];
}

function buildTraceTurns(entries: SessionEntry[]): TraceTurnView[] {
	const turns = new Map<number, TraceTurnView>();
	let activeTurn: number | undefined;
	for (const entry of entries) {
		if (entry.type === "trace") {
			const turn = entry.event.data.turn;
			let view = turns.get(turn);
			if (!view) {
				view = { turn, entries: [] };
				turns.set(turn, view);
			}
			view.entries.push(entry);
			if (entry.event.type === "turn/start") {
				activeTurn = turn;
			} else if (entry.event.type === "turn/end") {
				activeTurn = undefined;
			}
		} else if (activeTurn !== undefined) {
			turns.get(activeTurn)?.entries.push(entry);
		}
	}
	return [...turns.values()].sort((a, b) => a.turn - b.turn);
}

function timestampMs(entry: SessionEntry): number {
	return new Date(entry.timestamp).getTime();
}

function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return `${milliseconds}ms`;
	return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`;
}

function compactText(value: string, maxLength = 72): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function traceSummary(entry: SessionTraceEntry): string {
	const event = entry.event;
	switch (event.type) {
		case "execution/status":
			return `execution/status ${event.data.metrics.rounds} rounds · ${event.data.metrics.toolCalls} tools${event.data.reminder ? " · review reminder" : ""}`;
		case "execution/upgrade":
			return `execution/upgrade ${event.data.outcome.status} · ${event.data.outcome.requested.targetModel} / ${event.data.outcome.requested.thinkingLevel}${event.data.taskId ? ` · task ${event.data.taskId}` : ""}`;
		case "task/request":
			return `task/request ${event.data.taskId} · ${event.data.header.provider}/${event.data.header.model} · thinking ${event.data.header.reasoning ?? "off"}`;
		case "turn/start":
			return `turn/start #${event.data.turn}`;
		case "turn/end":
			return `turn/end ${event.data.outcome?.type ?? event.data.stopReason ?? "unknown"}${event.data.willRetry ? " · retry" : ""}`;
		case "context/budget":
			return `context/budget ${event.data.budget.decision} · ${event.data.budget.tokens} input tokens`;
		case "context/save_state":
			return `context/save_state ${event.data.phase} · ${event.data.samplesUsed} samples · ${event.data.consumedControlTokens} control/${event.data.consumedOutputTokens} output tokens${event.data.reasonCode ? ` · ${event.data.reasonCode}` : ""}`;
		case "context/recovery":
			return `context/recovery ${event.data.phase} · ${event.data.coveredUnits} units · ${event.data.missingCount} missing${event.data.reasonCode ? ` · ${event.data.reasonCode}` : ""}`;
		case "context/rollover":
			return `context/rollover ${event.data.windowId} · ${event.data.cause} · epoch ${event.data.sourceContextEpoch}${event.data.targetContextEpoch === undefined ? "" : `→${event.data.targetContextEpoch}`} · ${event.data.phase} · ${event.data.outcome}${event.data.reasonCode ? ` · ${event.data.reasonCode}` : ""}`;
		case "memory/archive":
			return `memory/archive ${event.data.reason} · ${event.data.written ?? 0} written`;
		case "compaction/summary":
			return `compaction/summary ${event.data.phase} · ${event.data.outcome} · ${event.data.usage?.totalTokens ?? 0} tokens`;
		case "step/start":
			return `step/start #${event.data.step}`;
		case "step/end":
			return `step/end #${event.data.step} · ${event.data.stopReason ?? "unknown"}`;
		case "request/header": {
			const header = event.data.header;
			return `request/header ${header.provider}/${header.model} · thinking ${header.reasoning ?? "off"} · ${header.messages.length} messages · ${header.tools?.length ?? 0} tools`;
		}
		case "assistant/chunk": {
			const chunk = event.data.chunk;
			if (chunk.type === "text_delta" || chunk.type === "thinking_delta") {
				return `assistant/chunk ${chunk.type} ${JSON.stringify(compactText(chunk.delta, 48))}`;
			}
			return `assistant/chunk ${chunk.type}`;
		}
		case "tool/call":
			return `tool/call ${event.data.name}`;
		case "tool/result":
			return `tool/result ${event.data.name} · ${event.data.isError ? "error" : "ok"}`;
		case "task/state":
			return `task/state ${event.data.kind} ${event.data.from ?? "created"} → ${event.data.to}`;
		case "context/task_note":
			return `context/task_note ${event.data.operation ?? "project"} ${event.data.kind === undefined ? "" : `${event.data.kind}/${event.data.key ?? ""}`} · ${event.data.outcome}${event.data.activeCount === undefined ? "" : ` · ${event.data.activeCount} active/${event.data.staleCount ?? 0} stale`}${event.data.reasonCode ? ` · ${event.data.reasonCode}` : ""}`;
	}
}

function messageSummary(entry: Extract<SessionEntry, { type: "message" }>): string {
	const message = entry.message;
	if (message.role === "user") {
		return `user/message ${JSON.stringify(compactText(contentText(message.content, "")))}`;
	}
	if (message.role === "assistant") {
		return `assistant/message ${message.stopReason} ${JSON.stringify(compactText(contentText(message.content, "")))}`;
	}
	if (message.role === "toolResult") {
		return `tool/result-message ${message.toolName} · ${message.isError ? "error" : "ok"}`;
	}
	return `message ${message.role}`;
}

function buildRows(turn: TraceTurnView): Array<{ label: string; entry: SessionEntry }> {
	const start = turn.entries.find(
		(entry): entry is SessionTraceEntry => entry.type === "trace" && entry.event.type === "turn/start",
	);
	const startTime = start ? timestampMs(start) : timestampMs(turn.entries[0]!);
	const stepStarts = new Map<number, number>();
	const toolStarts = new Map<string, number>();
	const rows: Array<{ label: string; entry: SessionEntry }> = [];

	for (const entry of turn.entries) {
		let summary: string;
		let duration = "";
		if (entry.type === "trace") {
			summary = traceSummary(entry);
			if (entry.event.type === "step/start") {
				stepStarts.set(entry.event.data.step, timestampMs(entry));
			} else if (entry.event.type === "step/end") {
				const stepStart = stepStarts.get(entry.event.data.step);
				if (stepStart !== undefined) duration = ` · ${formatElapsed(timestampMs(entry) - stepStart)}`;
			} else if (entry.event.type === "tool/call") {
				toolStarts.set(entry.event.data.callId, timestampMs(entry));
			} else if (entry.event.type === "tool/result") {
				const toolStart = toolStarts.get(entry.event.data.callId);
				if (toolStart !== undefined) duration = ` · ${formatElapsed(timestampMs(entry) - toolStart)}`;
			} else if (entry.event.type === "turn/end") {
				duration = ` · ${formatElapsed(timestampMs(entry) - startTime)}`;
			}
		} else if (entry.type === "message") {
			summary = messageSummary(entry);
		} else {
			continue;
		}
		const offset = Math.max(0, timestampMs(entry) - startTime);
		rows.push({
			label: `${String(rows.length + 1).padStart(3, "0")}  +${formatElapsed(offset).padStart(7)}  ${summary}${duration}`,
			entry,
		});
	}
	return rows;
}

function turnLabel(turn: TraceTurnView): string {
	const traceEntries = turn.entries.filter((entry): entry is SessionTraceEntry => entry.type === "trace");
	const steps = traceEntries.filter((entry) => entry.event.type === "step/start").length;
	const tools = traceEntries.filter((entry) => entry.event.type === "tool/call").length;
	const start = traceEntries.find((entry) => entry.event.type === "turn/start");
	const end = traceEntries.find((entry) => entry.event.type === "turn/end");
	const duration = start && end ? ` · ${formatElapsed(timestampMs(end) - timestampMs(start))}` : " · open";
	return `Turn ${turn.turn} · ${steps} step${steps === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}${duration}`;
}

async function chooseTurn(
	turns: TraceTurnView[],
	args: string,
	ctx: ExtensionCommandContext,
): Promise<TraceTurnView | undefined> {
	const requested = args.trim();
	if (requested === "" || requested === "latest") return turns[turns.length - 1];
	if (requested === "list") {
		const ordered = [...turns].reverse();
		const labels = ordered.map(turnLabel);
		const choice = await ctx.ui.select("Trace turns", labels);
		return choice === undefined ? undefined : ordered[labels.indexOf(choice)];
	}
	const turn = Number(requested);
	if (!Number.isSafeInteger(turn) || turn < 0) return undefined;
	return turns.find((candidate) => candidate.turn === turn);
}

export default function traceExtension(pi: ExtensionAPI): void {
	pi.registerCommand("trace", {
		description: "Inspect the latest agent execution trace (/trace list or /trace <turn>)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/trace is available in interactive TUI mode", "warning");
				return;
			}
			const turns = buildTraceTurns(ctx.sessionManager.getBranchWithTrace());
			if (turns.length === 0) {
				ctx.ui.notify("No trace has been recorded on the current branch", "warning");
				return;
			}
			const turn = await chooseTurn(turns, args, ctx);
			if (!turn) {
				ctx.ui.notify(`Trace turn not found: ${args.trim()}`, "warning");
				return;
			}
			const rows = buildRows(turn);
			while (true) {
				const labels = rows.map((row) => row.label);
				const choice = await ctx.ui.select(turnLabel(turn), labels);
				if (choice === undefined) return;
				const row = rows[labels.indexOf(choice)];
				if (!row) return;
				await ctx.ui.editor(
					"Trace event (read-only copy; edits are discarded)",
					JSON.stringify(row.entry, null, 2),
				);
			}
		},
	});
}

export { buildRows, buildTraceTurns, turnLabel };
