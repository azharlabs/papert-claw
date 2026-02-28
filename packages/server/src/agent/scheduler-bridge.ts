import { query } from "@papert-code/sdk-typescript";
import type { PermissionMode, SDKMessage } from "@papert-code/sdk-typescript";
import type { Logger } from "../logger";
import { PAPERT_ALLOWED_TOOLS } from "./allowed-tools";
import { SchedulerRoutes } from "./scheduler-routes";
import type { SchedulerRoute } from "./scheduler-routes";

const CWD = ".";

export interface SchedulerBridgeOptions {
	logger: Logger;
	model?: string;
	permissionMode: PermissionMode;
	onDelivery: (route: SchedulerRoute, text: string) => Promise<void>;
}

interface SchedulerEventData {
	cwd?: string;
	event?: {
		jobId?: string;
		action?: "added" | "updated" | "removed" | "started" | "finished";
		status?: "ok" | "error" | "skipped";
		summary?: string;
		error?: string;
	};
}

interface WorkspaceSchedulerState {
	routes: SchedulerRoutes;
	control: (subtype: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
	closing: boolean;
	stop: () => Promise<void>;
}

async function* keepAlive() {
	await new Promise(() => {});
}

function parseSchedulerEventData(data: unknown): SchedulerEventData | null {
	if (!data || typeof data !== "object") return null;
	return data as SchedulerEventData;
}

function formatFinishedEventText(event: NonNullable<SchedulerEventData["event"]>): string {
	const status = event.status ?? "ok";
	const details = event.summary || event.error || "completed";
	if (status === "ok") return `Scheduled job ${event.jobId ?? "unknown"}: ${details}`;
	if (status === "skipped") return `Scheduled job ${event.jobId ?? "unknown"} was skipped: ${details}`;
	return `Scheduled job ${event.jobId ?? "unknown"} failed: ${details}`;
}

export class SchedulerBridge {
	private readonly logger: Logger;
	private readonly model?: string;
	private readonly permissionMode: PermissionMode;
	private readonly onDelivery: (route: SchedulerRoute, text: string) => Promise<void>;
	private readonly workspaces = new Map<string, WorkspaceSchedulerState>();

	constructor(options: SchedulerBridgeOptions) {
		this.logger = options.logger;
		this.model = options.model;
		this.permissionMode = options.permissionMode;
		this.onDelivery = options.onDelivery;
	}

	async ensureWorkspace(workspaceDir: string, route?: SchedulerRoute): Promise<void> {
		const existing = this.workspaces.get(workspaceDir);
		if (existing) {
			if (route) existing.routes.setLatestRoute(route);
			return;
		}

		const effectivePermissionMode: PermissionMode = "yolo";
		if (this.permissionMode !== "yolo") {
			this.logger.warn(
				{
					workspaceDir,
					configuredPermissionMode: this.permissionMode,
					effectivePermissionMode,
				},
				"Overriding scheduler permission mode to yolo for non-interactive run",
			);
		}

		const q = query({
			prompt: keepAlive(),
			options: {
				cwd: workspaceDir,
				...(this.model ? { model: this.model } : {}),
				permissionMode: effectivePermissionMode,
				pathToPapertExecutable: "papert",
				debug: true,
				allowedTools: [...PAPERT_ALLOWED_TOOLS],
				canUseTool: async (_toolName, input) => ({
					behavior: "allow",
					updatedInput: input,
				}),
				stderr: (line) => this.logger.debug({ workspaceDir, stderr: line.trim() }, "Papert scheduler stderr"),
			},
		});

		await q.initialized;

		const legacyControl = q as unknown as {
			sendControlRequest?: (subtype: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
		};
		if (typeof legacyControl.sendControlRequest !== "function") {
			throw new Error("Papert Query.sendControlRequest is not available in this SDK build");
		}
		const control = legacyControl.sendControlRequest.bind(q) as (
			subtype: string,
			payload?: Record<string, unknown>,
		) => Promise<Record<string, unknown> | null>;
		const startResp = await control("scheduler_start", { cwd: CWD });
		const statusResp = await control("scheduler_status", { cwd: CWD });
		this.logger.info({ workspaceDir, startResp, statusResp }, "Scheduler bridge initialized");

		const state: WorkspaceSchedulerState = {
			routes: new SchedulerRoutes(),
			control,
			closing: false,
			stop: async () => {
				state.closing = true;
				await q.close();
			},
		};
		if (route) state.routes.setLatestRoute(route);
		this.workspaces.set(workspaceDir, state);

		void this.consumeWorkspaceStream(workspaceDir, q);
	}

	async syncWorkspace(workspaceDir: string): Promise<void> {
		const state = this.workspaces.get(workspaceDir);
		if (!state) return;
		try {
			const statusResp = await state.control("scheduler_status", { cwd: CWD });
			const startResp = await state.control("scheduler_start", { cwd: CWD });
			this.logger.debug({ workspaceDir, statusResp, startResp }, "Scheduler bridge synced workspace");
		} catch (err) {
			this.logger.error({ err, workspaceDir }, "Scheduler bridge sync failed");
		}
	}

	private async consumeWorkspaceStream(workspaceDir: string, q: ReturnType<typeof query>): Promise<void> {
		try {
			for await (const message of q) {
				await this.handleMessage(workspaceDir, message);
			}
		} catch (err) {
			this.logger.error({ err, workspaceDir }, "Scheduler bridge stream failed");
		} finally {
			const state = this.workspaces.get(workspaceDir);
			if (state && !state.closing) {
				this.logger.warn({ workspaceDir }, "Scheduler bridge stopped unexpectedly; clearing workspace session");
			}
			this.workspaces.delete(workspaceDir);
		}
	}

	private async handleMessage(workspaceDir: string, message: SDKMessage): Promise<void> {
		if (message.type !== "system" || message.subtype !== "scheduler_event") {
			return;
		}

		const state = this.workspaces.get(workspaceDir);
		if (!state) return;

		const parsed = parseSchedulerEventData(message.data);
		const event = parsed?.event;
		if (!event?.action || !event.jobId) return;

		if (event.action === "added") {
			state.routes.bindJob(event.jobId);
			return;
		}

		if (event.action === "removed") {
			state.routes.removeJob(event.jobId);
			return;
		}

		if (event.action !== "finished") {
			return;
		}

		const route = state.routes.resolve(event.jobId);
		if (!route) {
			this.logger.warn({ workspaceDir, event }, "Scheduler event has no route mapping");
			return;
		}

		const text = formatFinishedEventText(event);
		try {
			await this.onDelivery(route, text);
		} catch (err) {
			this.logger.error({ err, workspaceDir, route, event }, "Failed to deliver scheduled message");
		}
	}

	async stopAll(): Promise<void> {
		const states = [...this.workspaces.values()];
		await Promise.all(states.map((s) => s.stop()));
		this.workspaces.clear();
	}
}
