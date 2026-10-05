import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const FAKE_SERVER_PATH = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));

const fakeLspServers = [
	{ extensions: [".faketslang"], command: process.execPath, args: [FAKE_SERVER_PATH], languageId: "fake" },
];

describe("lsp tool (M6)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("is omitted without a configured server", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getAllTools().map((t) => t.name)).not.toContain("lsp");
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"todo_write",
			"get_task_output",
			"kill_task",
			"history",
			"context_note",
			"get_context_remaining",
			"new_context",
		]);
	});

	it("registers a configured server without expanding the default active tool set", async () => {
		const harness = await createHarness({ lspServers: fakeLspServers });
		harnesses.push(harness);
		expect(harness.session.getAllTools().map((t) => t.name)).toContain("lsp");
		expect(harness.session.getActiveToolNames()).not.toContain("lsp");
	});

	it("goToDefinition, hover, and documentSymbol round-trip through a real Content-Length framed child process", async () => {
		const harness = await createHarness({ lspServers: fakeLspServers });
		harnesses.push(harness);
		const filePath = `${harness.tempDir}/example.faketslang`;
		writeFileSync(filePath, "const x = 1;\n");

		const definition = await harness.session.lspManager.goToDefinition(filePath, 0, 6);
		expect(Array.isArray(definition)).toBe(true);
		expect((definition as any[])[0].range.start).toEqual({ line: 0, character: 0 });

		const hover = await harness.session.lspManager.hover(filePath, 0, 6);
		expect((hover as any).contents).toBe("fake hover text");

		const symbols = await harness.session.lspManager.documentSymbol(filePath);
		expect((symbols as any[])[0].name).toBe("fakeSymbol");

		const workspaceHits = await harness.session.lspManager.workspaceSymbol("Foo");
		expect((workspaceHits as any[])[0].name).toBe("match:Foo");
	});

	it("re-syncs the document (didChange) when the file on disk changes between calls", async () => {
		const harness = await createHarness({ lspServers: fakeLspServers });
		harnesses.push(harness);
		const fs = { writeFileSync };
		const filePath = `${harness.tempDir}/changing.faketslang`;
		fs.writeFileSync(filePath, "first version\n");
		await harness.session.lspManager.hover(filePath, 0, 0);

		await new Promise((resolve) => setTimeout(resolve, 5));
		fs.writeFileSync(filePath, "second, different version\n");
		// Should not throw even though the file changed underneath an already-open document.
		await expect(harness.session.lspManager.hover(filePath, 0, 0)).resolves.toBeTruthy();
	});

	it("surfaces a clear error via the lsp tool when no server is configured for the file type", async () => {
		const harness = await createHarness({
			lspServers: fakeLspServers,
			initialActiveToolNames: ["lsp"],
			settings: { permissions: { allow: [{ pattern: "lsp:*" }] } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("lsp", { operation: "hover", file_path: "no-such-language.zzz", line: 0, character: 0 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("hover over this symbol");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
		expect(getMessageText(toolResult)).toContain("No language server is configured");
	});

	it("the lsp tool returns real hover text end-to-end through the agent loop", async () => {
		const harness = await createHarness({
			lspServers: fakeLspServers,
			initialActiveToolNames: ["lsp"],
			settings: { permissions: { allow: [{ pattern: "lsp:*" }] } },
		});
		harnesses.push(harness);
		const filePath = `${harness.tempDir}/example2.faketslang`;
		writeFileSync(filePath, "const y = 2;\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("lsp", { operation: "hover", file_path: filePath, line: 0, character: 6 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("hover over y");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(getMessageText(toolResult)).toContain("fake hover text");
	});

	it("spec 11: a server that keeps crashing on startup is restarted at most MAX_SERVER_RESTARTS (2) times, then given up on", async () => {
		const spawnLogPath = `${tmpdir()}/pi-lsp-spawn-log-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
		const crashingServers = [
			{
				extensions: [".faketslang"],
				command: process.execPath,
				args: [FAKE_SERVER_PATH, "--crash-after-init", "--spawn-log", spawnLogPath],
				languageId: "fake",
			},
		];
		const harness = await createHarness({ lspServers: crashingServers });
		harnesses.push(harness);
		const filePath = `${harness.tempDir}/crashy.faketslang`;
		writeFileSync(filePath, "const z = 3;\n");

		// The very first call's own hover request may or may not land before the server exits (racy by
		// nature of "crashes immediately"); either outcome is fine here — what this test cares about is
		// how many times the manager (re)spawned the process afterwards, not this call's result.
		await harness.session.lspManager.hover(filePath, 0, 0).catch(() => undefined);

		// The crash -> auto-restart cascade is local process spawn + immediate exit, but this run may be
		// sharing the machine with many other parallel test workers, so poll for the expected count
		// (bounded, generous timeout) rather than assuming a fixed wall-clock wait is always enough.
		const countSpawns = () => {
			try {
				return readFileSync(spawnLogPath, "utf-8").split("\n").filter(Boolean).length;
			} catch {
				return 0;
			}
		};
		// Exactly 1 initial spawn + MAX_SERVER_RESTARTS (2) automatic restarts = 3 total, then given up on.
		for (let i = 0; i < 100 && countSpawns() < 3; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(countSpawns()).toBe(3);

		// Confirm it really has given up (not just "hasn't gotten around to restarting yet"): waiting
		// longer must not produce a 4th spawn.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(countSpawns()).toBe(3);
	});
});
