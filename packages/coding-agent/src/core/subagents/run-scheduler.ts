import { SUBAGENT_LIMITS, SubagentError, type SubagentRun } from "./types.ts";

interface ScheduledRun {
	run: SubagentRun;
	bytes: number;
}

/** All admission and graph mutations are synchronous; there is no capacity queue. */
export class SubagentRunScheduler {
	readonly #runs = new Map<string, ScheduledRun>();
	readonly #queues = new Map<string, string[]>();
	readonly #waits = new Map<symbol, { source: string; targets: string[] }>();
	#queuedBytes = 0;
	#queuedCount = 0;
	#accepting = true;

	get activeCount(): number {
		return this.#queues.size;
	}
	get queuedCount(): number {
		return this.#queuedCount;
	}
	get queuedBytes(): number {
		return this.#queuedBytes;
	}

	get(runId: string): SubagentRun | undefined {
		return this.#runs.get(runId)?.run;
	}
	get all(): SubagentRun[] {
		return [...this.#runs.values()].map(({ run }) => run);
	}
	queue(agentId: string): SubagentRun[] {
		return (this.#queues.get(agentId) ?? []).map((id) => this.#runs.get(id)!.run);
	}

	/** Reserve before constructing child resources. commit must be durable and synchronous. */
	accept(run: SubagentRun, bytes: number, commit: (run: SubagentRun) => void): void {
		if (!this.#accepting) throw new SubagentError("root_closing");
		if (this.#runs.has(run.runId)) throw new SubagentError("run_already_accepted");
		const queue = this.#queues.get(run.agentId);
		if (!queue && this.#queues.size >= SUBAGENT_LIMITS.activeRuns)
			throw new SubagentError("execution_capacity_exceeded");
		if (
			queue &&
			(this.#queuedCount >= SUBAGENT_LIMITS.queuedRuns || this.#queuedBytes + bytes > SUBAGENT_LIMITS.queuedBytes)
		) {
			throw new SubagentError("task_queue_full");
		}
		run.state = queue ? "queued" : "initializing";
		commit(run);
		this.#runs.set(run.runId, { run, bytes });
		if (queue) {
			queue.push(run.runId);
			this.#queuedCount++;
			this.#queuedBytes += bytes;
		} else this.#queues.set(run.agentId, [run.runId]);
	}

	/** Called only after the owned runtime promise AND all owned tools have settled. */
	finish(runId: string, commit: () => void): SubagentRun | undefined {
		const current = this.#runs.get(runId);
		if (!current) throw new SubagentError("run_not_active");
		const queue = this.#queues.get(current.run.agentId)!;
		const index = queue.indexOf(runId);
		commit();
		queue.splice(index, 1);
		this.#runs.delete(runId);
		if (index > 0) {
			this.#queuedCount--;
			this.#queuedBytes -= current.bytes;
		}
		// The predecessor edges are derived from the updated FIFO, never patched
		// asynchronously. Cancelling A2 changes A3 -> A2 to A3 -> A1 atomically.
		if (!queue.length) this.#queues.delete(current.run.agentId);
		if (index !== 0 || !queue.length) return;
		const next = this.#runs.get(queue[0])!;
		this.#queuedCount--;
		this.#queuedBytes -= next.bytes;
		next.run.state = "initializing";
		return next.run;
	}

	closeAdmission(): void {
		this.#accepting = false;
	}

	addWait(source: string, targets: string[]): () => void {
		const graph = new Map<string, Set<string>>();
		for (const queue of this.#queues.values()) {
			for (let i = 1; i < queue.length; i++) graph.set(queue[i], new Set([queue[i - 1]]));
		}
		for (const wait of this.#waits.values()) {
			const edges = graph.get(wait.source) ?? new Set<string>();
			for (const target of wait.targets) if (this.#runs.has(target)) edges.add(target);
			graph.set(wait.source, edges);
		}
		const reachesSource = (current: string, seen: Set<string>): boolean => {
			if (current === source) return true;
			if (seen.has(current)) return false;
			seen.add(current);
			return [...(graph.get(current) ?? [])].some((target) => reachesSource(target, seen));
		};
		if (targets.some((target) => reachesSource(target, new Set()))) throw new SubagentError("run_wait_cycle");
		const key = Symbol("run-wait");
		this.#waits.set(key, { source, targets: [...targets] });
		return () => {
			this.#waits.delete(key);
		};
	}
}
