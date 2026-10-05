import { SubagentError, type SubagentPermission, type SubagentPermissionMode } from "./types.ts";

const rank = { "read-only": 0, "read-write": 1, full: 2 } as const;
const declarations = new WeakMap<object, SubagentPermissionMode>();
const readTools = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"history",
	"memory_search",
	"memory_get",
	"todo_write",
	"context_note",
	"get_context_remaining",
	"new_context",
	"get_task_output",
	"kill_task",
	"enter_plan_mode",
	"exit_plan_mode",
	"upgrade_execution",
]);

/** Trusted hosts classify their own tool closures; unknown extensions require full access. */
export function withSubagentToolPermission<T extends object>(tool: T, mode: SubagentPermissionMode): T {
	declarations.set(tool, mode);
	return tool;
}

export function subagentToolPermission(tool: object, name: string, builtin: boolean): SubagentPermissionMode {
	const declared = declarations.get(tool);
	if (declared) return declared;
	if (builtin && readTools.has(name)) return "read-only";
	if (builtin && (name === "edit" || name === "write")) return "read-write";
	return "full";
}

export function canUseSubagentTool(permission: SubagentPermission, required: SubagentPermissionMode): boolean {
	return rank[permission.mode] >= rank[required];
}

/** Tool capability ceilings, not operating-system filesystem or network isolation. */
export function intersectPermissions(...grants: SubagentPermission[]): SubagentPermission {
	if (!grants.length) throw new SubagentError("permission_required");
	if (grants.some((grant) => !Object.hasOwn(rank, grant.mode))) throw new SubagentError("invalid_permission");
	return {
		mode: grants.reduce(
			(mode, grant) => (rank[grant.mode] < rank[mode] ? grant.mode : mode),
			"full" as SubagentPermissionMode,
		),
	};
}
