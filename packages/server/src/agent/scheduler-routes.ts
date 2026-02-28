export interface SchedulerRoute {
	channelId: string;
	threadTs?: string;
	mode: "dm" | "channel";
}

export class SchedulerRoutes {
	private latestRoute: SchedulerRoute | undefined;
	private readonly routesByJobId = new Map<string, SchedulerRoute>();

	setLatestRoute(route: SchedulerRoute): void {
		this.latestRoute = route;
	}

	bindJob(jobId: string): void {
		if (!this.latestRoute) return;
		this.routesByJobId.set(jobId, this.latestRoute);
	}

	removeJob(jobId: string): void {
		this.routesByJobId.delete(jobId);
	}

	resolve(jobId: string): SchedulerRoute | undefined {
		return this.routesByJobId.get(jobId) ?? this.latestRoute;
	}
}
