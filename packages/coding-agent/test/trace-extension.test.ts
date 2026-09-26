import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import traceExtension, { buildRows, buildTraceTurns, turnLabel } from "../src/extensions/trace/index.ts";

describe("trace extension", () => {
	it("registers the /trace command", async () => {
		const extension = await loadExtensionFromFactory(
			traceExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:trace>",
		);

		expect(extension.commands.get("trace")?.description).toBe(
			"Inspect the latest agent execution trace (/trace list or /trace <turn>)",
		);
	});

	it("projects one recorded turn into readable timeline rows", () => {
		const entries: SessionEntry[] = [
			{
				type: "trace",
				id: "trace-start",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				event: { type: "turn/start", data: { turn: 3 } },
			},
			{
				type: "trace",
				id: "step-start",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.010Z",
				event: { type: "step/start", data: { turn: 3, step: 0 } },
			},
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.020Z",
				message: { role: "user", content: "inspect trace", timestamp: 20 },
			},
			{
				type: "trace",
				id: "request",
				parentId: "user",
				timestamp: "2026-01-01T00:00:00.030Z",
				event: {
					type: "request/header",
					data: {
						turn: 3,
						step: 0,
						header: { provider: "test", model: "model", messages: [] },
					},
				},
			},
			{
				type: "trace",
				id: "step-end",
				parentId: "user",
				timestamp: "2026-01-01T00:00:00.060Z",
				event: { type: "step/end", data: { turn: 3, step: 0, stopReason: "stop" } },
			},
			{
				type: "trace",
				id: "trace-end",
				parentId: "user",
				timestamp: "2026-01-01T00:00:00.080Z",
				event: { type: "turn/end", data: { turn: 3, stopReason: "stop", willRetry: false } },
			},
		];

		const turns = buildTraceTurns(entries);
		expect(turns).toHaveLength(1);
		expect(turnLabel(turns[0]!)).toBe("Turn 3 · 1 step · 0 tools · 80ms");
		expect(buildRows(turns[0]!).map((row) => row.label)).toEqual(
			expect.arrayContaining([
				expect.stringContaining('user/message "inspect trace"'),
				expect.stringContaining("request/header test/model · thinking off · 0 messages · 0 tools"),
				expect.stringContaining("step/end #0 · stop · 50ms"),
			]),
		);
	});
});
