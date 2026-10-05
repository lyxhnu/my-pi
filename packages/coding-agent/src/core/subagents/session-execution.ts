import type { AgentSession } from "../agent-session.ts";
import { emitSessionShutdownEvent } from "../extensions/runner.ts";
import type { SessionShutdownEvent } from "../extensions/types.ts";
import type { SubagentRunScope } from "./run-scope.ts";
import { deliverSubagentMail, deliverSubagentUpdateHint } from "./session-mailbox.ts";
import { SubagentError, type SubagentSafePoint } from "./types.ts";

/** Shared root/child boundary: safe-point delivery and actual awaited tool cleanup. */
export async function executeSessionRun<T>(
	session: AgentSession,
	scope: SubagentRunScope,
	signal: AbortSignal,
	safePoint: SubagentSafePoint,
	work: () => Promise<T>,
): Promise<T> {
	const previousPrepare = session.agent.prepareNextTurnWithContext;
	session.agent.prepareNextTurnWithContext = async (turn, nextSignal) => {
		if (!signal.aborted && !nextSignal?.aborted) {
			safePoint(
				(mail) => {
					const message = deliverSubagentMail(session, mail);
					if (message && turn.context.messages !== session.agent.state.messages)
						turn.context.messages.push(message);
				},
				(through) => {
					const message = deliverSubagentUpdateHint(session, through);
					if (message && turn.context.messages !== session.agent.state.messages)
						turn.context.messages.push(message);
				},
			);
		}
		return previousPrepare?.(turn, nextSignal);
	};
	let stopping: Promise<void> | undefined;
	const abort = () => {
		session.taskManager.cancelAll("agent run cancelled");
		stopping ??= session.abort();
		void stopping.catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	let result: { value: T } | { error: unknown };
	const failures: unknown[] = [];
	try {
		if (signal.aborted) throw new SubagentError("cancelled");
		safePoint(
			(mail) => {
				deliverSubagentMail(session, mail);
			},
			(through) => {
				deliverSubagentUpdateHint(session, through);
			},
		);
		result = { value: await work() };
	} catch (error) {
		result = { error };
	} finally {
		while (true) {
			// Extensions can admit another prompt without awaiting it. Keep the
			// run lease, cancellation and safe points alive through that prompt.
			await scope.drain();
			const active = session.taskManager
				.list()
				.filter(
					(task) => task.archiveRole !== "service" && (task.status === "running" || task.status === "cancelling"),
				);
			if (!active.length) {
				if (scope.seal()) break;
				continue;
			}
			const settled = await Promise.allSettled(active.map((task) => session.taskManager.awaitSettled(task.taskId)));
			for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
			if (failures.length) break;
		}
		try {
			await stopping;
		} catch (error) {
			failures.push(error);
		}
		signal.removeEventListener("abort", abort);
		session.agent.prepareNextTurnWithContext = previousPrepare;
	}
	if (failures.length) throw new SubagentError("session_run_cleanup_failed");
	session.clearQueue();
	session.sessionManager.flush();
	if ("error" in result) throw result.error;
	return result.value;
}

export async function shutdownSubagentSession(
	session: AgentSession,
	dispose: () => Promise<void>,
	event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" },
): Promise<void> {
	const failures: unknown[] = [];
	const unsubscribe = session.extensionRunner.onError((error) => {
		if (error.event === "session_shutdown") failures.push(error.error);
	});
	try {
		await emitSessionShutdownEvent(session.extensionRunner, event);
	} catch (error) {
		failures.push(error);
	} finally {
		unsubscribe();
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "subagent_session_cleanup_failed");
	session.sessionManager.flush();
}
