import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

describe("ordinary request preparation", () => {
	it("transforms and converts once even when a hook measures multiple candidates", async () => {
		const faux = registerFauxProvider();
		try {
			let transforms = 0;
			let conversions = 0;
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel() },
				transformContext: async (messages) => {
					transforms++;
					return messages;
				},
				convertToLlm: (messages) => {
					conversions++;
					return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
				},
			});
			agent.prepareRequest = async (_context, prepare) => {
				await prepare({ thinkingLevel: "high" });
				return prepare({ thinkingLevel: "low" });
			};
			faux.setResponses([fauxAssistantMessage("done")]);
			await agent.prompt("work");
			expect(transforms).toBe(1);
			expect(conversions).toBe(1);
		} finally {
			faux.unregister();
		}
	});
	it("runs continuation preparation inside the abort lifecycle", async () => {
		const faux = registerFauxProvider();
		try {
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel(), messages: [{ role: "user", content: "work", timestamp: 0 }] },
			});
			let entered = () => {};
			const preparing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release = () => {};
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			agent.prepareRequest = async (_context, prepare, signal) => {
				expect(agent.state.runState.status).toBe("running");
				expect(signal).toBe(agent.signal);
				entered();
				await wait;
				return prepare();
			};
			const run = agent.continue();
			await preparing;
			agent.abort();
			release();
			await run;
			expect(faux.state.callCount).toBe(0);
			expect(agent.state.runState).toMatchObject({ status: "idle", lastOutcome: { type: "aborted" } });
		} finally {
			faux.unregister();
		}
	});

	it("composes measured worksets without running dispatch effects or altering a frozen request", async () => {
		const faux = registerFauxProvider();
		try {
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel(), messages: [{ role: "user", content: "work", timestamp: 0 }] },
			});
			const modes: Array<string | undefined> = [];
			agent.prepareRequest = async (_context, prepare, _signal, mode) => {
				modes.push(mode);
				return prepare();
			};
			const prepared = await agent.prepareContinuation(agent.state.messages);
			await agent.measurePreparedContinuation(prepared, []);
			faux.setResponses([fauxAssistantMessage("done")]);
			await agent.dispatchPreparedContinuation(prepared);
			expect(modes).toEqual(["measure"]);
			expect(faux.state.callCount).toBe(1);
		} finally {
			faux.unregister();
		}
	});

	it("includes selected follow-up messages before preparing an ordinary continuation", async () => {
		const faux = registerFauxProvider();
		try {
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel(), messages: [fauxAssistantMessage("previous answer")] },
			});
			agent.followUp({ queueItemId: "follow-up", message: { role: "user", content: "next task", timestamp: 0 } });
			agent.prepareRequest = async (context, prepare) => {
				const message = context.messages.at(-1);
				expect(message?.role === "user" ? message.content : undefined).toBe("next task");
				return prepare();
			};
			faux.setResponses([fauxAssistantMessage("done")]);
			await agent.continue();
			expect(agent.hasQueuedMessages()).toBe(false);
			expect(faux.state.callCount).toBe(1);
		} finally {
			faux.unregister();
		}
	});

	it("does not let a requested reasoning increase undo output-truncation recovery", async () => {
		const faux = registerFauxProvider({ models: [{ id: "reasoner", reasoning: true }] });
		try {
			const levels: unknown[] = [];
			const agent = new Agent({
				streamFn: (model, context, options) => {
					levels.push(options?.reasoning);
					return streamSimple(model, context, options);
				},
				initialState: { model: faux.getModel(), thinkingLevel: "high" },
			});
			agent.prepareRequest = async (_context, prepare) => prepare({ thinkingLevel: "high" });
			faux.setResponses([
				fauxAssistantMessage("cut off", { stopReason: "length" }),
				fauxAssistantMessage("cut off again", { stopReason: "length" }),
				fauxAssistantMessage("done"),
			]);
			await agent.prompt("work");
			expect(levels).toEqual(["high", "medium", "low"]);
		} finally {
			faux.unregister();
		}
	});
});
