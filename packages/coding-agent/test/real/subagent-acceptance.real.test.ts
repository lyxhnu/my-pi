import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	controlEvents,
	finishedRuns,
	identities,
	messageText,
	realSubagentScenario,
	rootToolResults,
} from "./subagent-real-fixture.ts";

describe.skipIf(process.env.PI_SUBAGENT_REAL !== "1")("real subagent delivery acceptance", () => {
	it("enforces root capacity, FIFO cancellation and wait cycles, then persists the lifetime budget", async () => {
		await realSubagentScenario(
			"capacity-fifo-budget",
			{ gates: ["A1", "B1", "C1"], requestBudget: 80 },
			async (f) => {
				await f.prompt(
					'Call spawn_agent exactly three times, each with context="none" and permission={"mode":"read-only"}. Tasks respectively: "Call test_gate with label=A1, then follow its returned instruction exactly. Do not otherwise delegate."; "Call test_gate with label=B1, then reply B_DONE."; "Call test_gate with label=C1, then reply C_DONE." Do not wait for these runs yet. Reply THREE_STARTED.',
				);
				await vi.waitFor(() => expect([...f.gates.values()].every((gate) => gate.enteredAt)).toBe(true), {
					timeout: 90_000,
				});
				expect(identities(f.root)).toHaveLength(3);
				expect(f.root.subagents!.coordinator.usage.active).toBe(3);
				const a = identities(f.root).find((event) => event.run.task.includes("label=A1"))!;
				await f.prompt(
					'Attempt exactly one spawn_agent with context="none", permission={"mode":"read-only"}, task="Reply SHOULD_NOT_START". Report the actual error without retrying or cancelling existing work.',
				);
				expect(messageText(rootToolResults(f.root, "spawn_agent").at(-1))).toContain("execution_capacity_exceeded");
				expect(identities(f.root)).toHaveLength(3);
				await f.prompt(
					`Call followup_task twice on agent ${a.agent.agentId}, in this order: task="Reply QUEUED_A2_SHOULD_NOT_RUN" and task="Reply QUEUED_A3_OK". Do not wait. Reply QUEUED.`,
				);
				const accepted = controlEvents(f.root)
					.filter((event) => event.kind === "run_accepted")
					.filter((event) => event.run.agentId === a.agent.agentId);
				expect(accepted).toHaveLength(2);
				const a2 = accepted[0].run,
					a3 = accepted[1].run;
				expect(accepted.every((event) => event.run.state === "queued")).toBe(true);
				await f.prompt(
					`Call interrupt_agent on run ${a2.runId} with scope=run. Do not interrupt anything else. Reply CANCELLED_A2.`,
				);
				f.gates
					.get("A1")!
					.release(
						`Call wait_agent exactly once with runId=${a3.runId}, condition=result, timeoutMs=1000. It should return run_wait_cycle because this is your queued successor. After observing the actual error, reply A1_CYCLE_CHECKED. Do not retry or delegate.`,
					);
				await f.prompt(
					`Wait for run ${a.run.runId}, then run ${a3.runId}, using wait_agent timeoutMs=30000 and repeating only on timedOut. Report both final results.`,
				);
				const child = f.root.subagents!.factory.getSession(a.agent.agentId)!;
				expect(messageText(rootToolResults(child, "wait_agent").at(-1))).toContain("run_wait_cycle");
				const finals = finishedRuns(f.root);
				expect(finals.find((run) => run.runId === a2.runId)?.state).toBe("cancelled");
				expect(finals.find((run) => run.runId === a3.runId)?.resultSummary).toContain("QUEUED_A3_OK");
				expect(finals.find((run) => run.runId === a3.runId)!.startedAt).toBeGreaterThanOrEqual(
					finals.find((run) => run.runId === a.run.runId)!.finishedAt!,
				);
				expect(child.messages.some((message) => message.role === "user" && messageText(message) === a2.task)).toBe(
					false,
				);
				f.gates.get("B1")!.release();
				f.gates.get("C1")!.release();
				await f.prompt(
					'Wait for the original B1 and C1 runs until completed. Then create exactly five more agents, ONE AT A TIME. Each spawn_agent uses context="none", permission={"mode":"read-only"}, task="Reply EXTRA_OK". Wait for each to complete before creating the next. Finally try exactly one additional spawn_agent with the same arguments: it must return the lifetime capacity error. Report that error and stop.',
				);
				expect(identities(f.root)).toHaveLength(8);
				expect(messageText(rootToolResults(f.root, "spawn_agent").at(-1))).toContain("agent_creation_limit");
				await f.reopen();
				expect(f.root.subagents!.coordinator.usage.created).toBe(8);
				await f.prompt(
					`Call followup_task on existing agent ${a.agent.agentId} with task="Reply REUSED_AFTER_EIGHT", wait until completed. Then try one spawn_agent with context=none, permission={"mode":"read-only"}, task="Reply SHOULD_NOT_START". Report the result without retries.`,
				);
				expect(identities(f.root)).toHaveLength(8);
				expect(finishedRuns(f.root).some((run) => run.resultSummary?.includes("REUSED_AFTER_EIGHT"))).toBe(true);
				expect(messageText(rootToolResults(f.root, "spawn_agent").at(-1))).toContain("agent_creation_limit");
			},
		);
	}, 630_000);

	it("cancels the old causal subtree without stopping unrelated reuse, and closes queued work without replay", async () => {
		await realSubagentScenario(
			"causal-cancel-close",
			{ gates: ["B", "A_NEW", "KEEPER", "CLOSE"], requestBudget: 65 },
			async (f) => {
				const task =
					'You are A. Call spawn_agent exactly once, context=none, permission={"mode":"read-only"}, task="Call test_gate with label=B then reply B_DONE. Do not delegate." Immediately call followup_task on that new B with task="Reply B_QUEUED_SHOULD_NOT_RUN". Do not wait for B. Remember the private marker forest-key-381. Reply A_DONE.';
				await f.prompt(
					`Spawn exactly one read-only agent with context=none and task copied verbatim from this JSON string: ${JSON.stringify(task)}. Wait for A's run to complete, repeating wait only if timedOut. Reply PARENT_COMPLETE.`,
				);
				await vi.waitFor(() => expect(f.gates.get("B")!.enteredAt).toBeDefined(), { timeout: 90_000 });
				const a = identities(f.root).find((event) => event.agent.creatorAgentId === f.root.sessionId)!;
				const b = identities(f.root).find((event) => event.agent.creatorAgentId === a.agent.agentId)!;
				const b2 = controlEvents(f.root).find(
					(event) => event.kind === "run_accepted" && event.run.agentId === b.agent.agentId,
				);
				expect(b2?.kind).toBe("run_accepted");
				await f.prompt(
					`followup_task on A (${a.agent.agentId}) with task="Call test_gate with label=A_NEW then reply A_NEW_DONE". Also spawn exactly one read-only agent, context=none, task="Call test_gate with label=KEEPER then reply KEEPER_DONE". Do not wait; report accepted IDs.`,
				);
				await vi.waitFor(
					() => expect(f.gates.get("A_NEW")!.enteredAt && f.gates.get("KEEPER")!.enteredAt).toBeTruthy(),
					{ timeout: 90_000 },
				);
				await f.prompt(
					`interrupt_agent OLD completed run ${a.run.runId} with scope=subtree. Then wait_agent for that exact run with condition=subtree_stopped, timeoutMs=30000 until subtreeStopped=true. Do not cancel A's newer run or the keeper. Reply OLD_SUBTREE_STOPPED.`,
				);
				const interrupted = rootToolResults(f.root, "interrupt_agent").at(-1);
				expect(messageText(interrupted)).toContain('"stopped":false');
				expect(f.gates.get("B")!.abortedAt).toBeDefined();
				expect(f.gates.get("A_NEW")!.abortedAt).toBeUndefined();
				expect(f.gates.get("KEEPER")!.abortedAt).toBeUndefined();
				const finals = finishedRuns(f.root);
				expect(finals.find((run) => run.runId === b.run.runId)?.state).toBe("cancelled");
				expect(finals.find((run) => run.runId === b.run.runId)!.finishedAt).toBeGreaterThanOrEqual(
					f.gates.get("B")!.stoppedAt!,
				);
				if (b2?.kind !== "run_accepted") throw new Error("queued_descendant_missing");
				expect(finals.find((run) => run.runId === b2.run.runId)?.state).toBe("cancelled");
				f.gates.get("A_NEW")!.release();
				f.gates.get("KEEPER")!.release();
				await f.prompt(
					`Wait for the newer A run and keeper run until completed. Then followup_task on A (${a.agent.agentId}) with task="Call test_gate with label=CLOSE then reply CLOSE_SHOULD_NOT_COMPLETE". Queue a second followup on A with task="Reply CLOSED_QUEUE_SHOULD_NOT_RUN". Do not wait for these last two tasks.`,
				);
				await vi.waitFor(() => expect(f.gates.get("CLOSE")!.enteredAt).toBeDefined(), { timeout: 90_000 });
				const before = controlEvents(f.root)
					.filter((event) => event.kind === "run_accepted")
					.filter((event) => event.run.task.includes("CLOSE"));
				expect(before).toHaveLength(2);
				await f.reopen();
				expect(f.gates.get("CLOSE")!.abortedAt).toBeDefined();
				for (const event of before)
					expect(finishedRuns(f.root).find((run) => run.runId === event.run.runId)?.state).toBe("cancelled");
				await f.prompt(
					`Followup existing A (${a.agent.agentId}) asking "Return the original private marker you remember. Do not use tools." Do not supply the marker. Wait for the new run and report its result. Never create another agent.`,
				);
				expect(
					finishedRuns(f.root)
						.filter((run) => run.agentId === a.agent.agentId)
						.at(-1)?.resultSummary,
				).toContain("forest-key-381");
				expect(identities(f.root)).toHaveLength(3);
				expect(
					f.root
						.subagents!.factory.getSession(a.agent.agentId)!
						.messages.some(
							(message) =>
								message.role === "user" && messageText(message) === "Reply CLOSED_QUEUE_SHOULD_NOT_RUN",
						),
				).toBe(false);
			},
		);
	}, 630_000);

	it("uses default tools for real file work, narrows followups and keeps idle mail and old results distinct", async () => {
		await realSubagentScenario("default-files-permissions-mail", { requestBudget: 65 }, async (f) => {
			writeFileSync(
				join(f.workspace, "input.json"),
				JSON.stringify([
					{ active: true, amount: 31 },
					{ active: false, amount: 900 },
					{ active: true, amount: 42 },
				]),
			);
			await f.prompt(
				'Spawn one read-only child with context=none, task="First try read on missing.json once, then read input.json. Sum amounts ONLY for rows where active=true. Reply exactly TOTAL=<sum>. Do not delegate." Wait until completed. Then spawn one read-write child with context=none, task containing the verified sum and asking it to use write to create total.txt containing only that number. Wait until completed. Finally spawn one full child with context=none, task="Use bash to read total.txt (the host is Windows, use a suitable command) and confirm its content. Do not write files or delegate." Wait until completed and report the verified number.',
			);
			expect(readFileSync(join(f.workspace, "total.txt"), "utf8").trim()).toBe("73");
			const created = identities(f.root);
			expect(created).toHaveLength(3);
			const reader = created.find((event) => event.agent.permission.mode === "read-only")!;
			const writer = created.find((event) => event.agent.permission.mode === "read-write")!;
			const full = created.find((event) => event.agent.permission.mode === "full")!;
			const readerSession = f.root.subagents!.factory.getSession(reader.agent.agentId)!;
			expect(
				rootToolResults(readerSession, "read").some((message) => message.role === "toolResult" && message.isError),
			).toBe(true);
			expect(rootToolResults(f.root.subagents!.factory.getSession(writer.agent.agentId)!, "write")).toHaveLength(1);
			expect(
				rootToolResults(f.root.subagents!.factory.getSession(full.agent.agentId)!, "bash").length,
			).toBeGreaterThan(0);
			const old = finishedRuns(f.root).find((run) => run.runId === full.run.runId)!;
			expect(old.effectsUnknown).toBe(true);
			expect(() => SessionManager.open(reader.agent.sessionFile)).toThrow(
				expect.objectContaining({ code: "child_requires_root" }),
			);
			await f.prompt(
				`Send_message to idle agent ${reader.agent.agentId} without targetRunId, with message="Private mailbox marker quartz-mail-819". Do not start a followup yet. Reply MAILED.`,
			);
			expect(controlEvents(f.root).some((event) => event.kind === "mail" && event.mail.state === "pending")).toBe(
				true,
			);
			await f.reopen();
			await f.prompt(
				`followup_task on ${reader.agent.agentId} with task="Return the private mailbox marker in your incoming message. Do not call tools." Do not repeat the marker in the task. Wait for completion. Also followup_task on ${full.agent.agentId} with permission={"mode":"read-only"}, task="Read total.txt. If write or bash is available, use it to create forbidden.txt; if both are absent, do not create anything and reply READ_ONLY_CONFIRMED plus the total." Wait for completion. Finally get_agent_info on OLD run ${old.runId}, and report that original run separately from its newer followup.`,
			);
			expect(finishedRuns(f.root).some((run) => run.resultSummary?.includes("quartz-mail-819"))).toBe(true);
			expect(existsSync(join(f.workspace, "forbidden.txt"))).toBe(false);
			const latest = finishedRuns(f.root)
				.filter((run) => run.agentId === full.agent.agentId)
				.at(-1)!;
			expect(latest.permission.mode).toBe("read-only");
			expect(latest.resultSummary).toContain("READ_ONLY_CONFIRMED");
			expect(
				f.requests
					.filter((request) => request.sessionId === full.agent.sessionId && request.at >= latest.startedAt!)
					.every((request) => !request.tools.includes("write") && !request.tools.includes("bash")),
			).toBe(true);
			expect(finishedRuns(f.root).find((run) => run.runId === old.runId)?.resultRef).toBe(old.resultRef);
			expect(messageText(rootToolResults(f.root, "get_agent_info").at(-1))).toContain(old.runId);
			f.permission.mode = "read-only";
			await f.prompt(
				'Spawn one child with context=none and requested permission={"mode":"full"}, task="Read total.txt. If write/bash are absent, reply ROOT_CEILING_CONFIRMED. Do not delegate." Wait for completion.',
			);
			const capped = identities(f.root).at(-1)!;
			expect(capped.agent.permission.mode).toBe("read-only");
			expect(finishedRuns(f.root).find((run) => run.runId === capped.run.runId)?.resultSummary).toContain(
				"ROOT_CEILING_CONFIRMED",
			);
		});
	}, 630_000);
});
