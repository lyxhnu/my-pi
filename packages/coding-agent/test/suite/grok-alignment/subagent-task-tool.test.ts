import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isSubagentTaskResult } from "../../../src/core/subagents/protocol.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("task (subagent) tool", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function createTaskHarness(): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: ["task", "get_task_output", "kill_task"],
			settings: { permissions: { allow: [{ pattern: "task:*" }] } },
		});
		execFileSync("git", ["init"], { cwd: harness.tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: harness.tempDir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: harness.tempDir });
		execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: harness.tempDir, stdio: "ignore" });
		return harness;
	}

	function completedSubmission(summary: string) {
		return {
			status: "completed" as const,
			summary,
			findings: [{ summary, path: "index.ts", line: 1 }],
			changes: [],
			verification: [],
		};
	}

	it("is registered and active by default at depth 0, alongside get_task_output/kill_task", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).toContain("task");
		expect(allToolNames).toContain("get_task_output");
		expect(allToolNames).toContain("kill_task");
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["task", "get_task_output", "kill_task"]),
		);
	});

	it("is physically removed (with get_task_output/kill_task) once MAX_SUBAGENT_DEPTH is reached", async () => {
		const harness = await createHarness({ subagentDepth: 1 });
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).not.toContain("task");
		expect(allToolNames).not.toContain("get_task_output");
		expect(allToolNames).not.toContain("kill_task");
		expect(harness.session.getActiveToolNames()).not.toContain("task");
	});

	it.each(["completed", "blocked"] as const)(
		"returns a foreground %s result with a model-visible task ID",
		async (status) => {
			const harness = await createTaskHarness();
			harnesses.push(harness);
			let parentResultText = "";
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("task", {
						description: "look around",
						prompt: "find the entry point",
						subagent_type: "explore",
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				// Consumed by the CHILD subagent's own single-turn conversation (shared faux response queue).
				fauxAssistantMessage(
					fauxToolCall(
						"submit_subagent_result",
						status === "completed"
							? completedSubmission("child found index.ts")
							: { status, summary: "child found index.ts", blocker: "missing dependency", findings: [] },
					),
					{ stopReason: "toolUse" },
				),
				// Consumed by the parent once the tool result comes back.
				(context) => {
					const result = context.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "task",
					);
					parentResultText = getMessageText(result);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("investigate the repo");

			const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
			expect(toolResult?.role).toBe("toolResult");
			const text = getMessageText(toolResult);
			expect(text).not.toContain("<subagent_meta>");
			expect(text).toContain('"agentType":"explore"');
			expect(text).toContain('"capabilityMode":"read-only"');
			expect(text).toContain('"summary":"child found index.ts"');
			if (toolResult?.role === "toolResult") {
				expect(toolResult.isError).not.toBe(true);
				const details = toolResult.details as { result?: unknown };
				expect(isSubagentTaskResult(details.result)).toBe(true);
			}

			const subagentTasks = harness.session.taskManager.list().filter((t) => t.kind === "subagent");
			expect(subagentTasks).toHaveLength(1);
			expect(subagentTasks[0]?.status).toBe(status);
			expect(JSON.parse(parentResultText)).toMatchObject({ taskId: subagentTasks[0]?.taskId });
			const taskStateEvents = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "trace" && entry.event.type === "task/state")
				.map((entry) =>
					entry.type === "trace" && entry.event.type === "task/state" ? entry.event.data.to : undefined,
				);
			expect(taskStateEvents).toEqual(["running", status]);
		},
	);

	it("runs a background general-purpose subagent that is pollable via get_task_output", async () => {
		const harness = await createTaskHarness();
		harnesses.push(harness);
		// Both the parent's own post-tool-call continuation and the child subagent's first turn race to
		// consume the shared faux response queue; either order is valid, so provide both up front and
		// don't assert which specific text lands with which consumer.
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					description: "fix the bug",
					prompt: "fix it",
					subagent_type: "general-purpose",
					// run_in_background omitted: defaults to true (Grok-aligned).
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("submit_subagent_result", completedSubmission("child fixed it")), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("parent turn done"),
		]);
		await harness.session.prompt("please fix the bug");

		const taskToolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(taskToolResult?.role).toBe("toolResult");
		const startedText = getMessageText(taskToolResult);
		expect(startedText).toContain("background");
		const taskIdMatch = startedText.match(/task ([a-f0-9-]+)/);
		expect(taskIdMatch).not.toBeNull();
		const taskId = taskIdMatch![1]!;

		const waitResult = await harness.session.taskManager.wait([taskId], { timeoutMs: 5000 });
		const snapshot = waitResult.snapshots[0];
		expect(snapshot?.status).toBe("completed");
		if (snapshot?.status === "completed") {
			expect(isSubagentTaskResult(snapshot.result)).toBe(true);
		}
	});

	it("rejects resume_from pointing at an unknown task id", async () => {
		const harness = await createTaskHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					description: "resume",
					prompt: "continue",
					subagent_type: "explore",
					run_in_background: false,
					resume_from: "does-not-exist",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("resume the prior investigation");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
	});

	it("fails a child that ends without submit_subagent_result", async () => {
		const harness = await createTaskHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					description: "invalid child",
					prompt: "return plain text",
					subagent_type: "explore",
					run_in_background: false,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("plain text is not a structured result"),
			fauxAssistantMessage("parent handled the failure"),
		]);
		await harness.session.prompt("delegate invalid work");

		const taskResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		);
		expect(taskResult?.role === "toolResult" ? taskResult.isError : false).toBe(true);
		const childTask = harness.session.taskManager.list().find((task) => task.kind === "subagent");
		expect(childTask).toMatchObject({
			status: "failed",
			errorMessage: "Subagent ended without calling submit_subagent_result.",
		});
	});
	it("B09/E07 never maps a child's context_limit stop to completed", async () => {
		const harness = await createTaskHarness();
		harnesses.push(harness);
		harness.settingsManager.applyOverrides({ compaction: { enabled: false } });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					description: "oversized child",
					prompt: "x".repeat(harness.getModel().contextWindow * 4),
					subagent_type: "explore",
					run_in_background: false,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("must not be consumed by the child"),
		]);
		await harness.session.prompt("delegate an oversized input");
		const child = harness.session.taskManager.list().find((task) => task.kind === "subagent");
		expect(child).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("context_limit") });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("rejects an invalid structured submission and accepts a corrected one", async () => {
		const harness = await createTaskHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					description: "validate result",
					prompt: "submit a result",
					subagent_type: "explore",
					run_in_background: false,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_subagent_result", {
					...completedSubmission("invalid"),
					extra: "not allowed",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("submit_subagent_result", completedSubmission("corrected")), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("parent received corrected result"),
		]);
		await harness.session.prompt("delegate validation work");

		const childTask = harness.session.taskManager.list().find((task) => task.kind === "subagent");
		expect(childTask?.status).toBe("completed");
		if (childTask?.status === "completed" && isSubagentTaskResult(childTask.result)) {
			expect(childTask.result.submission.summary).toBe("corrected");
		}
	});
});
