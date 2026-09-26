import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryAuthority } from "../memory/memory-authority.ts";
import type { MemoryQueryContext } from "../memory/types.ts";

const memoryGetSchema = Type.Object(
	{
		memoryId: Type.String({ description: "Memory ID returned by memory_search." }),
		includeUnverified: Type.Optional(Type.Boolean()),
		includeHistory: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type MemoryGetToolInput = Static<typeof memoryGetSchema>;

export function createMemoryGetToolDefinition(
	authority: MemoryAuthority,
	queryContext: () => MemoryQueryContext,
): ToolDefinition<typeof memoryGetSchema, { memoryId: string; revision: number; relatedMemoryIds: string[] }> {
	return {
		name: "memory_get",
		label: "memory_get",
		description:
			"Read one authorized long-term memory record by memory ID. Status and applicability checks are identical to memory_search.",
		promptSnippet: "Read one verified memory record by ID",
		parameters: memoryGetSchema,
		async execute(_toolCallId, input: MemoryGetToolInput) {
			const context = queryContext();
			const options = {
				includeUnverified: input.includeUnverified,
				includeHistory: input.includeHistory,
			};
			const record = authority.getMemory(input.memoryId, context, options);
			if (!record) throw new Error(`Memory record "${input.memoryId}" is unavailable in the current context.`);
			const expanded = authority.search(record.subject, context, options, 1);
			const records = expanded.some((candidate) => candidate.memoryId === record.memoryId) ? expanded : [record];
			return {
				content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
				details: {
					memoryId: record.memoryId,
					revision: record.revision,
					relatedMemoryIds: records
						.filter((candidate) => candidate.memoryId !== record.memoryId)
						.map((candidate) => candidate.memoryId),
				},
			};
		},
		renderCall(args, theme) {
			const memoryId = typeof args?.memoryId === "string" ? args.memoryId : "";
			return new Text(theme.fg("toolTitle", theme.bold(`memory_get ${memoryId}`)), 0, 0);
		},
	};
}
