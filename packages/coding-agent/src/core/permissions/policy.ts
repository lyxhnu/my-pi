import { redactForAudit } from "./audit-log.ts";
import { analyzeBashCommand } from "./command-analyzer.ts";
import { hasSymlinkEscape } from "./path-inspector.ts";
import type { PermissionCheckInput, PermissionCheckResult, PermissionMode, PermissionRule } from "./types.ts";

export type ToolEffect = "read" | "session" | "workspace-write" | "process" | "network" | "external" | "unknown";

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"memory_search",
	"memory_get",
	"get_task_output",
	"history",
	"get_context_remaining",
]);
const SESSION_TOOLS = new Set([
	"todo_write",
	"context_note",
	"new_context",
	"enter_plan_mode",
	"exit_plan_mode",
	"upgrade_execution",
	"spawn_agent",
	"followup_task",
	"send_message",
	"list_agents",
	"get_agent_info",
	"wait_agent",
	"interrupt_agent",
]);

/** Tools that write files. Gated by mode (see `decideToolPermission`). */
const WRITE_TOOLS = new Set(["edit", "write"]);
const PROCESS_TOOLS = new Set(["bash", "kill_task", "lsp"]);
const NETWORK_TOOLS = new Set(["web_fetch", "web_search"]);
const EXTERNAL_TOOLS = new Set(["search_tool", "use_tool"]);

const MAX_OPERATION_LEN = 200;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractStringField(args: unknown, keys: string[]): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** Build a short, redacted, human-readable summary of what a tool call does. */
export function describeOperation(toolName: string, args: unknown): string {
	if (toolName === "bash") {
		const command = extractStringField(args, ["command"]) ?? "";
		return truncate(redactForAudit(command), MAX_OPERATION_LEN);
	}
	const path = extractStringField(args, ["path", "file_path", "filePath"]);
	if (path) {
		return `${toolName}: ${truncate(path, MAX_OPERATION_LEN)}`;
	}
	return toolName;
}

export function classifyToolEffect(toolName: string): ToolEffect {
	if (READ_ONLY_TOOLS.has(toolName)) return "read";
	if (SESSION_TOOLS.has(toolName)) return "session";
	if (WRITE_TOOLS.has(toolName)) return "workspace-write";
	if (PROCESS_TOOLS.has(toolName)) return "process";
	if (NETWORK_TOOLS.has(toolName)) return "network";
	if (EXTERNAL_TOOLS.has(toolName)) return "external";
	return "unknown";
}

/**
 * Match a rule pattern like "bash:git *" or "edit:*" against
 * "${toolName}:${operation}". `*` matches any run of characters; everything
 * else is matched literally (case-sensitive). No other glob syntax is
 * supported — unrecognized patterns simply never match, which is the safe
 * failure mode for a permission rule.
 */
export function matchesRulePattern(pattern: string, toolName: string, operation: string): boolean {
	const subject = `${toolName}:${operation}`;
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	try {
		return new RegExp(`^${escaped}$`, "s").test(subject);
	} catch {
		return false;
	}
}

function findMatchingRule(
	rules: PermissionRule[] | undefined,
	toolName: string,
	operation: string,
): PermissionRule | undefined {
	if (!rules) return undefined;
	return rules.find((rule) => matchesRulePattern(rule.pattern, toolName, operation));
}

/**
 * Pure permission decision function. Given a tool call and the effective
 * mode/rules, returns exactly one of allow/ask/deny plus the reason. Does
 * not perform I/O, does not know about UI, and never throws on malformed
 * input — worst case it asks.
 */
