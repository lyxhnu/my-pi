import { AsyncLocalStorage } from "node:async_hooks";
import { SubagentError } from "./types.ts";

interface RunLease {
	runId: string;
	controller: AbortController;
	signal: AbortSignal;
	accepting: boolean;
	work: Set<Promise<unknown>>;
}

/** Host-issued authority follows async calls; a stale callback cannot enter a later run. */
export class SubagentRunScope {
	readonly #context = new AsyncLocalStorage<RunLease>();
	#active?: RunLease;
	#done?: Promise<unknown>;
	#closed = false;
	readonly #onExternalEffect?: (runId: string) => void;

	constructor(onExternalEffect?: (runId: string) => void) {
		this.#onExternalEffect = onExternalEffect;
	}

	markExternalEffect(): void {
		this.#onExternalEffect?.(this.assertActive().runId);
	}

	get hasContext(): boolean {
		return this.#context.getStore() !== undefined;
	}

	/** Only the root host may admit fresh user input into an already running turn. */
	join<T>(work: () => Promise<T>): Promise<T> {
		if (this.hasContext) return this.track(work);
		if (!this.#active) throw new SubagentError("run_not_active");
		return this.#context.run(this.#active, () => this.track(work));
	}

	abort(): void {
		this.#active?.controller.abort();
	}

	get isCurrent(): boolean {
		return this.#active !== undefined && this.#context.getStore() === this.#active && this.#active.accepting;
	}

	assertActive(): { runId: string; signal: AbortSignal } {
		const lease = this.#context.getStore();
		if (this.#closed || !lease || lease !== this.#active || !lease.accepting)
			throw new SubagentError("subagent_run_authority_required");
		if (lease.signal.aborted) throw new SubagentError("run_cancelled");
		return { runId: lease.runId, signal: lease.signal };
	}

	track<T>(work: () => Promise<T>): Promise<T> {
		this.assertActive();
		const lease = this.#active!;
		const promise = Promise.resolve().then(() => {
			this.assertActive();
			return work();
		});
		lease.work.add(promise);
		// Observe rejection without creating an unhandled rejected cleanup promise.
		void promise.then(
			() => lease.work.delete(promise),
			() => lease.work.delete(promise),
		);
		return promise;
	}

	/** The owner drains accepted continuations before collecting results or releasing tools. */
	async drain(): Promise<void> {
		const lease = this.#context.getStore();
		if (!lease || lease !== this.#active) throw new SubagentError("subagent_run_authority_required");
		while (lease.work.size) await Promise.allSettled([...lease.work]);
	}

	/** Atomically stop admission once both tracked continuations and host tools are idle. */
	seal(): boolean {
		const lease = this.#context.getStore();
		if (!lease || lease !== this.#active) throw new SubagentError("subagent_run_authority_required");
		if (lease.work.size) return false;
		lease.accepting = false;
		return true;
	}

	run<T>(runId: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#closed) throw new SubagentError("subagent_session_closed");
		if (this.#active) throw new SubagentError("subagent_run_busy");
		const controller = new AbortController();
		const lease: RunLease = {
			runId,
			controller,
			signal: AbortSignal.any([signal, controller.signal]),
			accepting: true,
			work: new Set(),
		};
		this.#active = lease;
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (error: unknown) => void;
		const done = new Promise<T>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		// Publish settlement before running user code: an immediate close must
		// wait for this execution, even before its first asynchronous suspension.
		this.#done = done;
		void this.#context
			.run(lease, async () => {
				try {
					this.assertActive();
					return await work(lease.signal);
				} finally {
					lease.accepting = false;
					while (lease.work.size) await Promise.allSettled([...lease.work]);
					this.#active = undefined;
				}
			})
			.then(resolve, reject);
		return done;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#active?.controller.abort();
		await this.#done?.then(
			() => undefined,
			() => undefined,
		);
	}
}
