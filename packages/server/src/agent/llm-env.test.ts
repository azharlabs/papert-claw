import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLlmEnvFromSettings } from "./llm-env";

const ENV_KEYS = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_REGION",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_MODEL",
	"PAPERT_MODEL",
] as const;

function snapshotEnv() {
	return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
	for (const key of ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) {
			Reflect.deleteProperty(process.env, key);
			continue;
		}
		process.env[key] = value;
	}
}

describe("applyLlmEnvFromSettings", () => {
	const initialEnv = snapshotEnv();

	afterEach(() => {
		restoreEnv(initialEnv);
		vi.restoreAllMocks();
	});

	it("does nothing when settings are missing", () => {
		process.env.OPENAI_API_KEY = "existing-key";
		const logger = { warn: vi.fn(), info: vi.fn() };

		applyLlmEnvFromSettings(null, logger as never);

		expect(process.env.OPENAI_API_KEY).toBe("existing-key");
		expect(logger.warn).toHaveBeenCalledWith(
			"No LLM provider configured in settings; using existing environment-based LLM config",
		);
	});

	it("configures openai and clears anthropic/bedrock env", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-existing";
		process.env.CLAUDE_CODE_USE_BEDROCK = "1";
		process.env.AWS_ACCESS_KEY_ID = "AKIA...";
		process.env.ANTHROPIC_AUTH_TOKEN = "legacy";
		const logger = { warn: vi.fn(), info: vi.fn() };

		applyLlmEnvFromSettings(
			{
				llm_provider: "openai",
				openai_api_key: "sk-api-test",
				openai_base_url: "https://api.minimax.io/v1",
				openai_model: "MiniMax-M2.5-highspeed",
			},
			logger as never,
		);

		expect(process.env.OPENAI_API_KEY).toBe("sk-api-test");
		expect(process.env.OPENAI_BASE_URL).toBe("https://api.minimax.io/v1");
		expect(process.env.OPENAI_MODEL).toBe("MiniMax-M2.5-highspeed");
		expect(process.env.PAPERT_MODEL).toBe("MiniMax-M2.5-highspeed");
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
		expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(logger.info).toHaveBeenCalledWith(
			{ llmProvider: "openai", source: "db" },
			"Configured LLM provider from DB settings",
		);
	});

	it("preserves env for incomplete openai settings", () => {
		process.env.OPENAI_API_KEY = "existing-key";
		const logger = { warn: vi.fn(), info: vi.fn() };

		applyLlmEnvFromSettings(
			{
				llm_provider: "openai",
				openai_api_key: "sk-api-test",
				openai_base_url: "",
				openai_model: "MiniMax-M2.5-highspeed",
			},
			logger as never,
		);

		expect(process.env.OPENAI_API_KEY).toBe("existing-key");
		expect(logger.warn).toHaveBeenCalledWith(
			{
				llmProvider: "openai",
				hasOpenAiApiKey: true,
				hasOpenAiBaseUrl: false,
				hasOpenAiModel: true,
			},
			"Incomplete LLM settings in DB; preserving existing environment-based LLM config",
		);
	});

	it("warns and leaves env untouched for unsupported providers", () => {
		process.env.OPENAI_API_KEY = "existing-key";
		const logger = { warn: vi.fn(), info: vi.fn() };

		applyLlmEnvFromSettings(
			{
				llm_provider: "vertex",
				openai_api_key: null,
				openai_base_url: null,
				openai_model: null,
			},
			logger as never,
		);

		expect(process.env.OPENAI_API_KEY).toBe("existing-key");
		expect(logger.warn).toHaveBeenCalledWith(
			{ llmProvider: "vertex", supportedProviders: ["openai"] },
			"Unsupported LLM provider in DB; preserving existing environment-based LLM config",
		);
	});
});
