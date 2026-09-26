import type { ContextBudget } from "@earendil-works/pi-ai";

export const STATE_SAVE_OUTPUT_TOKENS = 2048;
// Bounded decision, Todo synchronization and Note saving. Output is reserved separately.
export const STATE_SAVE_CONTROL_TOKENS = 3072;

export interface ContextReadBudgetReservation {
	tokens: number | null;
	settle(usedTokens: number): void;
}

export interface ContextRemaining {
	windowId: string;
	measuredAtEntryId: string | null;
	requestConfigRevision: string;
	inputTokens: number;
	remainingInputTokens: number | null;
	remainingWorkTokens: number | null;
	remainingControlTokens: number | null;
	measurement: "usage_anchored_estimate" | "estimate" | "unknown";
	phase: "normal" | "maintenance" | "decision" | "save_state" | "recovering";
}

export function contextRemaining(
	budget: ContextBudget,
	identity: Pick<ContextRemaining, "windowId" | "measuredAtEntryId" | "requestConfigRevision">,
	thresholdPercent: number,
	phase: ContextRemaining["phase"] = "normal",
	remainingControlTokens?: number | null,
): ContextRemaining {
	const known = budget.unknownFields.length === 0;
	const remainingInputTokens = known
		? Math.max(0, budget.contextWindow - budget.tokens - budget.outputReserveTokens - budget.safetyTokens)
		: null;
	const remainingWorkTokens = known
		? Math.max(
				0,
				Math.min((budget.contextWindow * thresholdPercent) / 100 - budget.tokens, remainingInputTokens!) -
					STATE_SAVE_CONTROL_TOKENS,
			)
		: null;
	return {
		...identity,
		inputTokens: budget.tokens,
		remainingInputTokens,
		remainingWorkTokens: phase === "normal" ? remainingWorkTokens : 0,
		remainingControlTokens:
			phase === "normal"
				? null
				: remainingControlTokens === undefined
					? remainingInputTokens
					: remainingControlTokens,
		measurement: !known ? "unknown" : budget.lastUsageIndex === null ? "estimate" : "usage_anchored_estimate",
		phase:
			phase === "normal" && (budget.decision === "context_limit" || remainingWorkTokens === 0)
				? "maintenance"
				: phase,
	};
}
