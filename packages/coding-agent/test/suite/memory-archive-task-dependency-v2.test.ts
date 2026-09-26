import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryArchiveService } from "../../src/core/memory/archive-service.ts";

describe("memory archive task dependencies", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createService(): MemoryArchiveService {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-tasks-"));
		roots.push(root);
		return new MemoryArchiveService(root, root, {
			extract: async (sources) => ({
				checkedSourceIds: sources.map((source) => source.sourceId),
				uncheckedSourceIds: [],
				candidates: [],
			}),
		});
	}

	it("waits for durable dependency evidence while service tasks do not block", () => {
		const service = createService();
		service.startRun({ rootPromptId: "run-1", sessionId: "session-1" });
		service.recordEvidence("run-1", {
			sourceId: "input-1",
			origin: "user",
			content: "Investigate the failure",
			visibility: "session",
		});
		service.registerTask("run-1", "test-task", "dependency");
		service.registerTask("run-1", "lsp-task", "service");
		service.settleRun("run-1", "completed");

		expect(service.checkArchiveEligibility("run-1")).toEqual({
			status: "waiting_task_evidence",
			taskIds: ["test-task"],
		});
		service.recordTaskEvidence("run-1", "test-task", "durable");
		expect(service.checkArchiveEligibility("run-1")).toEqual({ status: "ready" });
	});
});
