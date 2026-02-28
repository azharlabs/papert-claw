import { describe, expect, it } from "vitest";
import { buildSystemContext } from "./prompt";

describe("buildSystemContext", () => {
	describe("slack platform (DM)", () => {
		const result = buildSystemContext({
			platform: "slack",
			userName: "Alice",
			workspaceDir: "/data/workspaces/u123",
			orgName: "Acme Corp",
			botName: "Papert Claw",
		});

		it("includes mrkdwn formatting rules", () => {
			expect(result).toContain("mrkdwn");
			expect(result).toContain("*bold*");
			expect(result).toContain("_italic_");
			expect(result).toContain("`code`");
			expect(result).toContain("<url|text>");
		});

		it("includes bot identity section when org/bot provided", () => {
			expect(result).toContain("## Bot Identity");
			expect(result).toContain("You are Papert Claw from Acme Corp.");
		});

		it("includes workspace isolation and user section", () => {
			expect(result).toContain("Workspace Isolation");
			expect(result).toContain("/data/workspaces/u123");
			expect(result).toContain("## User");
			expect(result).toContain("Alice");
		});
	});

	describe("whatsapp platform", () => {
		const result = buildSystemContext({
			platform: "whatsapp",
			userName: "Bob",
			workspaceDir: "/data/workspaces/u456",
		});

		it("includes WhatsApp formatting rules", () => {
			expect(result).toContain("## Platform: WhatsApp");
			expect(result).toContain("~strikethrough~");
			expect(result).toContain("markdown links");
		});

		it("does not include Slack-specific rules", () => {
			expect(result).not.toContain("mrkdwn");
			expect(result).not.toContain("<url|text>");
		});
	});

	describe("file attachments and skills", () => {
		const result = buildSystemContext({
			platform: "slack",
			userName: "Eve",
			workspaceDir: "/data/workspaces/u789",
		});

		it("includes attachment guidance and SendFileToChat variants", () => {
			expect(result).toContain("## File Attachments");
			expect(result).toContain("ReadFile/ReadManyFiles");
			expect(result).toContain("SendFileToChat");
			expect(result).toContain("send_file_to_chat");
		});

		it("includes skills section", () => {
			expect(result).toContain("## Skills");
			expect(result).toContain("Papert skills");
		});
	});

	describe("memory", () => {
		it("includes memory section and org memory file", () => {
			const result = buildSystemContext({
				platform: "slack",
				userName: "Alice",
				workspaceDir: "/data/workspaces/u123",
			});
			expect(result).toContain("## Memory");
			expect(result).toContain("Personal memory");
			expect(result).toContain("Org memory");
			expect(result).toContain("~/.claude/CLAUDE.md");
		});

		it("includes channel shared-memory note for channel context", () => {
			const result = buildSystemContext({
				platform: "slack",
				userName: "Carol",
				workspaceDir: "/data/workspaces/channel-C001",
				channelContext: {
					channelName: "general",
					recentMessages: [],
				},
			});
			expect(result).toContain("shared by all users");
		});
	});

	describe("channel context", () => {
		const result = buildSystemContext({
			platform: "slack",
			userName: "Dave",
			workspaceDir: "/data/workspaces/channel-C002",
			channelContext: {
				channelName: "random",
				recentMessages: [{ userName: "Alice", text: "hello" }],
			},
		});

		it("uses Sent by and includes recent messages", () => {
			expect(result).toContain("## Sent by");
			expect(result).toContain("Slack Channel #random");
			expect(result).toContain("[Alice]: hello");
		});
	});
});
