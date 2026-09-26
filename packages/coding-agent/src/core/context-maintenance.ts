import { createHash } from "node:crypto";
import type { SessionManager } from "./session-manager.ts";

export const CONTEXT_CONTROL_TOOLS = [
	"history",
	"context_note",
	"todo_write",
	"get_context_remaining",
	"new_context",
] as const;

type Stage = "shake" | "compaction" | "decision";
interface MaintenanceRecord {
	sourceRevision: string;
	stage: Stage;
}

/** Durable attempt accounting. Control traffic never grants another compression attempt. */
export class ContextMaintenance {
	private manager: SessionManager;

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	next(requestConfig: string): MaintenanceRecord {
		const branch = this.manager.getBranch();
		const sourceIds = branch.flatMap((entry) => {
			if (entry.type === "delivery_receipt") return [entry.id];
			if (entry.type !== "message") return [];
			const message = entry.message;
			if (message.role === "user") return [entry.id];
			if (message.role === "toolResult" && !CONTEXT_CONTROL_TOOLS.some((name) => name === message.toolName))
				return [entry.id];
			return [];
		});
		const sourceRevision = createHash("sha256")
			.update(
				JSON.stringify({
					windowId: this.manager.ensureContextWindow().windowId,
					promptGeneration: this.manager.getLatestContextCoordinates().promptGeneration,
					requestConfig,
					sourceIds,
				}),
			)
			.digest("hex");
		const records = branch.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== "context-maintenance") return [];
			const record = entry.data as MaintenanceRecord;
			return record?.sourceRevision === sourceRevision ? [record] : [];
		});
		const stage = !records.some((record) => record.stage === "shake")
			? "shake"
			: !records.some((record) => record.stage === "compaction")
				? "compaction"
				: "decision";
		return { sourceRevision, stage };
	}

	/** Consume before starting work, so a crash cannot reset the allowance. */
	begin(record: MaintenanceRecord): void {
		this.manager.appendCustomEntry("context-maintenance", record);
	}
}
