/**
 * SendFileToChat MCP tool — allows the agent to queue files for upload back to the chat.
 *
 * Uses createSdkMcpServer() with sdkMcpServers.connect() which is the SDK's
 * supported way to add custom in-process MCP tools.
 * It's in-memory only — no network server, just JS function dispatch over the existing
 * stdio pipe.
 *
 * UploadCollector is created per agent run. The tool handler validates the file path is
 * within the workspace and collects it. After the run, the caller drains the collector
 * and uploads via the platform-specific adapter (Slack files.uploadV2, etc.).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SdkMcpServerConfig } from "@papert-code/sdk-typescript";
import type { ToolDefinition } from "@papert-code/sdk-typescript";
import { createSdkMcpServer, tool } from "@papert-code/sdk-typescript";

export class UploadCollector {
	private pending: string[] = [];
	private pendingMessages: string[] = [];

	collect(filePath: string): void {
		this.pending.push(filePath);
	}

	drain(): string[] {
		const files = [...this.pending];
		this.pending = [];
		return files;
	}

	collectMessage(message: string): void {
		if (!message.trim()) return;
		this.pendingMessages.push(message);
	}

	drainMessages(): string[] {
		const messages = [...this.pendingMessages];
		this.pendingMessages = [];
		return messages;
	}
}

export function createUploadMcpServer(collector: UploadCollector, workspaceDir: string): SdkMcpServerConfig {
	const absWorkspace = resolve(workspaceDir);
	const queueFile = (filePath: string): string => {
		const absPath = resolve(filePath ?? "");

		if (!absPath.startsWith(absWorkspace)) {
			return `Error: file must be within your workspace ${absWorkspace}`;
		}

		if (!existsSync(absPath)) {
			return `Error: file not found at ${absPath}`;
		}

		collector.collect(absPath);
		return `File queued for upload: ${absPath}`;
	};

	const sendFileTool = tool<{ file_path: string }, string>({
			name: "SendFileToChat",
			description:
				"Queue a file from the workspace to be sent back to the user in chat. The file must exist within your workspace directory. Create the file first using write/edit/shell tools, then call this tool with the absolute path.",
			inputSchema: {
				type: "object",
				properties: {
					file_path: {
						type: "string",
						description: "Absolute path to the file within your workspace",
					},
				},
				required: ["file_path"],
			},
			handler: async (input) => {
				return queueFile(input?.file_path ?? "");
			},
		});
	const sendFileToolSnake = tool<{ file_path: string }, string>({
		name: "send_file_to_chat",
		description: "Alias for SendFileToChat.",
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string" },
			},
			required: ["file_path"],
		},
		handler: async (input) => queueFile(input?.file_path ?? ""),
	});

	const messageCompatTool = tool<
		{ action?: string; message?: string; media?: string; channel?: string; to?: string },
		string
	>({
		name: "message",
		description:
			"Compatibility tool for message-based delivery. For this app, prefer SendFileToChat. If media uses file:// within workspace, it will be queued.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string" },
				message: { type: "string" },
				media: { type: "string" },
				channel: { type: "string" },
				to: { type: "string" },
			},
		},
		handler: async (input) => {
			const text = (input?.message ?? "").trim();
			if (text) collector.collectMessage(text);

			const media = (input?.media ?? "").trim();
			if (media.startsWith("file://")) {
				const filePath = media.slice("file://".length);
				const fileResult = queueFile(filePath);
				if (fileResult.startsWith("Error:")) return fileResult;
			}

			if (!text && !media) {
				return "No message or media provided.";
			}
			return "Message request captured for Slack delivery.";
		},
	});

	const server = createSdkMcpServer("papert-claw", "1.0.0", [
		sendFileTool as ToolDefinition,
		sendFileToolSnake as ToolDefinition,
		messageCompatTool as ToolDefinition,
	]);

	return {
		connect: async (transport) => {
			await server.connect(transport as never);
		},
	};
}
