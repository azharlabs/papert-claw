/**
 * Validates and exports typed configuration from environment variables.
 * Uses zod for schema validation and dotenv for .env file loading.
 * Fails fast on startup with all errors printed at once.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import "dotenv/config";

export const configSchema = z.object({
	// Database
	DB_TYPE: z.enum(["sqlite", "postgres"]).default("sqlite"),
	SQLITE_PATH: z.string().default("./data/papert-claw.db"),
	DATABASE_URL: z.string().optional(),

	// LLM — OpenAI-compatible provider
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_BASE_URL: z.string().url().optional(),
	OPENAI_MODEL: z.string().optional(),
	PAPERT_MODEL: z.string().optional(),

	// Slack
	SLACK_APP_TOKEN: z.string().startsWith("xapp-").optional(),
	SLACK_BOT_TOKEN: z.string().startsWith("xoxb-").optional(),

	// Slack context
	SLACK_CHANNEL_HISTORY_LIMIT: z.coerce.number().default(5),
	SLACK_THREAD_HISTORY_LIMIT: z.coerce.number().default(50),

	// Files
	MAX_FILE_SIZE_MB: z.coerce.number().default(20),

	// Papert SDK
	PAPERT_PERMISSION_MODE: z.enum(["default", "plan", "auto-edit", "yolo"]).default("yolo"),
	PAPERT_EXECUTABLE: z.string().optional(),

	// Server
	DATA_DIR: z.string().default("./data"),
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
	const result = configSchema.safeParse(process.env);
	if (!result.success) {
		console.error("Invalid configuration:");
		for (const issue of result.error.issues) {
			console.error(`  ${issue.path.join(".")}: ${issue.message}`);
		}
		process.exit(1);
	}
	const config = result.data;

	// Resolve relative paths against the project root (.env directory) so
	// server startup behaves consistently regardless of cwd.
	const projectRoot = process.env.DOTENV_CONFIG_PATH ? dirname(process.env.DOTENV_CONFIG_PATH) : process.cwd();
	if (!isAbsolute(config.DATA_DIR)) {
		config.DATA_DIR = resolve(projectRoot, config.DATA_DIR);
	}
	if (!isAbsolute(config.SQLITE_PATH)) {
		config.SQLITE_PATH = resolve(projectRoot, config.SQLITE_PATH);
	}

	return config;
}

/**
 * Semantic validation that can't be expressed in zod schema alone.
 * Checks cross-field dependencies after loadConfig() succeeds.
 */
export function validateConfig(config: Config): void {
	// Slack tokens are optional, but if one is provided, both must be
	if (config.SLACK_APP_TOKEN && !config.SLACK_BOT_TOKEN) {
		console.error("SLACK_APP_TOKEN provided without SLACK_BOT_TOKEN");
		process.exit(1);
	}
	if (config.SLACK_BOT_TOKEN && !config.SLACK_APP_TOKEN) {
		console.error("SLACK_BOT_TOKEN provided without SLACK_APP_TOKEN");
		process.exit(1);
	}

	if (config.DB_TYPE === "postgres" && !config.DATABASE_URL) {
		console.error("DB_TYPE=postgres requires DATABASE_URL");
		process.exit(1);
	}
}
