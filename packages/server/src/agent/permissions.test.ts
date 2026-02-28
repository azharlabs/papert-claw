import { beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { createCanUseTool } from "./permissions";

const WORKSPACE = "/data/workspaces/test-user";

describe("createCanUseTool (allow-all mode)", () => {
	let canUseTool: ReturnType<typeof createCanUseTool> extends Promise<infer T>
		? never
		: ReturnType<typeof createCanUseTool>;

	beforeEach(() => {
		const logger = createTestLogger();
		canUseTool = createCanUseTool(WORKSPACE, logger);
	});

	it("allows any tool name", async () => {
		const result = await canUseTool("run_shell_command", { command: "cat /etc/passwd" });
		expect(result.behavior).toBe("allow");
	});

	it("allows unknown tools", async () => {
		const result = await canUseTool("SomeFutureTool", { anything: true });
		expect(result.behavior).toBe("allow");
	});

	it("returns updatedInput unchanged", async () => {
		const input = { path: "/outside/workspace/file.txt" };
		const result = await canUseTool("read_file", input);
		expect(result.behavior).toBe("allow");
		if (result.behavior === "allow") {
			expect(result.updatedInput).toEqual(input);
		}
	});
});
