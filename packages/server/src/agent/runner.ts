/**
 * Core agent execution — invokes the Papert Code SDK's query() in a user's
 * isolated workspace with file access restrictions via canUseTool.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@papert-code/sdk-typescript";
import type { PermissionMode } from "@papert-code/sdk-typescript";
import type { Attachment } from "../files";
import { formatAttachmentsForPrompt } from "../files";
import type { Logger } from "../logger";
import { PAPERT_ALLOWED_TOOLS } from "./allowed-tools";
import { buildSystemContext } from "./prompt";
import { clearSessionId, getSessionId, saveSessionId } from "./sessions";

const PAPERT_CLAW_DEFAULT_SKILLS_PATH = fileURLToPath(new URL("../../../../.papert/skills", import.meta.url));
const INTERACTIVE_CONFIRMATION_ERROR = "Interactive confirmation is disabled in non-interactive mode";
const requireFromHere = createRequire(import.meta.url);
const MANAGED_TOOL_MARKER = "papert-claw-managed-sendfile-tools-v1";
const TOOL_QUEUE_RELATIVE_PATH = join(".papert", ".papert-claw-runtime", "tool-queue.json");

function summarizeAssistantContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const textParts = content
		.filter((part) => part && typeof part === "object" && "type" in part && (part as { type: string }).type === "text")
		.map((part) => ((part as { text?: unknown }).text as string | undefined) ?? "")
		.filter(Boolean);
	return textParts.join("\n").slice(0, 400);
}

const FILE_SEND_TOOL_CANDIDATES = [
	"SendFileToChat",
	"send_file_to_chat",
] as const;
const BLOCKED_UPLOAD_PREFIXES = [".papert/tools", ".papert/.papert-claw-runtime"] as const;

interface ToolQueueSnapshot {
	uploads: string[];
	messages: string[];
}

function resolvePapertExecutable(logger: Logger): string {
	const override = process.env.PAPERT_EXECUTABLE?.trim();
	if (override) return override;

	try {
		const pkgJsonPath = requireFromHere.resolve("@papert-code/papert-code/package.json");
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
		const binField = pkg.bin;
		const binPath =
			typeof binField === "string"
				? binField
				: binField?.papert ?? binField?.["papert-code"] ?? Object.values(binField ?? {})[0];
		if (binPath) {
			return resolve(dirname(pkgJsonPath), binPath);
		}
	} catch (error) {
		logger.warn({ err: error }, "Failed resolving local @papert-code/papert-code binary; falling back to 'papert'");
	}

	return "papert";
}

const CUSTOM_TOOL_SHARED_HELPERS = `
import fs from "node:fs";
import path from "node:path";

const TOOL_QUEUE_RELATIVE_PATH = ${JSON.stringify(TOOL_QUEUE_RELATIVE_PATH)};

function normalizeWorkspacePath(inputPath, workspaceRoot) {
	if (!inputPath || typeof inputPath !== "string") return null;
	const root = path.resolve(workspaceRoot);
	const candidate = path.resolve(root, inputPath);
	if (candidate === root) return candidate;
	if (!candidate.startsWith(root + path.sep)) return null;
	return candidate;
}

function queuePath(workspaceRoot) {
	return path.join(path.resolve(workspaceRoot), TOOL_QUEUE_RELATIVE_PATH);
}

function loadQueue(workspaceRoot) {
	const filePath = queuePath(workspaceRoot);
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return {
			uploads: Array.isArray(parsed?.uploads) ? parsed.uploads.filter((v) => typeof v === "string") : [],
			messages: Array.isArray(parsed?.messages) ? parsed.messages.filter((v) => typeof v === "string") : [],
		};
	} catch {
		return { uploads: [], messages: [] };
	}
}

function saveQueue(workspaceRoot, queue) {
	const filePath = queuePath(workspaceRoot);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(queue), "utf8");
}

function queueUpload(absPath, workspaceRoot) {
	const queue = loadQueue(workspaceRoot);
	queue.uploads.push(absPath);
	saveQueue(workspaceRoot, queue);
}

function queueMessage(message, workspaceRoot) {
	const value = typeof message === "string" ? message.trim() : "";
	if (!value) return;
	const queue = loadQueue(workspaceRoot);
	queue.messages.push(value);
	saveQueue(workspaceRoot, queue);
}
`;

const SEND_FILE_TOOL_SOURCE = `// ${MANAGED_TOOL_MARKER}
${CUSTOM_TOOL_SHARED_HELPERS}

export default {
	description:
		"Queue a workspace file to return to chat.",
	parametersJsonSchema: {
		type: "object",
		properties: {
			file_path: { type: "string", description: "Absolute or workspace-relative path" },
		},
		required: ["file_path"],
	},
	async execute(args, context) {
		const absPath = normalizeWorkspacePath(args?.file_path, context.projectRoot);
		if (!absPath) return "Error: file must be within workspace";
		if (!fs.existsSync(absPath)) return "Error: file not found at " + absPath;
		queueUpload(absPath, context.projectRoot);
		return "Queued file for upload: " + absPath;
	},
};
`;

const MESSAGE_TOOL_SOURCE = `// ${MANAGED_TOOL_MARKER}
${CUSTOM_TOOL_SHARED_HELPERS}

function extractMediaPath(rawMedia, workspaceRoot) {
	if (!rawMedia || typeof rawMedia !== "string") return null;
	if (rawMedia.startsWith("file://")) {
		return normalizeWorkspacePath(rawMedia.slice("file://".length), workspaceRoot);
	}
	return normalizeWorkspacePath(rawMedia, workspaceRoot);
}

export default {
	description:
		"Compatibility message tool. Captures text and optional media file path.",
	parametersJsonSchema: {
		type: "object",
		properties: {
			action: { type: "string" },
			message: { type: "string" },
			media: { type: "string" },
			channel: { type: "string" },
			channelId: { type: "string" },
			to: { type: "string" },
			content: { type: "string" },
		},
	},
	async execute(args, context) {
		const text = (args?.message ?? args?.content ?? "").trim();
		if (text) queueMessage(text, context.projectRoot);

		const mediaPath = extractMediaPath(args?.media, context.projectRoot);
		if (mediaPath) {
			if (!fs.existsSync(mediaPath)) return "Error: media file not found at " + mediaPath;
			queueUpload(mediaPath, context.projectRoot);
		}

		if (!text && !mediaPath) return "No message or media provided.";
		return "Message request captured for delivery.";
	},
};
`;

const SLACK_TOOL_SOURCE = `// ${MANAGED_TOOL_MARKER}
${CUSTOM_TOOL_SHARED_HELPERS}

function extractMediaPath(rawMedia, workspaceRoot) {
	if (!rawMedia || typeof rawMedia !== "string") return null;
	if (rawMedia.startsWith("file://")) {
		return normalizeWorkspacePath(rawMedia.slice("file://".length), workspaceRoot);
	}
	return normalizeWorkspacePath(rawMedia, workspaceRoot);
}

export default {
	description:
		"Slack compatibility tool for sendMessage/sendFile actions.",
	parametersJsonSchema: {
		type: "object",
		properties: {
			action: { type: "string" },
			content: { type: "string" },
			message: { type: "string" },
			media: { type: "string" },
			channelId: { type: "string" },
		},
	},
	async execute(args, context) {
		const text = (args?.content ?? args?.message ?? "").trim();
		if (text) queueMessage(text, context.projectRoot);

		const mediaPath = extractMediaPath(args?.media, context.projectRoot);
		if (mediaPath) {
			if (!fs.existsSync(mediaPath)) return "Error: media file not found at " + mediaPath;
			queueUpload(mediaPath, context.projectRoot);
		}

		if (!text && !mediaPath) return "No content or media provided.";
		return "Slack request captured for delivery.";
	},
};
`;

async function writeManagedToolFile(filePath: string, content: string, logger: Logger): Promise<void> {
	try {
		const existing = await readFile(filePath, "utf8");
		if (!existing.includes(MANAGED_TOOL_MARKER) && existing !== content) {
			logger.warn({ filePath }, "Skipped updating non-managed custom tool file");
			return;
		}
		if (existing === content) return;
	} catch {
		// File does not exist yet.
	}
	await writeFile(filePath, content, "utf8");
}

async function deleteManagedToolFile(filePath: string, logger: Logger): Promise<void> {
	try {
		const existing = await readFile(filePath, "utf8");
		if (!existing.includes(MANAGED_TOOL_MARKER)) return;
		await unlink(filePath);
		logger.info({ filePath }, "Removed legacy managed custom tool file");
	} catch {
		// Ignore missing files.
	}
}

function getWorkspaceToolQueuePath(workspaceDir: string): string {
	return join(workspaceDir, TOOL_QUEUE_RELATIVE_PATH);
}

async function resetWorkspaceToolQueue(workspaceDir: string): Promise<void> {
	const queuePath = getWorkspaceToolQueuePath(workspaceDir);
	await mkdir(dirname(queuePath), { recursive: true });
	await writeFile(queuePath, JSON.stringify({ uploads: [], messages: [] }), "utf8");
}

function normalizeQueueSnapshot(value: unknown, workspaceDir: string): ToolQueueSnapshot {
	if (!value || typeof value !== "object") {
		return { uploads: [], messages: [] };
	}
	const obj = value as { uploads?: unknown; messages?: unknown };
	const workspaceRoot = resolve(workspaceDir);
	const uploads = Array.isArray(obj.uploads)
		? obj.uploads
				.filter((item): item is string => typeof item === "string")
				.map((item) => resolve(workspaceRoot, item))
				.filter((item) => item.startsWith(workspaceRoot) && existsSync(item))
		: [];
	const messages = Array.isArray(obj.messages)
		? obj.messages
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean)
		: [];
	return {
		uploads: Array.from(new Set(uploads)),
		messages: Array.from(new Set(messages)),
	};
}

async function drainWorkspaceToolQueue(workspaceDir: string, logger: Logger): Promise<ToolQueueSnapshot> {
	const queuePath = getWorkspaceToolQueuePath(workspaceDir);
	try {
		const raw = await readFile(queuePath, "utf8");
		return normalizeQueueSnapshot(JSON.parse(raw), workspaceDir);
	} catch (error) {
		logger.debug({ err: error, queuePath }, "Tool queue not available for drain");
		return { uploads: [], messages: [] };
	} finally {
		await resetWorkspaceToolQueue(workspaceDir);
	}
}

async function ensureWorkspaceSendFileTools(workspaceDir: string, logger: Logger): Promise<void> {
	const toolsDir = join(workspaceDir, ".papert", "tools");
	await mkdir(toolsDir, { recursive: true });

	await Promise.all([
		deleteManagedToolFile(join(toolsDir, "SendFileToChat.js"), logger),
		deleteManagedToolFile(join(toolsDir, "send_file_to_chat.js"), logger),
		deleteManagedToolFile(join(toolsDir, "message.js"), logger),
		deleteManagedToolFile(join(toolsDir, "slack.js"), logger),
		writeManagedToolFile(join(toolsDir, "SendFileToChat.mjs"), SEND_FILE_TOOL_SOURCE, logger),
		writeManagedToolFile(join(toolsDir, "send_file_to_chat.mjs"), SEND_FILE_TOOL_SOURCE, logger),
		writeManagedToolFile(join(toolsDir, "message.mjs"), MESSAGE_TOOL_SOURCE, logger),
		writeManagedToolFile(join(toolsDir, "slack.mjs"), SLACK_TOOL_SOURCE, logger),
	]);
}

function hasUploadIntent(userMessage: string): boolean {
	return /\b(attach|upload|send|share)\b/i.test(userMessage);
}

function shouldAutoSelectLatestUpload(userMessage: string): boolean {
	if (!hasUploadIntent(userMessage)) return false;
	if (inferRequestedFileNames(userMessage).length > 0) return false;

	const lower = userMessage.toLowerCase();
	if (/\b(attach|upload|send|share)\s+(this|that|it)\b/.test(lower)) return true;
	if (/\b(this|that|the)\s+file\b/.test(lower)) return true;
	if (/\b(attach|upload|send|share)\b[\s\w]*(file|attachment)\b/.test(lower)) return true;
	return false;
}

function shouldAutoSelectAllUploads(userMessage: string): boolean {
	if (!hasUploadIntent(userMessage)) return false;
	if (inferRequestedFileNames(userMessage).length > 0) return false;

	const lower = userMessage.toLowerCase();
	if (/\b(files|attachments)\b/.test(lower)) return true;
	if (/\bboth\b/.test(lower)) return true;
	return false;
}

function getAutoSelectionPriority(absPath: string, workspaceRoot: string): number {
	const rel = relative(workspaceRoot, absPath).replaceAll("\\", "/");
	if (rel.startsWith("attachments/")) return 3;
	if (basename(absPath).toLowerCase() === "session.json") return 1;
	return 2;
}

function isAttachmentCandidate(absPath: string, workspaceRoot: string): boolean {
	const rel = relative(workspaceRoot, absPath).replaceAll("\\", "/");
	return rel.startsWith("attachments/");
}

function inferRequestedFileNames(userMessage: string): string[] {
	const matches = userMessage.match(/[^\s"'`<>]+\.[A-Za-z0-9_-]+/g) ?? [];
	const normalized = matches
		.map((value) => value.trim().replace(/^[([{"'`]+|[)\]}"'`,.;:!?]+$/g, ""))
		.filter(Boolean)
		.map((value) => basename(value));
	const unique = new Set(normalized);
	return Array.from(unique);
}

function inferFallbackUploads(userMessage: string, workspaceDir: string): string[] {
	if (!hasUploadIntent(userMessage)) return [];

	const names = inferRequestedFileNames(userMessage);
	if (names.length === 0) return [];

	const candidates: string[] = [];
	for (const name of names) {
		const direct = join(workspaceDir, name);
		if (existsSync(direct)) candidates.push(resolve(direct));

		const inAttachments = join(workspaceDir, "attachments", name);
		if (existsSync(inAttachments)) candidates.push(resolve(inAttachments));
	}

	return Array.from(new Set(candidates));
}

function isUploadPathBlocked(absPath: string, workspaceDir: string): boolean {
	const rel = relative(workspaceDir, absPath);
	if (!rel || rel === "." || rel.startsWith("..")) return true;
	const posixRel = rel.replaceAll("\\", "/");
	return BLOCKED_UPLOAD_PREFIXES.some((prefix) => posixRel === prefix || posixRel.startsWith(`${prefix}/`));
}

function enforceUploadPolicy(
	uploadPaths: string[],
	userMessage: string,
	workspaceDir: string,
	logger: Logger,
	source: "queued" | "fallback_request" | "fallback_model",
): string[] {
	const workspaceRoot = resolve(workspaceDir);
	const requested = inferRequestedFileNames(userMessage).map((name) => name.toLowerCase());
	const requestedSet = new Set(requested);
	const autoSelectLatest = requestedSet.size === 0 && shouldAutoSelectLatestUpload(userMessage);
	const autoSelectAll = requestedSet.size === 0 && shouldAutoSelectAllUploads(userMessage);
	const accepted = new Set<string>();
	const dropped: Array<{ filePath: string; reason: string }> = [];
	const autoCandidates: string[] = [];

	for (const candidate of uploadPaths) {
		const abs = resolve(candidate);
		if (!abs.startsWith(`${workspaceRoot}/`) && abs !== workspaceRoot) {
			dropped.push({ filePath: abs, reason: "outside_workspace" });
			continue;
		}
		if (!existsSync(abs)) {
			dropped.push({ filePath: abs, reason: "missing" });
			continue;
		}
		if (isUploadPathBlocked(abs, workspaceRoot)) {
			dropped.push({ filePath: abs, reason: "blocked_internal_path" });
			continue;
		}
		if (requestedSet.size === 0) {
			if (autoSelectLatest || autoSelectAll) {
				autoCandidates.push(abs);
			} else {
				dropped.push({ filePath: abs, reason: "no_explicit_file_request" });
			}
			continue;
		}

		const lowerPath = abs.toLowerCase();
		const lowerBase = basename(lowerPath);
		const matchedRequestedName = requestedSet.has(lowerBase) || requested.some((name) => lowerPath.endsWith(name));
		if (!matchedRequestedName) {
			dropped.push({ filePath: abs, reason: "not_user_requested" });
			continue;
		}

		accepted.add(abs);
	}

	if (autoSelectAll && autoCandidates.length > 0) {
		const attachmentCandidates = autoCandidates.filter((path) => isAttachmentCandidate(path, workspaceRoot));
		const chosen =
			attachmentCandidates.length > 0
				? attachmentCandidates
				: autoCandidates.filter((path) => basename(path).toLowerCase() !== "session.json");

		const selected = chosen.length > 0 ? chosen : autoCandidates;
		for (const path of selected) accepted.add(path);
		for (const path of autoCandidates) {
			if (!accepted.has(path)) {
				dropped.push({ filePath: path, reason: "auto_selected_all_excluded" });
			}
		}
		logger.info(
			{
				source,
				workspaceDir,
				selectedCount: selected.length,
				autoCandidateCount: autoCandidates.length,
			},
			"Auto-selected all upload candidates",
		);
	}

	if (!autoSelectAll && autoSelectLatest && autoCandidates.length > 0) {
		let selected = autoCandidates[0];
		let selectedMtime = Number.NEGATIVE_INFINITY;
		let selectedPriority = Number.NEGATIVE_INFINITY;
		for (const path of autoCandidates) {
			let mtime = Number.NEGATIVE_INFINITY;
			try {
				mtime = statSync(path).mtimeMs;
			} catch {
				mtime = Number.NEGATIVE_INFINITY;
			}
			const priority = getAutoSelectionPriority(path, workspaceRoot);
			if (
				priority > selectedPriority ||
				(priority === selectedPriority && (mtime > selectedMtime || (mtime === selectedMtime && path > selected)))
			) {
				selected = path;
				selectedMtime = mtime;
				selectedPriority = priority;
			}
		}
		accepted.add(selected);
		for (const path of autoCandidates) {
			if (path !== selected) {
				dropped.push({ filePath: path, reason: "auto_selected_latest_other" });
			}
		}
		logger.info(
			{
				source,
				workspaceDir,
				selectedFile: selected,
				autoCandidateCount: autoCandidates.length,
			},
			"Auto-selected latest upload candidate",
		);
	}

	if (dropped.length > 0) {
		logger.info(
			{
				source,
				workspaceDir,
				acceptedCount: accepted.size,
				droppedCount: dropped.length,
				droppedSample: dropped.slice(0, 10),
			},
			"Upload policy filtered pending files",
		);
	}

	return Array.from(accepted);
}

function filterUploadsToRequestedFileNames(uploadPaths: string[], userMessage: string): string[] {
	const requested = inferRequestedFileNames(userMessage).map((name) => name.toLowerCase());
	if (requested.length === 0) return [];

	const requestedSet = new Set(requested);
	const filtered = uploadPaths.filter((path) => {
		const pathLower = path.toLowerCase();
		const baseLower = basename(pathLower);
		if (requestedSet.has(baseLower)) return true;
		return requested.some((name) => pathLower.endsWith(name));
	});

	return filtered;
}

function inferUploadsFromModelText(text: string | null, workspaceDir: string): string[] {
	if (!text) return [];

	const absWorkspace = resolve(workspaceDir);
	const candidates = new Set<string>();

	const mediaMatches = text.match(/MEDIA:([^\s]+)/g) ?? [];
	for (const token of mediaMatches) {
		const raw = token.slice("MEDIA:".length).trim();
		const normalized = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
		const abs = resolve(normalized);
		if (abs.startsWith(absWorkspace) && existsSync(abs)) {
			candidates.add(abs);
		}
	}

	const fileUrlMatches = text.match(/file:\/\/[^\s]+/g) ?? [];
	for (const url of fileUrlMatches) {
		const abs = resolve(url.slice("file://".length));
		if (abs.startsWith(absWorkspace) && existsSync(abs)) {
			candidates.add(abs);
		}
	}

	return Array.from(candidates);
}

function inferMessagesFromModelText(text: string | null): string[] {
	if (!text) return [];
	const messages = new Set<string>();
	const messageMatches = text.match(/MESSAGE:([^\n\r]+)/g) ?? [];
	for (const token of messageMatches) {
		const value = token.slice("MESSAGE:".length).trim();
		if (value) messages.add(value);
	}
	return Array.from(messages);
}

function collectContentStrings(content: unknown): string[] {
	const out: string[] = [];
	if (typeof content === "string") {
		out.push(content);
		return out;
	}
	if (!Array.isArray(content)) return out;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const blockType = (block as { type?: string }).type;
		if (blockType === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) out.push(text);
		}
		if (blockType === "tool_result") {
			const toolContent = (block as { content?: unknown }).content;
			if (typeof toolContent === "string" && toolContent.trim()) {
				out.push(toolContent);
			}
			if (Array.isArray(toolContent)) {
				for (const nested of toolContent) {
					if (!nested || typeof nested !== "object") continue;
					if ((nested as { type?: string }).type === "text") {
						const nestedText = (nested as { text?: unknown }).text;
						if (typeof nestedText === "string" && nestedText.trim()) out.push(nestedText);
					}
				}
			}
		}
	}

	return out;
}

export interface AgentResult {
	messageSent: boolean;
	text: string | null;
	sessionId: string;
	costUsd: number;
	pendingUploads: string[];
	pendingMessages: string[];
}

export interface RunAgentParams {
	userMessage: string;
	workspaceDir: string;
	userName: string;
	logger: Logger;
	platform?: "slack" | "whatsapp";
	orgName?: string | null;
	botName?: string | null;
	model?: string;
	permissionMode: PermissionMode;
	attachments?: Attachment[];
	channelContext?: {
		channelName: string;
		recentMessages: Array<{ userName: string; text: string }>;
	};
	onMessage?: (text: string) => Promise<void>;
}

/**
 * Extracts text blocks from assistant messages for incremental delivery.
 * Returns null when no non-empty assistant text exists.
 */
