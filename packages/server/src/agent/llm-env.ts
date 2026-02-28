import type { SettingsTable } from "../db/schema";
import type { Logger } from "../logger";

type LlmSettings = Pick<SettingsTable, "llm_provider" | "openai_api_key" | "openai_base_url" | "openai_model">;

function unsetEnv(...keys: string[]) {
	for (const key of keys) {
		Reflect.deleteProperty(process.env, key);
	}
}

function clearProviderRoutingEnv() {
	unsetEnv(
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
	);
}

export function applyLlmEnvFromSettings(settings: LlmSettings | null, logger?: Logger): void {
	if (!settings || !settings.llm_provider) {
		logger?.warn("No LLM provider configured in settings; using existing environment-based LLM config");
		return;
	}

	if (settings.llm_provider !== "openai") {
		logger?.warn(
			{
				llmProvider: settings.llm_provider,
				supportedProviders: ["openai"],
			},
			"Unsupported LLM provider in DB; preserving existing environment-based LLM config",
		);
		return;
	}

	if (!settings.openai_api_key || !settings.openai_base_url || !settings.openai_model) {
		logger?.warn(
			{
				llmProvider: settings.llm_provider,
				hasOpenAiApiKey: Boolean(settings.openai_api_key),
				hasOpenAiBaseUrl: Boolean(settings.openai_base_url),
				hasOpenAiModel: Boolean(settings.openai_model),
			},
			"Incomplete LLM settings in DB; preserving existing environment-based LLM config",
		);
		return;
	}

	clearProviderRoutingEnv();
	unsetEnv("ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION");
	unsetEnv("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "PAPERT_MODEL");
	process.env.OPENAI_API_KEY = settings.openai_api_key;
	process.env.OPENAI_BASE_URL = settings.openai_base_url;
	process.env.OPENAI_MODEL = settings.openai_model;
	process.env.PAPERT_MODEL = settings.openai_model;
	logger?.info({ llmProvider: "openai", source: "db" }, "Configured LLM provider from DB settings");
}
