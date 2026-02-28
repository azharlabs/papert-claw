import { describe, expect, it } from "vitest";
import { PAPERT_ALLOWED_TOOLS } from "./allowed-tools";

describe("PAPERT_ALLOWED_TOOLS", () => {
	it("does not contain duplicate entries", () => {
		const unique = new Set(PAPERT_ALLOWED_TOOLS);
		expect(unique.size).toBe(PAPERT_ALLOWED_TOOLS.length);
	});

	it("does not include papert-claw-prefixed MCP tool aliases", () => {
		expect(PAPERT_ALLOWED_TOOLS.some((name) => name.startsWith("mcp__"))).toBe(false);
	});

	it("keeps compatibility tool names required by papert-claw prompts", () => {
		expect(PAPERT_ALLOWED_TOOLS).toContain("SendFileToChat");
		expect(PAPERT_ALLOWED_TOOLS).toContain("send_file_to_chat");
		expect(PAPERT_ALLOWED_TOOLS).toContain("message");
		expect(PAPERT_ALLOWED_TOOLS).toContain("slack");
	});
});
