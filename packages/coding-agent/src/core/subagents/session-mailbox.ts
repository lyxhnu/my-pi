import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../agent-session.ts";
import type { CustomMessage } from "../messages.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SubagentMail } from "./types.ts";

export function subagentMailMessage(mail: SubagentMail): CustomMessage<{ messageId: string }> {
	return {
		role: "custom",
		customType: "subagent-mail",
		content: `Subagent message (${mail.kind})\nMessage ID: ${mail.messageId}\nFrom agent: ${mail.senderAgentId}\nFrom run: ${mail.senderRunId}\nTarget run: ${mail.targetRunId ?? "next explicit task"}\n\n${mail.message}`,
		display: false,
		details: { messageId: mail.messageId },
		timestamp: mail.createdAt,
	};
}

/** Called only at an owned run's safe point; no steering queue or implicit turn. */
export function hasSubagentMailReceipt(manager: SessionManager, messageId: string): boolean {
	return manager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "subagent-mail" &&
				typeof entry.details === "object" &&
				entry.details !== null &&
				"messageId" in entry.details &&
				entry.details.messageId === messageId,
		);
}

export function deliverSubagentMail(session: AgentSession, mail: SubagentMail): AgentMessage | undefined {
	// The recipient record is the durable receipt even if the root crashed before
	// recording delivery. Reopening must not inject the same message again.
	if (hasSubagentMailReceipt(session.sessionManager, mail.messageId)) return;
	const message = subagentMailMessage(mail);
	session.sessionManager.appendCustomMessageEntry(
		message.customType,
		message.content,
		message.display,
		message.details,
	);
	session.sessionManager.flush();
	session.agent.state.messages.push(message);
	return message;
}

export function deliverSubagentUpdateHint(session: AgentSession, through: number): AgentMessage | undefined {
	if (
		session.messages.some(
			(message) =>
				message.role === "custom" &&
				message.customType === "subagent-updates" &&
				typeof message.details === "object" &&
				message.details !== null &&
				"through" in message.details &&
				message.details.through === through,
		)
	)
		return;
	const message: CustomMessage<{ through: number }> = {
		role: "custom",
		customType: "subagent-updates",
		display: false,
		content: `Subagent updates are available through record ${through}. Read get_agent_info with section="updates" to page through events and results. This hint does not mark those records as read.`,
		details: { through },
		timestamp: Date.now(),
	};
	session.sessionManager.appendCustomMessageEntry(message.customType, message.content, false, message.details);
	session.sessionManager.flush();
	session.agent.state.messages.push(message);
	return message;
}
