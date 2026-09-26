import { type Static, Type } from "typebox";
import type { ExecutionUpgradeRequest } from "../execution-upgrade.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const schema = Type.Object(
	{
		targetModel: Type.String({
			minLength: 3,
			description: "Exact provider/model from the runtime's available upgrade options.",
		}),
		thinkingLevel: Type.Union(
			(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => Type.Literal(level)),
		),
		reason: Type.String({
			minLength: 1,
			maxLength: 1024,
			description: "Briefly explain why the stronger execution profile is useful now.",
		}),
	},
	{ additionalProperties: false },
);

export function createUpgradeExecutionToolDefinition(
	stage: (callId: string, request: ExecutionUpgradeRequest) => void,
): ToolDefinition<typeof schema> {
	return {
		name: "upgrade_execution",
		label: "upgrade_execution",
		description:
			"Request stronger reasoning or a stronger allowed model for yourself. Decide from the task and observed progress; counters alone do not require an upgrade. You may request an upgrade before a reminder. It takes effect only after this entire tool batch and validation of the next request. The initial result is pending; consult the next execution status for applied, rejected, or cancelled. This never changes tool permissions or the user's defaults.",
		parameters: schema,
		async execute(callId, input) {
			stage(callId, input);
			const details: { status: "pending"; request: Static<typeof schema> } = {
				status: "pending",
				request: input,
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	};
}
