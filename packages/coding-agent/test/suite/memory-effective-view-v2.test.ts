import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAuthority } from "../../src/core/memory/memory-authority.ts";
import { projectMemoryDir } from "../../src/core/memory/memory-store.ts";

describe("long-term memory authority", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createAuthority(): MemoryAuthority {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-authority-"));
		roots.push(root);
		return new MemoryAuthority(root, join(root, "workspace"));
	}

	it("keeps unresolved records in conflict context while excluding them from the effective view", () => {
		const authority = createAuthority();
		authority.startRun({ rootPromptId: "run-1", sessionId: "session-1" });
		for (const [sequence, sourceId] of ["user-1", "user-2"].entries()) {
			authority.recordEvidence({
				sourceId,
				rootPromptId: "run-1",
				sessionId: "session-1",
				origin: "user",
				content: sourceId,
				contentHash: `hash-${sourceId}`,
				visibility: "project_rule",
				completeness: "complete",
				sequence,
			});
		}
		const active = authority.commitRecord({
			candidateKey: "active-rule",
			kind: "user_rule",
			subject: "dependencies",
			text: "Runtime dependencies require review.",
			scope: { project: true },
			status: "active",
			sourceRefs: [{ sourceId: "user-1", origin: "user", contentHash: "hash-user-1", completeness: "complete" }],
			verification: {
				level: "user_asserted",
				checkedAt: "2026-09-07T00:00:00.000Z",
				validatedSourceRevision: 2,
			},
		});
		const unresolved = authority.commitRecord({
			candidateKey: "pending-exception",
			kind: "user_rule",
			subject: "dependencies",
			text: "CLI dependencies may be added without review.",
			scope: { project: true, scene: "cli" },
			status: "needs_verification",
			sourceRefs: [{ sourceId: "user-2", origin: "user", contentHash: "hash-user-2", completeness: "complete" }],
			verification: {
				level: "user_asserted",
				checkedAt: "2026-09-07T00:01:00.000Z",
				validatedSourceRevision: 2,
			},
			relations: { conflictsWith: [active.memoryId] },
		});

		expect(authority.getEffectiveMemoryView({ scene: "cli" })).toEqual([]);
		expect(
			authority.getMemoryConflictContext({ subject: "dependencies", scope: { project: true, scene: "cli" } })
				.records,
		).toEqual(expect.arrayContaining([expect.objectContaining({ memoryId: unresolved.memoryId })]));
	});

	it("expands applicable rule exceptions beyond the requested top-k", () => {
		const authority = createAuthority();
		authority.startRun({ rootPromptId: "run-rules", sessionId: "session-1" });
		for (const [sequence, sourceId] of ["base-source", "exception-source"].entries()) {
			authority.recordEvidence({
				sourceId,
				rootPromptId: "run-rules",
				sessionId: "session-1",
				origin: "user",
				content: sourceId,
				contentHash: `hash-${sourceId}`,
				visibility: "project_rule",
				completeness: "complete",
				sequence,
			});
		}
		const base = authority.commitRecord({
			candidateKey: "dependency-review",
			kind: "user_rule",
			subject: "dependencies",
			text: "Dependencies require review.",
			scope: { project: true },
			status: "active",
			sourceRefs: [
				{
					sourceId: "base-source",
					origin: "user",
					contentHash: "hash-base-source",
					completeness: "complete",
				},
			],
			verification: { level: "user_asserted", checkedAt: "2026-09-07T00:00:00.000Z" },
		});
		authority.commitRecord({
			candidateKey: "cli-dependency-exception",
			kind: "user_rule",
			subject: "dependencies",
			text: "CLI dependencies may be added directly.",
			scope: { project: true, scene: "cli" },
			status: "active",
			sourceRefs: [
				{
					sourceId: "exception-source",
					origin: "user",
					contentHash: "hash-exception-source",
					completeness: "complete",
				},
			],
			verification: { level: "user_asserted", checkedAt: "2026-09-07T00:01:00.000Z" },
			relations: { exceptionOf: [base.memoryId] },
		});

		expect(authority.search("review", { scene: "cli" }, {}, 1)).toHaveLength(2);
		expect(authority.search("review", {}, {}, 1)).toEqual([]);
	});

	it("rebuilds a non-authoritative active view after authority commits", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-active-view-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const authority = new MemoryAuthority(root, cwd);
		authority.startRun({ rootPromptId: "run-view", sessionId: "session-1" });
		authority.recordEvidence({
			sourceId: "view-source",
			rootPromptId: "run-view",
			sessionId: "session-1",
			origin: "user",
			content: "Use npm.",
			contentHash: "view-hash",
			visibility: "project_rule",
			completeness: "complete",
			sequence: 0,
		});
		const record = authority.commitRecord({
			candidateKey: "view-rule",
			kind: "user_rule",
			subject: "package manager",
			text: "Use npm.",
			scope: { project: true },
			status: "active",
			sourceRefs: [{ sourceId: "view-source", origin: "user", contentHash: "view-hash", completeness: "complete" }],
			verification: { level: "user_asserted", checkedAt: "2026-09-07T00:00:00.000Z" },
		});

		const projection = readFileSync(join(projectMemoryDir(root, cwd), "memory-active.md"), "utf8");
		expect(projection).toContain(record.memoryId);
		expect(projection).toContain("Use npm.");
		expect(authority.getStatus().derivedViewStale).toBe(false);
	});
});
