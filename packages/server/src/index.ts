import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { applyLlmEnvFromSettings } from "./agent/llm-env";
import { runAgent } from "./agent/runner";
import { SchedulerBridge } from "./agent/scheduler-bridge";
import { ensureChannelWorkspace, ensureWorkspace } from "./agent/workspace";
import { loadConfig, validateConfig } from "./config";
import { createDatabase } from "./db/index";
import { runMigrations } from "./db/migrate";
import { createChannelRepository } from "./db/repositories/channels";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import { type Attachment, downloadSlackFile } from "./files";
import { createApp } from "./http";
import { createLogger } from "./logger";
import { QueueManager } from "./queue";
import { slackApiCall } from "./slack/api";
import { SlackBot, resolveHistoryParams } from "./slack/bot";
import { createSlackMessageHandler } from "./slack/message-handler";
import { createSlackStartupManager } from "./slack/startup";
import { WhatsAppBot } from "./whatsapp/bot";

function normalizeUploadResponseText(params: {
	responseText: string;
	uploadedCount: number;
	uploadedFiles: string[];
	userMessageText: string;
}): string {
	const { responseText, uploadedCount, uploadedFiles, userMessageText } = params;
	const deniedMessagePattern =
		/\b(unable to send|don't have access|do not have access|file-send tool.*not available)\b/i;
	const askedForUpload = /\b(attach|upload|send|share)\b/i.test(userMessageText);
	if (uploadedCount > 0 && askedForUpload) {
		const names = uploadedFiles.map((path) => {
			const parts = path.split("/");
			return parts[parts.length - 1] ?? path;
		});
		const summary =
			names.length > 0
				? `Uploaded ${uploadedCount} file${uploadedCount === 1 ? "" : "s"} to Slack: ${names.join(", ")}.`
				: `Uploaded ${uploadedCount} file${uploadedCount === 1 ? "" : "s"} to Slack.`;
		return summary;
	}

	if (uploadedCount > 0 && deniedMessagePattern.test(responseText)) {
		return `Uploaded ${uploadedCount} file${uploadedCount === 1 ? "" : "s"} to Slack.`;
	}

	const claimsUploadPattern = /\b(done|uploaded|attached|sent)\b[\s\S]{0,80}\b(file|files|attachment|attachments)\b/i;
	if (uploadedCount === 0 && askedForUpload && claimsUploadPattern.test(responseText)) {
		return "No file was uploaded. Please specify a filename/path (for example `attachments/<name>`), or ask to attach the latest attachment.";
	}

	return responseText;
}

// 1. Config
const config = loadConfig();
validateConfig(config);

// 2. Logger
const logger = createLogger(config);
logger.info(
	{ papertPermissionMode: config.PAPERT_PERMISSION_MODE, papertModel: config.PAPERT_MODEL ?? null },
	"Papert runtime configured",
);

// 3. Database
const db = createDatabase(config);
await runMigrations(db);
logger.info("Database ready");

// 4. Repositories
const users = createUserRepository(db);
const channels = createChannelRepository(db);
const settingsRepo = createSettingsRepository(db);
const envConfiguredPapertModel = config.PAPERT_MODEL;

async function applyLlmEnvFromDb() {
	const settingsRow = await settingsRepo.get();
	applyLlmEnvFromSettings(settingsRow, logger);
	const openAiModel = settingsRow?.llm_provider === "openai" ? settingsRow.openai_model?.trim() : "";
	config.PAPERT_MODEL = openAiModel || envConfiguredPapertModel;
}

function resolveRuntimeModel(settingsRow: Awaited<ReturnType<typeof settingsRepo.get>>): string | undefined {
	if (settingsRow?.llm_provider === "openai" && settingsRow.openai_model?.trim()) {
		return settingsRow.openai_model.trim();
	}
	return config.PAPERT_MODEL;
}

// Apply DB-backed LLM configuration on boot (if already configured).
await applyLlmEnvFromDb();

// 5. Queue manager
const queueManager = new QueueManager();

let slack: SlackBot | null = null;

const schedulerBridge = new SchedulerBridge({
	logger,
	model: config.PAPERT_MODEL,
	permissionMode: config.PAPERT_PERMISSION_MODE,
	onDelivery: async (route, text) => {
		if (!slack) {
			logger.warn({ route }, "Scheduler delivery skipped: Slack is not configured");
			return;
		}
		if (route.mode === "channel" && route.threadTs) {
			await slack.postThreadReply(route.channelId, route.threadTs, text);
			return;
		}
		await slack.postMessage(route.channelId, text);
	},
});

async function bootstrapSchedulerForAllWorkspaces(): Promise<void> {
	const workspacesRoot = join(config.DATA_DIR, "workspaces");
	await mkdir(workspacesRoot, { recursive: true });
	const entries = await readdir(workspacesRoot, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const workspaceId = entry.name;
		const workspaceDir = join(workspacesRoot, workspaceId);
		if (workspaceId.startsWith("channel-")) {
			const channelId = workspaceId.slice("channel-".length);
			await schedulerBridge.ensureWorkspace(workspaceDir, {
				mode: "channel",
				channelId,
			});
			continue;
		}
		await schedulerBridge.ensureWorkspace(workspaceDir);
	}

	logger.info({ workspaceCount: entries.filter((e) => e.isDirectory()).length }, "Scheduler bootstrap completed");
}

async function validateSlackTokens(botToken: string, appToken: string) {
	void appToken;
	await slackApiCall(botToken, "auth.test");
}

function createConfiguredSlackBot(tokens: { botToken: string; appToken: string }) {
	const slackBot = new SlackBot({
		appToken: tokens.appToken,
		botToken: tokens.botToken,
		logger,
	});

	slackBot.onMessage(async (message) => {
		const queue = queueManager.getQueue(message.channelId);

		queue.enqueue(async () => {
			try {
				logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing message");

				// Resolve or create user
				let user = await users.findBySlackId(message.userId);
				if (!user) {
					const userInfo = await slackBot.getUserInfo(message.userId);
					user = await users.create({
						name: userInfo.realName,
						slackUserId: message.userId,
					});
					logger.info({ userId: user.id, name: user.name }, "New user created");
				}

				// Ensure workspace
				const workspaceDir = await ensureWorkspace(config, user.id);
				await schedulerBridge.ensureWorkspace(workspaceDir, {
					mode: "dm",
					channelId: message.channelId,
				});

				const settingsRow = await settingsRepo.get();

				// Download any attached files
				const attachments: Attachment[] = [];
				if (message.files?.length) {
					logger.debug(
						{
							fileCount: message.files.length,
							files: message.files.map((f) => ({
								name: f.name,
								mime: f.mimetype,
								size: f.size,
								url: f.urlPrivate?.slice(0, 80),
							})),
						},
						"Files received from Slack",
					);
					const attachDir = join(workspaceDir, "attachments");
					const maxBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;
					for (const file of message.files) {
						try {
							const downloaded = await downloadSlackFile(file.urlPrivate, tokens.botToken, attachDir, maxBytes, logger);
							attachments.push(downloaded);
						} catch (err) {
							logger.warn({ err, fileName: file.name }, "Failed to download file");
						}
					}
					logger.debug(
						{
							attachmentCount: attachments.length,
							attachments: attachments.map((a) => ({ name: a.originalName, mime: a.mimeType, size: a.sizeBytes })),
						},
						"Files downloaded",
					);
				}

				// Post thinking indicator
				const thinkingTs = await slackBot.postMessage(message.channelId, "_Thinking..._");
				const onMessage = createSlackMessageHandler(slackBot, message.channelId, thinkingTs);

				const result = await runAgent({
					userMessage: message.text || "See attached files.",
					workspaceDir,
					userName: user.name,
					logger,
					platform: "slack",
					orgName: settingsRow?.org_name,
					botName: settingsRow?.bot_name,
					model: resolveRuntimeModel(settingsRow),
					permissionMode: config.PAPERT_PERMISSION_MODE,
					attachments: attachments.length > 0 ? attachments : undefined,
					onMessage,
				});
				await schedulerBridge.syncWorkspace(workspaceDir);

				let uploadedCount = 0;
				for (const filePath of result.pendingUploads) {
					try {
						logger.info({ channelId: message.channelId, filePath }, "Uploading file to Slack");
						await slackBot.uploadFile(message.channelId, filePath);
						uploadedCount++;
						logger.info({ channelId: message.channelId, filePath }, "Uploaded file to Slack");
					} catch (err) {
						logger.warn({ err, filePath }, "Failed to upload file to Slack");
					}
				}
				for (const text of result.pendingMessages) {
					try {
						await slackBot.postMessage(message.channelId, text);
					} catch (err) {
						logger.warn({ err, text }, "Failed to post captured message to Slack");
					}
				}

				const rawResponseText = result.text ?? "_No response_";
				const responseText = normalizeUploadResponseText({
					responseText: rawResponseText,
					uploadedCount,
					uploadedFiles: result.pendingUploads,
					userMessageText: message.text || "",
				});
				if (!result.messageSent) {
					await slackBot.updateMessage(message.channelId, thinkingTs, responseText);
				} else if (responseText !== rawResponseText) {
					await slackBot.postMessage(message.channelId, responseText);
				}
			} catch (err) {
				logger.error({ err, slackUserId: message.userId, channelId: message.channelId }, "DM processing failed");
				try {
					await slackBot.postMessage(message.channelId, "_Something went wrong, try again_");
				} catch (notifyErr) {
					logger.error({ err: notifyErr, channelId: message.channelId }, "Failed to send DM failure message");
				}
			}
		});
	});

	slackBot.onChannelMention(async (message) => {
		const queue = queueManager.getQueue(message.channelId);

		queue.enqueue(async () => {
			try {
				logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing channel mention");

				// Resolve or create user
				let user = await users.findBySlackId(message.userId);
				if (!user) {
					const userInfo = await slackBot.getUserInfo(message.userId);
					user = await users.create({
						name: userInfo.realName,
						slackUserId: message.userId,
					});
					logger.info({ userId: user.id, name: user.name }, "New user created");
				}

				// Resolve or create channel
				let channel = await channels.findBySlackChannelId(message.channelId);
				if (!channel) {
					const channelInfo = await slackBot.getChannelInfo(message.channelId);
					channel = await channels.create({
						slackChannelId: message.channelId,
						name: channelInfo.name,
						type: channelInfo.type,
					});
					logger.info({ channelId: channel.id, name: channel.name }, "New channel created");
				}

				// Ensure channel workspace
				const workspaceDir = await ensureChannelWorkspace(config, message.channelId);
				const threadTs = message.threadTs ?? message.ts;
				await schedulerBridge.ensureWorkspace(workspaceDir, {
					mode: "channel",
					channelId: message.channelId,
					threadTs,
				});

				const settingsRow = await settingsRepo.get();

				// Download any attached files
				const attachments: Attachment[] = [];
				if (message.files?.length) {
					logger.debug(
						{
							fileCount: message.files.length,
							files: message.files.map((f) => ({
								name: f.name,
								mime: f.mimetype,
								size: f.size,
								url: f.urlPrivate?.slice(0, 80),
							})),
						},
						"Files received from Slack",
					);
					const attachDir = join(workspaceDir, "attachments");
					const maxBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;
					for (const file of message.files) {
						try {
							const downloaded = await downloadSlackFile(file.urlPrivate, tokens.botToken, attachDir, maxBytes, logger);
							attachments.push(downloaded);
						} catch (err) {
							logger.warn({ err, fileName: file.name }, "Failed to download file");
						}
					}
					logger.debug(
						{
							attachmentCount: attachments.length,
							attachments: attachments.map((a) => ({ name: a.originalName, mime: a.mimeType, size: a.sizeBytes })),
						},
						"Files downloaded",
					);
				}

				// Fetch context: thread replies if in a thread, otherwise top-level channel messages
				const historyParams = resolveHistoryParams(
					message,
					config.SLACK_CHANNEL_HISTORY_LIMIT,
					config.SLACK_THREAD_HISTORY_LIMIT,
				);
				logger.debug(
					{ source: historyParams.source, limit: historyParams.limit, threadTs: message.threadTs },
					"Fetching context history",
				);
				const history =
					historyParams.source === "thread"
						? await slackBot.getThreadReplies(historyParams.channelId, historyParams.threadTs, historyParams.limit)
						: await slackBot.getChannelHistory(historyParams.channelId, historyParams.limit);
				logger.debug({ messageCount: history.length }, "Raw history fetched");
				const recentMessages: Array<{ userName: string; text: string }> = [];
				for (const msg of history.reverse()) {
					try {
						const info = await slackBot.getUserInfo(msg.userId);
						recentMessages.push({ userName: info.realName, text: msg.text });
					} catch {
						recentMessages.push({ userName: "Unknown", text: msg.text });
					}
				}
				logger.debug(
					{
						messageCount: recentMessages.length,
						messages: recentMessages.map((m) => `[${m.userName}]: ${m.text.slice(0, 80)}`),
					},
					"Context messages resolved",
				);

				// Post thinking indicator in thread (use existing thread or start new one)
				const thinkingTs = await slackBot.postThreadReply(message.channelId, threadTs, "_Thinking..._");
				const onMessage = createSlackMessageHandler(slackBot, message.channelId, thinkingTs, threadTs);

				const result = await runAgent({
					userMessage: message.text || "See attached files.",
					workspaceDir,
					userName: user.name,
					logger,
					platform: "slack",
					orgName: settingsRow?.org_name,
					botName: settingsRow?.bot_name,
					model: resolveRuntimeModel(settingsRow),
					permissionMode: config.PAPERT_PERMISSION_MODE,
					attachments: attachments.length > 0 ? attachments : undefined,
					channelContext: {
						channelName: channel.name,
						recentMessages,
					},
					onMessage,
				});
				await schedulerBridge.syncWorkspace(workspaceDir);

				let uploadedCount = 0;
				for (const filePath of result.pendingUploads) {
					try {
						logger.info({ channelId: message.channelId, threadTs, filePath }, "Uploading file to Slack thread");
						await slackBot.uploadFile(message.channelId, filePath, threadTs);
						uploadedCount++;
						logger.info({ channelId: message.channelId, threadTs, filePath }, "Uploaded file to Slack thread");
					} catch (err) {
						logger.warn({ err, filePath }, "Failed to upload file to Slack");
					}
				}
				for (const text of result.pendingMessages) {
					try {
						await slackBot.postThreadReply(message.channelId, threadTs, text);
					} catch (err) {
						logger.warn({ err, text }, "Failed to post captured thread message to Slack");
					}
				}

				const rawResponseText = result.text ?? "_No response_";
				const responseText = normalizeUploadResponseText({
					responseText: rawResponseText,
					uploadedCount,
					uploadedFiles: result.pendingUploads,
					userMessageText: message.text || "",
				});
				if (!result.messageSent) {
					await slackBot.updateMessage(message.channelId, thinkingTs, responseText);
				} else if (responseText !== rawResponseText) {
					await slackBot.postThreadReply(message.channelId, threadTs, responseText);
				}
			} catch (err) {
				logger.error(
					{ err, slackUserId: message.userId, channelId: message.channelId },
					"Channel mention processing failed",
				);
				try {
					const threadTs = message.threadTs ?? message.ts;
					await slackBot.postThreadReply(message.channelId, threadTs, "_Something went wrong, try again_");
				} catch (notifyErr) {
					logger.error({ err: notifyErr, channelId: message.channelId }, "Failed to send channel failure message");
				}
			}
		});
	});

	return slackBot;
}

const startSlackBotIfConfigured = createSlackStartupManager({
	logger,
	getSettingsTokens: async () => {
		const settingsRow = await settingsRepo.get();
		return {
			// Prefer DB-backed onboarding settings, fall back to env tokens.
			botToken: settingsRow?.slack_bot_token ?? config.SLACK_BOT_TOKEN ?? null,
			appToken: settingsRow?.slack_app_token ?? config.SLACK_APP_TOKEN ?? null,
		};
	},
	validateTokens: validateSlackTokens,
	getCurrentBot: () => slack,
	setCurrentBot: (bot) => {
		slack = bot;
	},
	createBot: createConfiguredSlackBot,
});

// 6. WhatsApp bot (always available for pairing via API)
const whatsapp = new WhatsAppBot({ db, logger });

// 7. HTTP server
const app = createApp(db, config, {
	whatsapp,
	getSlack: () => slack,
	onSlackTokensUpdated: async (tokens) => {
		if (!tokens) return;
		await startSlackBotIfConfigured(tokens);
	},
	onLlmSettingsUpdated: async () => {
		await applyLlmEnvFromDb();
	},
});
const server = serve({ fetch: app.fetch, port: config.PORT });
logger.info({ port: config.PORT }, "HTTP server started");

// 8. Start Slack and WhatsApp
await bootstrapSchedulerForAllWorkspaces();
await startSlackBotIfConfigured().catch(() => {});
if (!slack) {
	logger.info("Slack is not configured; running with API/scheduler only");
}

const whatsappConnected = await whatsapp.start();
if (whatsappConnected) {
	logger.info("WhatsApp connected");
} else {
	logger.info("WhatsApp not paired - use GET /api/whatsapp/pair to connect");
}
logger.info("Papert Claw is running");

// 9. Graceful shutdown
async function shutdown() {
	logger.info("Shutting down...");
	await schedulerBridge.stopAll();
	if (slack) {
		await slack.stop();
	}
	await whatsapp.stop();
	server.close();
	await db.destroy();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
