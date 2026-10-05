import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
} from "@earendil-works/pi-ai/compat";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../src/index.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	/** Preserve provider request identity in disk restart tests. */
	fauxApi?: string;
	persistSession?: boolean;
	sessionFile?: string;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[] | ((cwd: string) => AgentTool[]);
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	modelsJson?: Record<string, unknown>;
	/** Override the Grok-aligned memory root (default: a tmpdir under this harness's tempDir, never the real ~/.pi). */
	memoryRootDir?: string;
	memoryArchiveExtractor?: ConstructorParameters<typeof AgentSession>[0]["memoryArchiveExtractor"];
	/** Override the lsp tool's language server configs (default: DEFAULT_LSP_SERVERS). Tests point this at a fake fixture server. */
	lspServers?: ConstructorParameters<typeof AgentSession>[0]["lspServers"];
	/** MCP server configs (default: none, so search_tool/use_tool are not registered). Tests point this at a fake fixture server. */
	mcpServers?: ConstructorParameters<typeof AgentSession>[0]["mcpServers"];
	webSearchOperations?: ConstructorParameters<typeof AgentSession>[0]["webSearchOperations"];
	webFetchOperations?: ConstructorParameters<typeof AgentSession>[0]["webFetchOperations"];
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => Promise<void>;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		api: options.fauxApi,
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile)
		: options.persistSession
			? SessionManager.create(tempDir, join(tempDir, "sessions"))
			: SessionManager.inMemory(tempDir);
	const cwd = sessionManager.getCwd();
	const tools = typeof options.tools === "function" ? options.tools(cwd) : options.tools;
	const toolMap = tools ? Object.fromEntries(tools.map((tool) => [tool.name, tool])) : undefined;
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRegistry = modelsPath
		? await createModelRegistry(authStorage, modelsPath)
		: await createInMemoryModelRegistry(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: streamSimple,
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: [],
			messages: sessionManager.buildSessionContext().messages,
		},
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
		memoryRootDir: options.memoryRootDir ?? join(tempDir, "memory"),
		memoryArchiveExtractor: options.memoryArchiveExtractor,
		lspServers: options.lspServers,
		mcpServers: options.mcpServers,
		webSearchOperations: options.webSearchOperations,
		webFetchOperations: options.webFetchOperations,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		async cleanup() {
			await session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
