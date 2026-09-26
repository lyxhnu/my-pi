import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryAuthority } from "../memory/memory-authority.ts";
import type { MemoryQueryContext } from "../memory/types.ts";

const memorySearchSchema = Type.Object(
	{
		query: Type.String({ description: "Durable project rule, decision, implementation fact, or lesson to find." }),
		limit: Type.Optional(Type.Number({ description: "Maximum records to return. Default 10." })),
		includeUnverified: Type.Optional(
			Type.Boolean({ description: "Include records awaiting verification for explicit investigation." }),
		),
		includeHistory: Type.Optional(
			Type.Boolean({ description: "Include superseded and revoked revisions for explicit investigation." }),
		),
	},
	{ additionalProperties: false },
);

export type MemorySearchToolInput = Static<typeof memorySearchSchema>;

export function createMemorySearchToolDefinition(
	authority: MemoryAuthority,
	queryContext: () => MemoryQueryContext,
): ToolDefinition<typeof memorySearchSchema, { count: number; memoryIds: string[] }> {
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Search verified long-term project memory. Results include scope, applicability, verification, limitations, and source summaries. Current user instructions take precedence.",
		promptSnippet: "Search verified project memory before relying on earlier rules or experience",
		parameters: memorySearchSchema,
		async execute(_toolCallId, input: MemorySearchToolInput) {
			const records = authority.search(
				input.query,
				queryContext(),
				{ includeUnverified: input.includeUnverified, includeHistory: input.includeHistory },
				input.limit,
			);
			if (records.length === 0) {
				return {
					content: [{ type: "text", text: "No authorized memory records matched." }],
					details: { count: 0, memoryIds: [] },
				};
			}
			const text = records
				.map(
					(record, index) =>
						`${index + 1}. ${record.memoryId}@${record.revision} [${record.kind}; ${record.status}; ${record.applicability}; ${record.verification.level}]\n${record.text}` +
						(record.limitations.length > 0 ? `\nLimitations: ${record.limitations.join("; ")}` : ""),
				)
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { count: records.length, memoryIds: records.map((record) => record.memoryId) },
			};
		},
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? args.query : "";
			return new Text(theme.fg("toolTitle", theme.bold(`memory_search "${query}"`)), 0, 0);
		},
	};
}
