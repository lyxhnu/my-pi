/**
 * Append-only context mode — stabilizes the byte prefix sent to the provider across turns so
 * prompt caches (Anthropic, DeepSeek, local llama.cpp/vLLM, ...) hit at the highest possible rate.
 *
 * The default path rebuilds and re-serializes the whole transcript on every turn. Providers key
 * their KV cache on the request's byte prefix, so any rebuild that perturbs an early message
 * invalidates everything after it and bills a fresh prefill. Two mechanisms avoid that:
 *
 * 1. **StablePrefix** — the system prompt and tool specs are snapshotted once and reused verbatim
 *    until their fingerprint actually changes.
 *
 * 2. **AppendOnlyLog** — messages only grow. On a normal turn only the new tail is appended, so
 *    the cached prefix stays byte-identical.
 *
 * The interesting case is neither: a *rewrite*. Compaction shortens the transcript, and shake
 * rewrites individual messages in place. {@link AppendOnlyContextManager.syncMessages} handles both
 * by comparing per-message digests and preserving the longest byte-stable prefix, so a rewrite
 * costs a re-prefill only from the message that actually changed rather than from message zero.
 */

import type { Context, Message } from "@earendil-works/pi-ai";

/** Frozen system prompt + tool spec snapshot. */
export interface StablePrefixSnapshot {
	systemPrompt: string;
	tools: Context["tools"];
	fingerprint: string;
}

/**
 * A frozen prefix (system prompt + tools) that produces the same bytes across `build()` calls.
 *
 * The first `build()` snapshots live state; later calls reuse it until the live fingerprint changes
 * or `invalidate()` is called. This alone recovers a real waste in the default path: the host
 * rebuilds `systemPrompt`/`tools` every turn (see AgentSession's next-turn refresh), producing new
 * objects with identical content.
 */
export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}

	get version(): number {
		return this.#version;
	}

	get built(): boolean {
		return this.#snapshot !== null;
	}

	/** Build or rebuild from live context. Returns true when the prefix actually changed. */
	build(context: Pick<Context, "systemPrompt" | "tools">): boolean {
		const snapshot = takeSnapshot(context);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#version++;
		return true;
	}

	/** Force a rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
	}

	/** Create an isolated copy suitable for speculative request preparation. */
	fork(): StablePrefix {
		const copy = new StablePrefix();
		copy.#snapshot = this.#snapshot;
		copy.#version = this.#version;
		return copy;
	}

	/** Replace this prefix with a previously prepared copy. */
	replaceWith(source: StablePrefix): void {
		this.#snapshot = source.#snapshot;
		this.#version = source.#version;
	}

	/**
	 * The cached prefix.
	 * @throws if `build()` was never called.
	 */
	toContext(): { systemPrompt: string; tools: Context["tools"] } {
		const snapshot = this.#snapshot;
		if (!snapshot) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: snapshot.systemPrompt, tools: snapshot.tools };
	}
}

/**
 * Append-only message log at the provider `Message[]` layer.
 *
 * Every operation grows the log except {@link truncate}, which exists so `syncMessages` can drop
 * back to a stable prefix, and {@link clear}, for a full replay.
 */
export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: Message): void {
		this.#entries.push(message);
	}

	extend(messages: readonly Message[]): void {
		for (const message of messages) this.#entries.push(message);
	}

	/** A shallow copy of all entries. */
	toMessages(): Message[] {
		return this.#entries.slice();
	}

	/** Readonly access for in-place inspection. */
	entries(): readonly Message[] {
		return this.#entries;
	}

	/** Drop entries past index `count`, keeping the first `count` byte-stable. */
	truncate(count: number): void {
		const bounded = count < 0 ? 0 : count;
		if (bounded >= this.#entries.length) return;
		this.#entries.length = bounded;
	}

	clear(): void {
		this.#entries = [];
	}

	/** Replace the log without sharing its mutable backing array. */
	replaceWith(source: AppendOnlyLog): void {
		this.#entries = source.#entries.slice();
	}
}

/**
 * Owns a stable prefix plus an append-only log for one conversation.
 *
 * Call {@link build} each turn for a `Context` with a stable prefix, and {@link syncMessages} with
 * the freshly converted provider messages to grow the log.
 */
