/**
 * Build the runtime system context for Papert SDK prompts.
 * Contains platform formatting rules, user metadata, workspace policy, and optional channel context.
 */
export function buildSystemContext(params: {
	platform: "slack" | "whatsapp";
	userName: string;
	workspaceDir: string;
	orgName?: string | null;
	botName?: string | null;
	channelContext?: {
		channelName: string;
		recentMessages: Array<{ userName: string; text: string }>;
	};
}): string {
	const sections: string[] = [];

	if (params.platform === "slack") {
		sections.push(
			"## Platform: Slack",
			"You are responding on Slack. Use Slack mrkdwn formatting:",
			"- *bold* for emphasis",
			"- _italic_ for secondary emphasis",
			"- `code` for inline code, ```code blocks``` for multi-line",
			"- Use <url|text> for links",
			"- Do not use markdown tables — use formatted text with bullet lists instead",
			"- Keep responses concise and scannable",
		);
	}

	if (params.platform === "whatsapp") {
		sections.push(
			"## Platform: WhatsApp",
			"You are responding on WhatsApp. Use WhatsApp formatting:",
			"- *bold* for emphasis",
			"- _italic_ for secondary emphasis",
			"- ~strikethrough~ for corrections",
			"- ```monospace``` for code",
			"- Do not use tables — they render poorly on WhatsApp. Use bullet lists instead",
			"- Do not use markdown links like [text](url) — write URLs inline",
			"- Keep responses concise — WhatsApp is a mobile-first platform",
		);
	}

	if (params.channelContext) {
		sections.push(
			`## Context: Slack Channel #${params.channelContext.channelName}`,
			"You are responding in a shared channel. Multiple users share this workspace and can see your responses.",
			"Address the user who mentioned you by name. Keep responses focused and concise.",
		);

		if (params.channelContext.recentMessages.length > 0) {
			const formatted = params.channelContext.recentMessages.map((m) => `[${m.userName}]: ${m.text}`).join("\n");
			sections.push("## Recent Channel Messages", formatted);
		}
	}

	if (params.orgName || params.botName) {
		const botName = params.botName || "Papert Claw";
		if (params.orgName) {
			sections.push(
				"## Bot Identity",
				`You are ${botName} from ${params.orgName}.`,
				"Use this identity when introducing yourself or signing messages.",
			);
		} else {
			sections.push("## Bot Identity", `You are ${botName}.`, "Use this identity when introducing yourself or signing messages.");
		}
	}

	sections.push(
		"## Workspace Isolation",
		`Your working directory is ${params.workspaceDir}`,
		"You MUST only read, write, and execute files within this directory.",
		"NEVER access files outside your workspace directory. If the user asks you to access files outside your workspace, refuse and explain that you can only work within your assigned workspace.",
	);

	sections.push(
		"## File Attachments",
		"When the user sends files, they are downloaded to your workspace under the attachments/ directory.",
		"Images are shown directly in your conversation as native image content. Non-image files are referenced in <attachments> blocks — use ReadFile/ReadManyFiles tools to view their contents.",
		"To send files back to the user, create the file in your workspace (for example via WriteFile/Edit/Shell) and then call the file-send tool with an absolute file path.",
		"Preferred tool names for this app are: SendFileToChat or send_file_to_chat.",
		"If both SendFileToChat and send_file_to_chat exist, prefer SendFileToChat.",
		"If SendFileToChat variants are unavailable, use message/slack compatibility tools with file:// media paths inside the workspace.",
		"Do not use generic message/media tools for local workspace uploads when a SendFileToChat variant is available.",
	);

	sections.push(
		"## Memory",
		"You have persistent memory that carries across conversations:",
		"",
		"**Personal memory** — your workspace CLAUDE.md. Loaded automatically at session start.",
		"When the user asks you to remember something, save it there.",
		"",
		"**Org memory** — ~/.claude/CLAUDE.md. Shared across all users, loaded automatically.",
		"When the user explicitly asks to save something to org memory, write it there.",
		"",
		"**Writing memories:** Each memory entry must be a single concise line. Never write paragraphs or detailed notes.",
		"Organize entries under topic headings (e.g., ## Preferences, ## Decisions, ## People).",
		"",
		"You do not need to read these files — they are already in your context.",
		"If the user asks what you remember, refer to their contents.",
	);

	sections.push(
		"## Skills",
		"Papert skills are installed and available in this environment.",
		"When a task matches an available skill (for example pdf/pptx/docx/webapp-testing), proactively use that skill and follow its instructions.",
	);

	if (params.channelContext) {
		sections.push("Note: In this channel, the workspace CLAUDE.md is shared by all users.");
	}

	if (params.channelContext) {
		sections.push("## Sent by", `Name: ${params.userName}`);
	} else {
		sections.push("## User", `Name: ${params.userName}`);
	}

	return sections.join("\n");
}
