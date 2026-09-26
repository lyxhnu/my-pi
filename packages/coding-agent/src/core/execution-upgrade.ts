import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";

export interface ExecutionUpgradeSettings {
	enabled?: boolean;
	/** Explicit weakest-to-strongest order, using exact provider/model IDs. */
	modelOrder?: string[];
	reminderRounds?: number;
	reminderToolCalls?: number;
	reminderRepeatedErrors?: number;
	reminderCooldownRounds?: number;
}

export type ExecutionUpgradeConfig = Required<ExecutionUpgradeSettings>;

export interface ExecutionProfile {
	targetModel: string;
	thinkingLevel: ThinkingLevel;
}

export interface ExecutionUpgradeRequest extends ExecutionProfile {
	reason: string;
}

export interface ExecutionUpgradeOutcome {
	callIds: string[];
	status: "pending" | "applied" | "rejected" | "cancelled";
	from: ExecutionProfile;
	requested: ExecutionUpgradeRequest;
	message: string;
	requestFingerprint?: string;
	effectiveThinkingLevel?: ThinkingLevel;
}

export interface ExecutionUpgradeOption {
	targetModel: string;
	thinkingLevels: ThinkingLevel[];
}

const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function resolveExecutionUpgradeSettings(settings: ExecutionUpgradeSettings = {}): ExecutionUpgradeConfig {
	const config = {
		enabled: settings.enabled ?? false,
		modelOrder: settings.modelOrder?.slice() ?? [],
		reminderRounds: settings.reminderRounds ?? 8,
		reminderToolCalls: settings.reminderToolCalls ?? 24,
		reminderRepeatedErrors: settings.reminderRepeatedErrors ?? 3,
		reminderCooldownRounds: settings.reminderCooldownRounds ?? 4,
	};
	if (typeof config.enabled !== "boolean") throw new Error("Invalid executionUpgrade.enabled");
	if (
		!Array.isArray(config.modelOrder) ||
		config.modelOrder.some((id) => typeof id !== "string" || !/^[^/\s]+\/\S+$/.test(id)) ||
		new Set(config.modelOrder).size !== config.modelOrder.length
	)
		throw new Error("executionUpgrade.modelOrder must contain unique provider/model IDs");
	for (const key of [
		"reminderRounds",
		"reminderToolCalls",
		"reminderRepeatedErrors",
		"reminderCooldownRounds",
	] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid executionUpgrade.${key}`);
	}
	return config;
}

/** Returns only explicit upward choices; prices and model names never determine capability. */
export function executionUpgradeOptions(
	current: Model<Api>,
	thinking: ThinkingLevel,
	config: ExecutionUpgradeConfig,
	models: readonly Model<Api>[],
): ExecutionUpgradeOption[] {
	if (!config.enabled) return [];
	const currentId = `${current.provider}/${current.id}`;
	const currentIndex = config.modelOrder.indexOf(currentId);
	const currentEffective = current.thinkingLevelMap?.[thinking] ?? thinking;
	const options: ExecutionUpgradeOption[] = [];
	const sameModelLevels = getSupportedThinkingLevels(current).filter((level) => {
		const effective = current.thinkingLevelMap?.[level] ?? level;
		const effectiveIndex = THINKING_ORDER.indexOf(effective as ThinkingLevel);
		const previousIndex = THINKING_ORDER.indexOf(currentEffective as ThinkingLevel);
		return (
			THINKING_ORDER.indexOf(level) > THINKING_ORDER.indexOf(thinking) &&
			effective !== currentEffective &&
			(effectiveIndex === -1 || previousIndex === -1 || effectiveIndex > previousIndex)
		);
	});
	if (sameModelLevels.length > 0) options.push({ targetModel: currentId, thinkingLevels: sameModelLevels });
	if (currentIndex !== -1) {
		for (const targetModel of config.modelOrder.slice(currentIndex + 1)) {
			const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === targetModel);
			if (model) options.push({ targetModel, thinkingLevels: getSupportedThinkingLevels(model) });
		}
	}
	return options;
}
