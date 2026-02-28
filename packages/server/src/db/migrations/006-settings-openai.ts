import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// SQLite requires separate ALTER TABLE statements for each new column.
	await db.schema.alterTable("settings").addColumn("openai_api_key", "text").execute();
	await db.schema.alterTable("settings").addColumn("openai_base_url", "text").execute();
	await db.schema.alterTable("settings").addColumn("openai_model", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("settings").dropColumn("openai_api_key").execute();
	await db.schema.alterTable("settings").dropColumn("openai_base_url").execute();
	await db.schema.alterTable("settings").dropColumn("openai_model").execute();
}
