import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createSettingsRepository } from "./settings";

describe("Settings repository", () => {
	let db: Kysely<DB>;
	let settings: ReturnType<typeof createSettingsRepository>;

	beforeEach(async () => {
		db = await createTestDb();
		settings = createSettingsRepository(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("get() returns null when no settings exist", async () => {
		const result = await settings.get();
		expect(result).toBeNull();
	});

	it("create() inserts a row and get() returns it", async () => {
		await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash123" });
		const row = await settings.get();
		expect(row).not.toBeNull();
		expect(row?.admin_email).toBe("admin@test.com");
		expect(row?.admin_password_hash).toBe("hash123");
		expect(row?.bot_name).toBe("Papert Claw");
		expect(row?.org_name).toBeNull();
	});

	it("create() rejects duplicate settings row", async () => {
		await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
		await expect(settings.create({ adminEmail: "c@d.com", adminPasswordHash: "hash2" })).rejects.toThrow();
	});

	it("update() changes specific columns", async () => {
		await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
		await settings.update({ orgName: "Acme Corp", botName: "Helper" });

		const row = await settings.get();
		expect(row?.org_name).toBe("Acme Corp");
		expect(row?.bot_name).toBe("Helper");
		expect(row?.admin_email).toBe("a@b.com");
	});

	it("update() with empty data is a no-op", async () => {
		await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
		await settings.update({});
		const row = await settings.get();
		expect(row?.admin_email).toBe("a@b.com");
	});

	it("update() persists Slack and LLM settings fields", async () => {
		await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
		await settings.update({
			llmProvider: "openai",
			anthropicApiKey: null,
			openaiApiKey: "sk-api-test",
			openaiBaseUrl: "https://api.minimax.io/v1",
			openaiModel: "MiniMax-M2.5-highspeed",
			awsAccessKeyId: null,
			awsSecretAccessKey: null,
			awsRegion: null,
			slackBotToken: "xoxb-token",
			slackAppToken: "xapp-token",
		});

		const row = await settings.get();
		expect(row?.slack_bot_token).toBe("xoxb-token");
		expect(row?.slack_app_token).toBe("xapp-token");
		expect(row?.llm_provider).toBe("openai");
		expect(row?.anthropic_api_key).toBeNull();
		expect(row?.openai_api_key).toBe("sk-api-test");
		expect(row?.openai_base_url).toBe("https://api.minimax.io/v1");
		expect(row?.openai_model).toBe("MiniMax-M2.5-highspeed");
		expect(row?.aws_access_key_id).toBeNull();
		expect(row?.aws_secret_access_key).toBeNull();
		expect(row?.aws_region).toBeNull();
	});

	it("update() allows clearing Slack and LLM credentials with null values", async () => {
		await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
		await settings.update({
			slackBotToken: "xoxb-token",
			slackAppToken: "xapp-token",
			llmProvider: "openai",
			anthropicApiKey: null,
			openaiApiKey: "sk-api-test",
			openaiBaseUrl: "https://api.minimax.io/v1",
			openaiModel: "MiniMax-M2.5-highspeed",
		});
		await settings.update({
			slackBotToken: null,
			slackAppToken: null,
			llmProvider: null,
			anthropicApiKey: null,
			openaiApiKey: null,
			openaiBaseUrl: null,
			openaiModel: null,
			awsAccessKeyId: null,
			awsSecretAccessKey: null,
			awsRegion: null,
		});

		const row = await settings.get();
		expect(row?.slack_bot_token).toBeNull();
		expect(row?.slack_app_token).toBeNull();
		expect(row?.llm_provider).toBeNull();
		expect(row?.anthropic_api_key).toBeNull();
		expect(row?.openai_api_key).toBeNull();
		expect(row?.openai_base_url).toBeNull();
		expect(row?.openai_model).toBeNull();
		expect(row?.aws_access_key_id).toBeNull();
		expect(row?.aws_secret_access_key).toBeNull();
		expect(row?.aws_region).toBeNull();
	});
});