export function decideToolPermission(input: PermissionCheckInput): PermissionCheckResult {
	const { toolName, args, mode, allow, deny, cwd } = input;
	const operation = describeOperation(toolName, args);

	// Hard deny: symlink/path-traversal escape on file-writing tools, checked
	// before any rule or mode policy (see M1 hard-deny list). Only enforced when
	// a cwd is available to scope against; without one this check is skipped,
	// not treated as a denial (the scope itself would be undefined).
	if (cwd && WRITE_TOOLS.has(toolName)) {
		const path = extractStringField(args, ["path", "file_path", "filePath"]);
		if (path && hasSymlinkEscape(path, cwd, cwd)) {
			return {
				decision: "deny",
				source: "hard-deny",
				reason: "path resolves through a symlink outside the working directory",
				operation,
			};
		}
	}

	const denyRule = findMatchingRule(deny, toolName, operation);
	if (denyRule) {
		return {
			decision: "deny",
			source: "rule-deny",
			reason: denyRule.reason ?? `matched deny rule "${denyRule.pattern}"`,
			operation,
		};
	}

	const allowRule = findMatchingRule(allow, toolName, operation);
	if (allowRule) {
		return {
			decision: "allow",
			source: "rule-allow",
			reason: allowRule.reason ?? `matched allow rule "${allowRule.pattern}"`,
			operation,
		};
	}

	return { ...decideByMode(toolName, args, mode), operation };
}

/** Tools that must always be callable in plan mode: the read-only set plus the plan mode entry/exit escape hatches. */
const PLAN_MODE_ALWAYS_ALLOWED = new Set([...READ_ONLY_TOOLS, ...SESSION_TOOLS]);

function decideByMode(toolName: string, args: unknown, mode: PermissionMode): Omit<PermissionCheckResult, "operation"> {
	if (mode === "bypassPermissions") {
		return { decision: "allow", source: "mode-policy", reason: "permission mode is bypassPermissions" };
	}

	if (mode === "plan") {
		if (PLAN_MODE_ALWAYS_ALLOWED.has(toolName)) {
			return {
				decision: "allow",
				source: "mode-policy",
				reason: "read-only or plan-mode-control tool allowed in plan mode",
			};
		}
		return {
			decision: "deny",
			source: "mode-policy",
			reason: `"${toolName}" is disabled while in plan mode (read-only exploration only)`,
		};
	}

	const effect = classifyToolEffect(toolName);
	if (effect === "read" || effect === "session") {
		return { decision: "allow", source: "mode-policy", reason: `${effect} effect` };
	}

	if (WRITE_TOOLS.has(toolName)) {
		if (mode === "dontAsk") {
			return {
				decision: "deny",
				source: "mode-policy",
				reason: `"${toolName}" is not pre-approved and permission mode is dontAsk`,
			};
		}
		// default and acceptEdits both auto-allow file edits; `auto` currently
		// mirrors `default` (no classifier backend implemented yet).
		return { decision: "allow", source: "mode-policy", reason: "file edit tool allowed by current permission mode" };
	}

	if (toolName === "bash") {
		return decideBashByMode(args, mode);
	}

	if (mode === "dontAsk") {
		return {
			decision: "deny",
			source: "mode-policy",
			reason: `"${toolName}" has ${effect} effects and is not pre-approved`,
		};
	}
	if (effect === "unknown") {
		return {
			decision: "allow",
			source: "mode-policy",
			reason: "trusted custom/extension tool",
		};
	}
	return {
		decision: "ask",
		source: "mode-policy",
		reason: `"${toolName}" has ${effect} effects`,
	};
}

function decideBashByMode(args: unknown, mode: PermissionMode): Omit<PermissionCheckResult, "operation"> {
	const command = extractStringField(args, ["command"]) ?? "";
	const analysis = analyzeBashCommand(command);

	if (mode === "dontAsk") {
		if (analysis.risk === "safe" && !analysis.parseError) {
			return { decision: "allow", source: "mode-policy", reason: "command classified as safe" };
		}
		return {
			decision: "deny",
			source: "mode-policy",
			reason: `command is not pre-approved (dontAsk mode): ${analysis.reasons.join("; ") || "unclassified"}`,
		};
	}

	if (analysis.risk === "safe" && !analysis.parseError) {
		return { decision: "allow", source: "mode-policy", reason: "command classified as safe" };
	}

	const reason = analysis.parseError
		? `command could not be safely parsed: ${analysis.reasons.join("; ")}`
		: analysis.reasons.join("; ") || "command is not on the built-in safe list";
	return { decision: "ask", source: "mode-policy", reason };
}
