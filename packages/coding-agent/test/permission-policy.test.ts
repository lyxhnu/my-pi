import { describe, expect, it } from "vitest";
import {
	classifyToolEffect,
	decideToolPermission,
	describeOperation,
	matchesRulePattern,
} from "../src/core/permissions/policy.ts";
import type { PermissionRule } from "../src/core/permissions/types.ts";

describe("decideToolPermission — read-only tools", () => {
	it("always allows read/grep/find/ls/todo_write regardless of mode", () => {
		for (const toolName of ["read", "grep", "find", "ls", "todo_write"]) {
			for (const mode of ["default", "acceptEdits", "dontAsk", "plan"] as const) {
				const result = decideToolPermission({ toolName, args: {}, mode });
				expect(result.decision, `${toolName} under ${mode}`).toBe("allow");
			}
		}
	});
});

describe("decideToolPermission — edit/write tools", () => {
	it("allows edits under default and acceptEdits", () => {
		for (const mode of ["default", "acceptEdits"] as const) {
			const result = decideToolPermission({ toolName: "edit", args: { path: "a.ts" }, mode });
			expect(result.decision).toBe("allow");
		}
	});

	it("denies edits under dontAsk unless an allow rule matches", () => {
		const denied = decideToolPermission({ toolName: "edit", args: { path: "a.ts" }, mode: "dontAsk" });
		expect(denied.decision).toBe("deny");

		const allow: PermissionRule[] = [{ pattern: "edit:*" }];
		const allowed = decideToolPermission({ toolName: "edit", args: { path: "a.ts" }, mode: "dontAsk", allow });
		expect(allowed.decision).toBe("allow");
		expect(allowed.source).toBe("rule-allow");
	});

	it("denies edits in plan mode", () => {
		const result = decideToolPermission({ toolName: "edit", args: { path: "a.ts" }, mode: "plan" });
		expect(result.decision).toBe("deny");
	});
});

describe("decideToolPermission — bash", () => {
	it("allows safe commands under default", () => {
		const result = decideToolPermission({ toolName: "bash", args: { command: "ls -la" }, mode: "default" });
		expect(result.decision).toBe("allow");
	});

	it("asks about dangerous commands under default (never silently allows)", () => {
		const result = decideToolPermission({
			toolName: "bash",
			args: { command: "rm -rf /tmp/x" },
			mode: "default",
		});
		expect(result.decision).toBe("ask");
	});

	it("asks about ambiguous commands under acceptEdits", () => {
		const result = decideToolPermission({
			toolName: "bash",
			args: { command: "some-cli --do-thing" },
			mode: "acceptEdits",
		});
		expect(result.decision).toBe("ask");
	});

	it("denies non-safe commands under dontAsk", () => {
		const result = decideToolPermission({ toolName: "bash", args: { command: "rm -rf /tmp/x" }, mode: "dontAsk" });
		expect(result.decision).toBe("deny");
	});

	it("allows safe commands under dontAsk", () => {
		const result = decideToolPermission({ toolName: "bash", args: { command: "ls" }, mode: "dontAsk" });
		expect(result.decision).toBe("allow");
	});

	it("denies bash entirely under plan mode, even for safe-looking commands", () => {
		const result = decideToolPermission({ toolName: "bash", args: { command: "ls" }, mode: "plan" });
		expect(result.decision).toBe("deny");
	});

	it("allows everything under bypassPermissions", () => {
		const result = decideToolPermission({
			toolName: "bash",
			args: { command: "rm -rf /tmp/x" },
			mode: "bypassPermissions",
		});
		expect(result.decision).toBe("allow");
		expect(result.source).toBe("mode-policy");
	});
});

describe("decideToolPermission — deny/allow rule precedence", () => {
	it("a matching deny rule wins over mode policy, even for otherwise-safe commands", () => {
		const deny: PermissionRule[] = [{ pattern: "bash:git push*", reason: "no pushing in CI" }];
		const result = decideToolPermission({
			toolName: "bash",
			args: { command: "git push origin main" },
			mode: "bypassPermissions",
			deny,
		});
		expect(result.decision).toBe("deny");
		expect(result.source).toBe("rule-deny");
		expect(result.reason).toBe("no pushing in CI");
	});

	it("deny rules are checked before allow rules", () => {
		const allow: PermissionRule[] = [{ pattern: "bash:*" }];
		const deny: PermissionRule[] = [{ pattern: "bash:rm*" }];
		const result = decideToolPermission({
			toolName: "bash",
			args: { command: "rm -rf /tmp/x" },
			mode: "default",
			allow,
			deny,
		});
		expect(result.decision).toBe("deny");
	});
});

describe("decideToolPermission — unknown/custom tools", () => {
	it("allows custom/extension tools under default after extension trust is established", () => {
		const result = decideToolPermission({ toolName: "custom_tool", args: {}, mode: "default" });
		expect(result.decision).toBe("allow");
	});

	it("denies unknown/custom tools under dontAsk", () => {
		const result = decideToolPermission({ toolName: "custom_tool", args: {}, mode: "dontAsk" });
		expect(result.decision).toBe("deny");
	});

	it("denies custom tools in plan mode, same as any non-read-only tool", () => {
		const result = decideToolPermission({ toolName: "custom_tool", args: {}, mode: "plan" });
		expect(result.decision).toBe("deny");
	});
});

describe("classifyToolEffect", () => {
	it("classifies built-in network, process, write, and read effects", () => {
		expect(classifyToolEffect("web_fetch")).toBe("network");
		expect(classifyToolEffect("bash")).toBe("process");
		expect(classifyToolEffect("spawn_agent")).toBe("session");
		expect(classifyToolEffect("interrupt_agent")).toBe("session");
		expect(classifyToolEffect("edit")).toBe("workspace-write");
		expect(classifyToolEffect("memory_search")).toBe("read");
	});

	it("asks for configured network and external-system tools under default mode", () => {
		for (const toolName of ["web_fetch", "web_search", "search_tool", "use_tool"]) {
			expect(decideToolPermission({ toolName, args: {}, mode: "default" }).decision).toBe("ask");
		}
	});
});

describe("describeOperation", () => {
	it("redacts secrets from bash command summaries", () => {
		const operation = describeOperation("bash", { command: "export API_KEY=sk-abcdef123456" });
		expect(operation).not.toContain("sk-abcdef123456");
	});

	it("summarizes file tools by path", () => {
		expect(describeOperation("edit", { path: "src/index.ts" })).toBe("edit: src/index.ts");
	});
});

describe("matchesRulePattern", () => {
	it("supports a trailing wildcard", () => {
		expect(matchesRulePattern("bash:git *", "bash", "git status")).toBe(true);
		expect(matchesRulePattern("bash:git *", "bash", "npm install")).toBe(false);
	});

	it("matches exactly when there is no wildcard", () => {
		expect(matchesRulePattern("edit:a.ts", "edit", "a.ts")).toBe(true);
		expect(matchesRulePattern("edit:a.ts", "edit", "b.ts")).toBe(false);
	});
});