export function extractAssistantText(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const msg = message as { type?: string; message?: { content?: unknown } };
	if (msg.type !== "assistant") return null;

	const content = msg.message?.content;
	if (!Array.isArray(content)) return null;

	const texts = content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => ((block as { text?: unknown }).text as string | undefined) ?? "")
		.map((text) => text.trim())
		.filter(Boolean);

	if (texts.length === 0) return null;
	return texts.join("\n");
}

export async function runAgent(params: RunAgentParams): Promise<AgentResult> {
	const { userMessage, workspaceDir, userName, logger, model, permissionMode } = params;
	const effectivePermissionMode: PermissionMode = "yolo";
	if (permissionMode !== "yolo") {
		logger.warn(
			{
				configuredPermissionMode: permissionMode,
				effectivePermissionMode,
			},
			"Overriding permission mode to yolo for non-interactive Papert SDK run",
		);
	}
	const existingSessionId = await getSessionId(workspaceDir);
	const absWorkspace = resolve(workspaceDir);
	const papertExecutable = resolvePapertExecutable(logger);
	await ensureWorkspaceSendFileTools(absWorkspace, logger);
	await resetWorkspaceToolQueue(absWorkspace);

	const systemAppend = buildSystemContext({
		platform: params.platform ?? "slack",
		userName,
		workspaceDir: absWorkspace,
		orgName: params.orgName,
		botName: params.botName,
		channelContext: params.channelContext,
	});

	let sessionId = "";
	let resultText: string | null = null;
	let costUsd = 0;
	let missingFileSendTools = false;
	const observedText: string[] = [];
	let messageSent = false;

	const attachments = params.attachments ?? [];
	const prompt = [
		userMessage + formatAttachmentsForPrompt(attachments),
		"<papert-claw_system_context>",
		systemAppend,
		"</papert-claw_system_context>",
	].join("\n\n");

	logger.info(
		{
			workspaceDir,
			resumeSessionId: existingSessionId ?? null,
			model: model ?? null,
			permissionMode: effectivePermissionMode,
			skillsPath: [PAPERT_CLAW_DEFAULT_SKILLS_PATH],
			allowedTools: PAPERT_ALLOWED_TOOLS,
			papertExecutable,
			attachments: attachments.length,
			channelMode: params.channelContext ? "channel" : "dm",
		},
		"Starting Papert SDK run",
	);

	const q = query({
		prompt,
		options: {
			cwd: workspaceDir,
			...(model ? { model } : {}),
			permissionMode: effectivePermissionMode,
			skillsPath: [PAPERT_CLAW_DEFAULT_SKILLS_PATH],
			pathToPapertExecutable: papertExecutable,
			debug: true,
			...(existingSessionId ? { sessionId: existingSessionId } : {}),
			maxSessionTurns: 100,
			allowedTools: [...PAPERT_ALLOWED_TOOLS],
			canUseTool: async (_toolName, input) => ({
				behavior: "allow",
				updatedInput: input,
			}),
			stderr: (data) => {
				logger.debug({ stderr: data.trim() }, "Agent subprocess");
			},
		},
	});

	await q.initialized;

	for await (const message of q) {
		if (message.type === "system") {
			sessionId = message.session_id;
			const toolNames = message.tools ?? [];
			const availableFileSendTools = FILE_SEND_TOOL_CANDIDATES.filter((tool) => toolNames.includes(tool));
			logger.debug(
				{
					subtype: message.subtype,
					sessionId: message.session_id,
					model: message.model,
					permissionMode: message.permission_mode,
					mcpServers: message.mcp_servers ?? [],
					toolCount: toolNames.length,
					tools: toolNames.slice(0, 30),
					availableFileSendTools,
				},
				"Papert system message",
			);
			if (availableFileSendTools.length === 0) {
				missingFileSendTools = true;
				logger.warn(
					{
						sessionId: message.session_id,
						toolCount: toolNames.length,
						sampleTools: toolNames.slice(0, 50),
					},
					"No SendFileToChat-compatible tool exposed in Papert tool catalog",
				);
			}
		}

		if (message.type === "assistant") {
			observedText.push(...collectContentStrings(message.message?.content));
			const assistantText = extractAssistantText(message);
			if (assistantText && params.onMessage) {
				try {
					await params.onMessage(assistantText);
					messageSent = true;
				} catch (err) {
					logger.warn({ err, sessionId: message.session_id }, "Failed to deliver assistant message");
				}
			}
			logger.debug(
				{
					sessionId: message.session_id,
					contentPreview: summarizeAssistantContent(message.message?.content),
				},
				"Papert assistant message",
			);
		}

		if (message.type === "user") {
			observedText.push(...collectContentStrings(message.message?.content));
		}

		if (message.type === "result") {
			sessionId = message.session_id;
			logger.info(
				{
					sessionId: message.session_id,
					subtype: message.subtype,
					isError: message.is_error,
					numTurns: message.num_turns,
					permissionDenials: message.permission_denials?.length ?? 0,
					permissionDenialDetails: message.permission_denials ?? [],
					errorMessage:
						message.is_error && typeof message.error === "object" && message.error && "message" in message.error
							? message.error.message
							: undefined,
				},
				"Papert result message",
			);
			if (!message.is_error && typeof message.result === "string") {
				const result = message.result;
				resultText = result;
				observedText.push(result);
				if (result.includes(INTERACTIVE_CONFIRMATION_ERROR)) {
					logger.error(
						{
							sessionId: message.session_id,
							permissionMode: effectivePermissionMode,
							resultPreview: result.slice(0, 600),
						},
						"Papert returned interactive-confirmation error text",
					);
				}
			}
		}
	}

	if (!sessionId) {
		sessionId = q.getSessionId();
	}

	await q.close();

	if (missingFileSendTools && existingSessionId) {
		await clearSessionId(workspaceDir);
		logger.warn(
			{ workspaceDir, previousSessionId: existingSessionId },
			"Cleared saved session id because resumed session missed SendFileToChat-compatible tools",
		);
	}

	if (sessionId && !(missingFileSendTools && existingSessionId)) {
		await saveSessionId(workspaceDir, sessionId);
	}

	const queued = await drainWorkspaceToolQueue(absWorkspace, logger);
	let pendingUploads = enforceUploadPolicy(queued.uploads, userMessage, absWorkspace, logger, "queued");
	const pendingMessages = [...queued.messages];
	if (pendingUploads.length > 0 || pendingMessages.length > 0) {
		logger.info(
			{
				workspaceDir,
				queuedUploads: pendingUploads.length,
				queuedMessages: pendingMessages.length,
			},
			"Drained workspace custom tool queue",
		);
	}
	if (pendingUploads.length === 0) {
		const inferred = inferFallbackUploads(userMessage, absWorkspace);
		const filteredInferred = enforceUploadPolicy(inferred, userMessage, absWorkspace, logger, "fallback_request");
		if (filteredInferred.length > 0) {
			pendingUploads = filteredInferred;
			logger.info(
				{ workspaceDir, inferredUploads: filteredInferred },
				"Inferred fallback uploads from user attachment request",
			);
		}
	}
	if (pendingUploads.length === 0) {
		const inferredFromModel = Array.from(
			new Set(observedText.flatMap((text) => inferUploadsFromModelText(text, absWorkspace))),
		);
		const filteredInferred = enforceUploadPolicy(
			filterUploadsToRequestedFileNames(inferredFromModel, userMessage),
			userMessage,
			absWorkspace,
			logger,
			"fallback_model",
		);
		if (filteredInferred.length > 0) {
			pendingUploads = filteredInferred;
			logger.info(
				{ workspaceDir, inferredUploads: filteredInferred },
				"Inferred fallback uploads from model MEDIA/file output",
			);
		}
	}
	if (pendingMessages.length === 0) {
		const inferredMessages = Array.from(new Set(observedText.flatMap((text) => inferMessagesFromModelText(text))));
		if (inferredMessages.length > 0) {
			pendingMessages.push(...inferredMessages);
			logger.info(
				{ workspaceDir, inferredMessages: inferredMessages.slice(0, 5), count: inferredMessages.length },
				"Inferred fallback messages from model tool output",
			);
		}
	}
	if (!resultText && pendingMessages.length > 0) {
		resultText = pendingMessages.join("\n");
	}
	logger.info(
		{ userId: userName, sessionId, costUsd, pendingUploads: pendingUploads.length, pendingMessages: pendingMessages.length },
		"Agent run completed",
	);

	return { messageSent, text: resultText, sessionId, costUsd, pendingUploads, pendingMessages };
}
