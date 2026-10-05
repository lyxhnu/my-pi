import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type SubagentControlRecord, SubagentError } from "./types.ts";

export function controlChecksum(record: Omit<SubagentControlRecord, "checksum">): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

/** Sequential, bounded-workspace scan; completed runs are never retained here. */
export function* readControlLog(file: string, rootSessionId: string): Generator<SubagentControlRecord> {
	const fd = openSync(file, "r");
	const decoder = new StringDecoder("utf8");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let pending = "";
	let sequence = 0;
	let previousChecksum = "";
	function parse(line: string, tail = false): SubagentControlRecord | undefined {
		if (!line.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new SubagentError(tail ? "control_log_incomplete" : "control_log_corrupt");
		}
		if (typeof value !== "object" || value === null || !("type" in value))
			throw new SubagentError("control_log_corrupt");
		if (value.type !== "subagent_control") return;
		const record = value as SubagentControlRecord;
		const { checksum, ...body } = record;
		if (
			record.rootSessionId !== rootSessionId ||
			record.sequence !== sequence + 1 ||
			record.previousChecksum !== previousChecksum ||
			typeof record.id !== "string" ||
			!record.control ||
			checksum !== controlChecksum(body)
		)
			throw new SubagentError("control_log_corrupt");
		sequence = record.sequence;
		previousChecksum = checksum;
		return record;
	}
	try {
		while (true) {
			const length = readSync(fd, buffer, 0, buffer.length, null);
			if (!length) break;
			pending += decoder.write(buffer.subarray(0, length));
			let start = 0;
			let end = pending.indexOf("\n", start);
			while (end !== -1) {
				const record = parse(pending.slice(start, end));
				if (record) yield record;
				start = end + 1;
				end = pending.indexOf("\n", start);
			}
			pending = pending.slice(start);
		}
		pending += decoder.end();
		// A valid checksummed final record is committed even if the writer died
		// before writing its newline. Never refund its identity reservation.
		const final = parse(pending, true);
		if (final) yield final;
	} finally {
		closeSync(fd);
	}
}
