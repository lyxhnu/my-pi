/**
 * Plan Mode state, aligned with Grok's `PermissionMode::Plan` + enter/exit
 * plan tools. Plan mode is a session-level override: while active, the
 * effective PermissionMode is forced to "plan" regardless of settings, and
 * the active tool list is narrowed to read-only tools.
 */

export type PlanModeStatus = "off" | "planning" | "awaiting_approval" | "executing";

export interface PlanStep {
	description: string;
}

export interface PlanArtifact {
	id: string;
	title: string;
	objective: string;
	assumptions: string[];
	steps: string[];
	affected_paths: string[];
	risks: string[];
	verification: string[];
	createdAt: string;
}

export interface PlanModeState {
	status: PlanModeStatus;
	plan?: PlanArtifact;
	/** Active tool names captured before entering plan mode, restored on exit. */
	previousActiveToolNames?: string[];
}

export const OFF_PLAN_MODE_STATE: PlanModeState = { status: "off" };

/** Read-only tool set Plan Mode narrows to, aligned with Grok's plan-mode toolbox (read/grep/find/ls + read-only LSP). */
export const PLAN_MODE_READ_ONLY_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"todo_write",
	"get_task_output",
	"history",
	"get_context_remaining",
	"new_context",
	"context_note",
	"upgrade_execution",
	"spawn_agent",
	"followup_task",
	"send_message",
	"list_agents",
	"get_agent_info",
	"wait_agent",
	"interrupt_agent",
];

export function buildPlanArtifact(input: {
	title: string;
	objective: string;
	assumptions?: string[];
	steps: string[];
	affected_paths?: string[];
	risks?: string[];
	verification?: string[];
}): PlanArtifact {
	return {
		id: crypto.randomUUID(),
		title: input.title,
		objective: input.objective,
		assumptions: input.assumptions ?? [],
		steps: input.steps,
		affected_paths: input.affected_paths ?? [],
		risks: input.risks ?? [],
		verification: input.verification ?? [],
		createdAt: new Date().toISOString(),
	};
}

export function formatPlanArtifact(plan: PlanArtifact): string {
	const lines: string[] = [`# ${plan.title}`, "", `**Objective:** ${plan.objective}`, ""];
	if (plan.assumptions.length > 0) {
		lines.push("**Assumptions:**", ...plan.assumptions.map((a) => `- ${a}`), "");
	}
	lines.push("**Steps:**", ...plan.steps.map((s, i) => `${i + 1}. ${s}`), "");
	if (plan.affected_paths.length > 0) {
		lines.push("**Affected paths:**", ...plan.affected_paths.map((p) => `- ${p}`), "");
	}
	if (plan.risks.length > 0) {
		lines.push("**Risks:**", ...plan.risks.map((r) => `- ${r}`), "");
	}
	if (plan.verification.length > 0) {
		lines.push("**Verification:**", ...plan.verification.map((v) => `- ${v}`));
	}
	return lines.join("\n");
}