export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	/** How many converted messages were synced into the log as of the last sync. */
	#lastSyncCount = 0;
	/** Per-message digests of the synced log, so a rewrite can be located rather than assumed. */
	#messageDigests: number[] = [];
	/** Provider/model the log was built against, to notice a switch. */
	#modelKey: string | undefined;

	/**
	 * Tell the manager which model the next request targets, resetting on a switch.
	 *
	 * The stored messages stay valid across a switch, but the prefix and the assumption that a warm
	 * cache exists do not: tool sets and system prompts are model-dependent, and the new provider has
	 * nothing cached for us. Called by the host, which is where the model is known.
	 */
	noteModel(provider: string, modelId: string): void {
		const key = `${provider}/${modelId}`;
		if (this.#modelKey === key) return;
		const isSwitch = this.#modelKey !== undefined;
		this.#modelKey = key;
		if (isSwitch) this.invalidateForModelChange();
	}

	build(context: Pick<Context, "systemPrompt" | "tools">): Context {
		this.prefix.build(context);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	/**
	 * Sync converted provider messages into the log. Three cases:
	 *
	 * 1. **Append** — same prefix, new tail: push the new entries.
	 * 2. **Compaction** — the array shrank: nothing previously synced can be carried forward, so
	 *    clear and replay.
	 * 3. **In-place rewrite** (shake, per-turn pruning, a context hook re-render): find the longest
	 *    byte-stable prefix shared with the previous sync, drop to it, and append the diverged tail.
	 *    Clearing everything here instead would force a full re-prefill on every turn that rewrote a
	 *    single message — the exact cost this mode exists to avoid.
	 */
	syncMessages(messages: readonly Message[]): void {
		if (messages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
			this.#messageDigests = [];
		}

		if (this.#lastSyncCount > 0) {
			// Bounded by the physical log length: `clear()` is public, so a direct clear can leave the
			// sync cursor ahead of the log.
			const stableCount = Math.min(this.#longestStablePrefix(messages), this.log.length);
			if (stableCount < this.#lastSyncCount) {
				this.log.truncate(stableCount);
				this.#lastSyncCount = stableCount;
				this.#messageDigests.length = stableCount;
			}
		}

		for (let i = this.#lastSyncCount; i < messages.length; i++) {
			const message = messages[i];
			this.log.append(message);
			this.#messageDigests.push(messageDigest(message));
		}
		this.#lastSyncCount = messages.length;
	}

	/** Reset prefix and log for a model/provider switch: a different model caches nothing of ours. */
	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	/** Clear the log and the sync cursor, keeping the prefix snapshot. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	/** Force the prefix to be rebuilt on the next `build()` (e.g. after a tool set change). */
	invalidate(): void {
		this.prefix.invalidate();
	}

	/**
	 * Create an isolated manager for speculative request preparation.
	 * The live cache is unchanged until {@link replaceWith} is called.
	 */
	fork(): AppendOnlyContextManager {
		const copy = new AppendOnlyContextManager();
		copy.prefix.replaceWith(this.prefix.fork());
		copy.log.replaceWith(this.log);
		copy.#lastSyncCount = this.#lastSyncCount;
		copy.#messageDigests = this.#messageDigests.slice();
		copy.#modelKey = this.#modelKey;
		return copy;
	}

	/** Commit a prepared manager snapshot. */
	replaceWith(source: AppendOnlyContextManager): void {
		this.prefix.replaceWith(source.prefix);
		this.log.replaceWith(source.log);
		this.#lastSyncCount = source.#lastSyncCount;
		this.#messageDigests = source.#messageDigests.slice();
		this.#modelKey = source.#modelKey;
	}

	/**
	 * Index of the first message whose bytes differ from the previously-synced log; equals
	 * `min(lastSyncCount, messages.length)` when nothing diverged.
	 */
	#longestStablePrefix(messages: readonly Message[]): number {
		const bound = Math.min(this.#lastSyncCount, messages.length);
		for (let i = 0; i < bound; i++) {
			if (messageDigest(messages[i]) !== this.#messageDigests[i]) return i;
		}
		return bound;
	}
}

/**
 * Digest over every field the provider may serialize — role, content, tool calls (internal
 * camelCase and OpenAI-wire snake_case), tool-result identity and error flag, and assistant id — so
 * an in-place rewrite of *any* of them is visible to the stable-prefix scan. Missing a field would
 * silently keep a stale message in the log.
 */
function messageDigest(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const record = message as Record<string, unknown>;
	return hashString(
		JSON.stringify({
			r: record.role ?? null,
			c: record.content ?? null,
			tc: record.toolCalls ?? record.tool_calls ?? null,
			tcid: record.toolCallId ?? record.tool_call_id ?? null,
			tn: record.toolName ?? record.name ?? null,
			err: record.isError ?? null,
			id: record.id ?? null,
		}),
	);
}

function takeSnapshot(context: Pick<Context, "systemPrompt" | "tools">): StablePrefixSnapshot {
	const systemPrompt = context.systemPrompt ?? "";
	const tools = context.tools?.slice() as Context["tools"];
	return { systemPrompt, tools, fingerprint: computeFingerprint(systemPrompt, context.tools) };
}

function computeFingerprint(systemPrompt: Context["systemPrompt"], tools: Context["tools"]): string {
	return hashString(
		JSON.stringify({
			s: systemPrompt,
			t: tools?.map((tool) => ({ n: tool.name, d: tool.description, p: tool.parameters })) ?? null,
		}),
	).toString(36);
}

/** djb2-xor style 32-bit hash. Collision risk is irrelevant: a miss only costs a re-prefill. */
function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
	}
	return hash >>> 0;
}
