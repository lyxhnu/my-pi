import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SubagentError } from "./types.ts";

export type SessionOwnership =
	| { kind: "root"; rootSessionId: string; rootFile: string }
	| { kind: "child"; rootSessionId: string; rootFile: string; agentId: string; sessionId: string };

export function canonicalSessionFile(file: string): string {
	const absolute = resolve(file);
	const canonical = existsSync(absolute)
		? realpathSync.native(absolute)
		: join(realpathSync.native(dirname(absolute)), basename(absolute));
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

interface OwnedSession {
	sessionId: string;
	agentId?: string;
	file: string;
	committed: boolean;
	manager?: object;
}

/**
 * An OS-backed exclusive lease. SQLite is used only for its native file lock,
 * not as a session store. A stalled event loop cannot expire the lease; process
 * death releases it without unlinking or stealing a live owner's lock file.
 */
export class RootSessionOwnership {
	readonly rootSessionId: string;
	readonly rootFile: string;
	readonly lockFile: string;
	readonly #database: DatabaseSync;
	readonly #sessions = new Map<string, OwnedSession>();
	#active = true;
	static readonly #owners = new Map<string, RootSessionOwnership>();

	private constructor(rootSessionId: string, rootFile: string, lockFile: string, database: DatabaseSync) {
		this.rootSessionId = rootSessionId;
		this.rootFile = rootFile;
		this.lockFile = lockFile;
		this.#database = database;
		this.#sessions.set(rootSessionId, { sessionId: rootSessionId, file: rootFile, committed: true });
	}

	static acquire(rootSessionId: string, file: string, bindFile = true): RootSessionOwnership {
		if (RootSessionOwnership.#owners.has(rootSessionId)) throw new SubagentError("root_in_use");
		const rootFile = canonicalSessionFile(file);
		const directory = join(tmpdir(), "pi-root-session-ownership");
		mkdirSync(directory, { recursive: true });
		const lockFile = join(directory, `${createHash("sha256").update(rootSessionId).digest("hex")}.sqlite`);
		const database = new DatabaseSync(lockFile, { timeout: 0, allowExtension: false });
		try {
			database.exec(
				"PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (root_file TEXT NOT NULL)",
			);
			const previous = database.prepare("SELECT root_file FROM ownership LIMIT 1").get();
			if (previous && previous.root_file !== rootFile) throw new SubagentError("root_file_mismatch");
			if (!previous && bindFile) database.prepare("INSERT INTO ownership (root_file) VALUES (?)").run(rootFile);
			// EXCLUSIVE locking_mode retains the OS lock after commit, while the
			// immutable root-file binding survives a crash of this process.
			database.exec("COMMIT; BEGIN EXCLUSIVE");
		} catch (error) {
			database.close();
			if (error instanceof SubagentError) throw error;
			if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) {
				throw new SubagentError("root_in_use");
			}
			throw error;
		}
		const ownership = new RootSessionOwnership(rootSessionId, rootFile, lockFile, database);
		RootSessionOwnership.#owners.set(rootSessionId, ownership);
		return ownership;
	}

	assertActive(): void {
		if (!this.#active || RootSessionOwnership.#owners.get(this.rootSessionId) !== this) {
			throw new SubagentError("session_ownership_revoked");
		}
	}

	registerChild(agentId: string, sessionId: string, file: string, committed: boolean): void {
		this.assertActive();
		const canonical = canonicalSessionFile(file);
		const previous = this.#sessions.get(sessionId);
		if (previous) {
			if (previous.agentId !== agentId || previous.file !== canonical) {
				throw new SubagentError("child_session_binding_mismatch");
			}
			previous.committed ||= committed;
			return;
		}
		if ([...this.#sessions.values()].some((item) => item.file === canonical || item.agentId === agentId)) {
			throw new SubagentError("child_session_binding_mismatch");
		}
		this.#sessions.set(sessionId, { agentId, sessionId, file: canonical, committed });
	}

	claim(ownership: SessionOwnership, sessionId: string, file: string, manager: object): void {
		this.assertActive();
		const registered = this.#sessions.get(sessionId);
		if (
			ownership.rootSessionId !== this.rootSessionId ||
			canonicalSessionFile(ownership.rootFile) !== this.rootFile ||
			!registered ||
			registered.file !== canonicalSessionFile(file) ||
			(ownership.kind === "root"
				? sessionId !== this.rootSessionId
				: ownership.sessionId !== sessionId || registered.agentId !== ownership.agentId)
		) {
			throw new SubagentError("child_session_binding_mismatch");
		}
		if (registered.manager && registered.manager !== manager) throw new SubagentError("session_in_use");
		registered.manager = manager;
	}

	assertManager(sessionId: string, file: string, manager: object): void {
		this.assertActive();
		const registered = this.#sessions.get(sessionId);
		if (!registered || registered.file !== canonicalSessionFile(file) || registered.manager !== manager) {
			throw new SubagentError("session_ownership_mismatch");
		}
	}

	releaseManager(sessionId: string, manager: object): void {
		this.assertActive();
		const registered = this.#sessions.get(sessionId);
		if (registered?.manager !== manager) throw new SubagentError("session_ownership_mismatch");
		registered.manager = undefined;
	}

	close(): void {
		if (!this.#active) return;
		this.#active = false;
		RootSessionOwnership.#owners.delete(this.rootSessionId);
		this.#database.close();
	}
}
