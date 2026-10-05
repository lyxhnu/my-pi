import { describe, expect, it } from "vitest";
import {
	canUseSubagentTool,
	intersectPermissions,
	subagentToolPermission,
	withSubagentToolPermission,
} from "../src/core/subagents/permissions.ts";

describe("subagent capability ceilings", () => {
	it("intersects every grant without escalating a parent or previous grant", () => {
		expect(intersectPermissions({ mode: "full" }, { mode: "read-write" })).toEqual({ mode: "read-write" });
		expect(intersectPermissions({ mode: "read-write" }, { mode: "read-only" }, { mode: "full" })).toEqual({
			mode: "read-only",
		});
		expect(() => intersectPermissions()).toThrow("permission_required");
	});
	it("distinguishes builtins from a custom tool impersonating a reading tool", () => {
		expect(subagentToolPermission({}, "read", true)).toBe("read-only");
		expect(subagentToolPermission({}, "write", true)).toBe("read-write");
		expect(subagentToolPermission({}, "bash", true)).toBe("full");
		expect(subagentToolPermission({}, "read", false)).toBe("full");
		const declared = withSubagentToolPermission({}, "read-only");
		expect(subagentToolPermission(declared, "lookup", false)).toBe("read-only");
		expect(subagentToolPermission({ ...declared }, "lookup", false)).toBe("full");
	});
	it("denies commands to both restricted tiers and edits to readonly", () => {
		expect(canUseSubagentTool({ mode: "read-only" }, "read-write")).toBe(false);
		expect(canUseSubagentTool({ mode: "read-write" }, "full")).toBe(false);
		expect(canUseSubagentTool({ mode: "full" }, "full")).toBe(true);
	});
});
