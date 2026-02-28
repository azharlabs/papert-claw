import { describe, expect, it } from "vitest";
import { SchedulerRoutes } from "./scheduler-routes";

describe("SchedulerRoutes", () => {
	it("resolves latest route when no job route is bound", () => {
		const routes = new SchedulerRoutes();
		routes.setLatestRoute({ mode: "dm", channelId: "D001" });
		expect(routes.resolve("job-1")).toEqual({ mode: "dm", channelId: "D001" });
	});

	it("binds job to current route at add time", () => {
		const routes = new SchedulerRoutes();
		routes.setLatestRoute({ mode: "channel", channelId: "C001", threadTs: "111.1" });
		routes.bindJob("job-1");
		routes.setLatestRoute({ mode: "channel", channelId: "C001", threadTs: "222.2" });
		expect(routes.resolve("job-1")).toEqual({ mode: "channel", channelId: "C001", threadTs: "111.1" });
	});

	it("falls back to latest route after remove", () => {
		const routes = new SchedulerRoutes();
		routes.setLatestRoute({ mode: "channel", channelId: "C001", threadTs: "111.1" });
		routes.bindJob("job-1");
		routes.removeJob("job-1");
		expect(routes.resolve("job-1")).toEqual({ mode: "channel", channelId: "C001", threadTs: "111.1" });
	});
});
