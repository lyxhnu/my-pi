import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import type { RootSessionOwnership } from "../src/core/subagents/session-ownership.ts";

const directories: string[] = [];
const sessions: SessionManager[] = [];
const owners: RootSessionOwnership[] = [];
const processes: ChildProcessWithoutNullStreams[] = [];
const fixture = fileURLToPath(new URL("./fixtures/subagent-ownership-process.ts", import.meta.url));

function root(): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagent-ownership-"));
	directories.push(directory);
	const session = SessionManager.create(directory, directory);
	sessions.push(session);
	return session;
}

async function childProcess(
	rootId: string,
	file: string,
): Promise<{ process: ChildProcessWithoutNullStreams; output: string }> {
	const process = spawn(globalThis.process.execPath, [fixture, rootId, file], { stdio: "pipe" });
	processes.push(process);
	const output = await new Promise<string>((resolve, reject) => {
		let text = "";
		process.stdout.on("data", (chunk: Buffer) => {
			text += chunk.toString();
			if (text.includes("\n")) resolve(text.trim());
		});
		process.once("error", reject);
		process.once("exit", () =>
			text ? resolve(text.trim()) : reject(new Error("Ownership probe exited without output")),
		);
	});
	return { process, output };
}

afterEach(async () => {
	for (const process of processes.splice(0)) {
		if (process.exitCode !== null || process.signalCode !== null) continue;
		await new Promise<void>((resolve) => {
			process.once("exit", () => resolve());
			process.kill();
		});
	}
	for (const session of sessions.splice(0).reverse()) session.closeOwnership();
	for (const owner of owners.splice(0)) owner.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("subagent session ownership", () => {
	it("forks an owned root into a new identity without copying quota records", () => {
		const session = root();
		session.claimRootOwnership();
		const entry = session.appendCustomEntry("retained", { value: 1 });
		session.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid });
		const fork = session.forkBranch(entry);
		sessions.push(fork);
		expect(fork.getSessionId()).not.toBe(session.getSessionId());
		expect(fork.getHeader()?.ownership).toBeUndefined();
		expect(fork.getEntry(entry)?.type).toBe("custom");
		fork.claimRootOwnership();
		expect([...fork.readSubagentControl()]).toEqual([]);
	});

	it("rejects import copying a child or overwriting a managed destination", () => {
		const session = root();
		const owner = session.claimRootOwnership();
		const file = join(session.getSessionDir(), "child.jsonl");
		const child = SessionManager.createChild(session.getCwd(), file, randomUUID(), randomUUID(), owner);
		sessions.push(child);
		expect(() => SessionManager.copyIndependentSession(file, join(session.getSessionDir(), "copy.jsonl"))).toThrow(
			"child_requires_root",
		);
		const plain = SessionManager.create(session.getCwd(), session.getSessionDir());
		plain.flush();
		expect(() => SessionManager.copyIndependentSession(plain.getSessionFile()!, file)).toThrow(
			"session_ownership_required",
		);
	});
	it("rejects another writer in this process and another process", async () => {
		const session = root();
		session.claimRootOwnership();
		expect(() => SessionManager.open(session.getSessionFile()!)).toThrow("root_in_use");
		const probe = await childProcess(session.getSessionId(), session.getSessionFile()!);
		expect(probe.output).toBe("root_in_use");
	});

	it("releases a native lease on process death without stealing a live lease", async () => {
		const session = root();
		session.flush();
		const probe = await childProcess(session.getSessionId(), session.getSessionFile()!);
		expect(probe.output).toBe("owned");
		expect(() => session.claimRootOwnership()).toThrow("root_in_use");
		await new Promise<void>((resolve) => {
			probe.process.once("exit", () => resolve());
			probe.process.kill();
		});
		expect(() => session.claimRootOwnership()).not.toThrow();
	});

	it("rejects stale ordinary managers and revoked managers", () => {
		const session = root();
		session.flush();
		const stale = SessionManager.open(session.getSessionFile()!);
		session.claimRootOwnership();
		expect(() => stale.appendCustomEntry("stale", {})).toThrow("root_in_use");
		session.closeOwnership();
		expect(() => stale.appendCustomEntry("stale", {})).toThrow("session_ownership_required");
		expect(() => session.appendCustomEntry("closed", {})).toThrow("session_ownership_revoked");
		expect(() => session.newSession()).toThrow("session_ownership_revoked");
	});

	it("rejects standalone child open, fork and identity changes before mutation", () => {
		const session = root();
		const ownership = session.claimRootOwnership();
		const file = join(session.getSessionDir(), "child.jsonl");
		const child = SessionManager.createChild(session.getCwd(), file, randomUUID(), randomUUID(), ownership);
		sessions.push(child);
		const before = readFileSync(file, "utf8");
		expect(() => SessionManager.open(file)).toThrow("Open root");
		expect(() => SessionManager.open(file, undefined, session.getCwd())).toThrow("Open root");
		expect(() => SessionManager.forkFrom(file, session.getCwd(), session.getSessionDir())).toThrow(
			"child_requires_root",
		);
		expect(() => child.newSession()).toThrow("managed_session_identity_fixed");
		expect(() => child.setSessionFile(session.getSessionFile()!)).toThrow("managed_session_identity_fixed");
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("rejects duplicate child managers and copied identities", () => {
		const session = root();
		const ownership = session.claimRootOwnership();
		const file = join(session.getSessionDir(), "child.jsonl");
		const child = SessionManager.createChild(session.getCwd(), file, randomUUID(), randomUUID(), ownership);
		sessions.push(child);
		expect(() => SessionManager.open(file, undefined, undefined, ownership)).toThrow("session_in_use");
		const copy = join(session.getSessionDir(), "copy.jsonl");
		copyFileSync(file, copy);
		expect(() => SessionManager.open(copy, undefined, undefined, ownership)).toThrow(
			"child_session_binding_mismatch",
		);
		copyFileSync(session.getSessionFile()!, copy);
		expect(() => SessionManager.open(copy)).toThrow("root_file_mismatch");
	});

	it("does not rewrite a changed file while activating ownership", () => {
		const session = root();
		session.flush();
		const other = SessionManager.open(session.getSessionFile()!);
		other.appendCustomEntry("new", { value: 1 });
		const before = readFileSync(session.getSessionFile()!, "utf8");
		expect(() => session.claimRootOwnership()).toThrow("session_changed_since_open");
		expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(before);
	});

	it("rejects a child without a root registration before migration", () => {
		const session = root();
		const owner = session.claimRootOwnership();
		const file = join(session.getSessionDir(), "orphan.jsonl");
		writeFileSync(
			file,
			JSON.stringify({
				type: "session",
				id: "orphan",
				version: 1,
				ownership: {
					kind: "child",
					rootSessionId: owner.rootSessionId,
					rootFile: owner.rootFile,
					agentId: "unknown",
					sessionId: "orphan",
				},
			}),
		);
		const before = readFileSync(file, "utf8");
		expect(() => SessionManager.open(file, undefined, undefined, owner)).toThrow("child_session_binding_mismatch");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});
