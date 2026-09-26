import { Type } from "typebox";
import type { ContextRemaining } from "../context-budget.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";

const remainingSchema = Type.Object({}, { additionalProperties: false });
const newContextSchema = Type.Object(
	{ reason: Type.String({ minLength: 1, maxLength: 512 }) },
	{ additionalProperties: false },
);

export function createContextRemainingToolDefinition(
	getSnapshot: () => ContextRemaining,
): ToolDefinition<typeof remainingSchema> {
	return {
		name: "get_context_remaining",
		label: "get_context_remaining",
		description:
			"Get the latest final-request budget estimate and measurement point. This result and later messages consume more tokens; every actual request is measured again.",
		parameters: remainingSchema,
		async execute() {
			const snapshot = getSnapshot();
			return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
		},
	};
}

export function createNewContextToolDefinition(manager: SessionManager): ToolDefinition<typeof newContextSchema> {
	return {
		name: "new_context",
		label: "new_context",
		description:
			"Call this when the task is unfinished and the current context cannot support the next useful step, including when Shake and Compaction leave insufficient working capacity. Save important semantic changes with context_note first. The complete current tool batch finishes before the runtime switches windows.",
		parameters: newContextSchema,
		async execute(toolCallId, input) {
			const requestId = manager.requestContextTransition(toolCallId, input.reason);
			return {
				content: [{ type: "text", text: JSON.stringify({ status: "requested", requestId }) }],
				details: { requestId },
			};
		},
	};
}
