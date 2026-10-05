import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const sessions: SessionManager[] = [];
const directories: string[] = [];
function root(): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagent-log-"));
	directories.push(directory);
	const session = SessionManager.create(directory, directory);
	session.claimRootOwnership();
	sessions.push(session);
	return session;
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.closeOwnership();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("subagent control log", () => {
	it("commits immediately without advancing or retaining the conversation tree", () => {
		const session = root();
		const leaf = session.getLeafId();
		const record = session.appendSubagentControl({ kind: "root_phase", phase: "opening", processId: process.pid });
		expect(record.sequence).toBe(1);
		expect(session.getLeafId()).toBe(leaf);
		expect(session.getEntries()).toEqual([]);
		expect([...session.readSubagentControl()]).toEqual([record]);
		session.closeOwnership();
		const reopened = SessionManager.open(session.getSessionFile()!);
		sessions.push(reopened);
		expect(reopened.getEntries()).toEqual([]);
		expect([...reopened.readSubagentControl()]).toEqual([record]);
		expect(
			reopened.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid }).sequence,
		).toBe(2);
	});

	it("does not load a long control history into ordinary history", () => {
		const session = root();
		for (let i = 0; i < 100; i++)
			session.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid });
		session.closeOwnership();
		const reopened = SessionManager.open(session.getSessionFile()!);
		sessions.push(reopened);
		expect(reopened.getEntries()).toHaveLength(0);
		expect([...reopened.readSubagentControl()]).toHaveLength(100);
	});

	it("rejects checksum changes and missing records", () => {
		const session = root();
		session.appendSubagentControl({ kind: "root_phase", phase: "opening", processId: process.pid });
		session.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid });
		const file = session.getSessionFile()!;
		const original = readFileSync(file, "utf8");
		writeFileSync(file, original.replace('"phase":"opening"', '"phase":"closing"'));
		expect(() => [...session.readSubagentControl()]).toThrow("control_log_corrupt");
		const lines = original.trimEnd().split("\n");
		writeFileSync(file, `${lines[0]}\n${lines[2]}\n`);
		expect(() => [...session.readSubagentControl()]).toThrow("control_log_corrupt");
	});

	it("recovers a valid final commit without a newline and separates the next record", () => {
		const session = root();
		const record = session.appendSubagentControl({ kind: "root_phase", phase: "opening", processId: process.pid });
		const file = session.getSessionFile()!;
		writeFileSync(file, readFileSync(file, "utf8").trimEnd());
		expect([...session.readSubagentControl()]).toEqual([record]);
		session.closeOwnership();
		const reopened = SessionManager.open(file);
		sessions.push(reopened);
		const next = reopened.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid });
		expect(next.sequence).toBe(2);
		expect([...reopened.readSubagentControl()]).toEqual([record, next]);
	});

	it("rejects an incomplete tail instead of silently granting quota", () => {
		const session = root();
		appendFileSync(session.getSessionFile()!, '{"type":"subagent_control"');
		expect(() => [...session.readSubagentControl()]).toThrow("control_log_incomplete");
		expect(() =>
			session.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid }),
		).toThrow();
		expect(() =>
			session.appendSubagentControl({ kind: "root_phase", phase: "open", processId: process.pid }),
		).toThrow();
	});
});
