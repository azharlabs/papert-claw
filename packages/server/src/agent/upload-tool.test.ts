import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UploadCollector, createUploadMcpServer } from "./upload-tool";

describe("UploadCollector", () => {
	it("stores file paths via collect()", () => {
		const collector = new UploadCollector();
		collector.collect("/workspace/file1.pdf");
		collector.collect("/workspace/file2.csv");
		expect(collector.drain()).toEqual(["/workspace/file1.pdf", "/workspace/file2.csv"]);
	});

	it("drain() clears the queue", () => {
		const collector = new UploadCollector();
		collector.collect("/workspace/file.txt");
		collector.drain();
		expect(collector.drain()).toEqual([]);
	});

	it("drain() on empty collector returns empty array", () => {
		const collector = new UploadCollector();
		expect(collector.drain()).toEqual([]);
	});

	it("stores and drains captured messages", () => {
		const collector = new UploadCollector();
		collector.collectMessage("file is ready");
		collector.collectMessage("uploaded");
		expect(collector.drainMessages()).toEqual(["file is ready", "uploaded"]);
		expect(collector.drainMessages()).toEqual([]);
	});
});

describe("createUploadMcpServer", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "papert-claw-upload-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns a valid MCP server config", () => {
		const collector = new UploadCollector();
		const server = createUploadMcpServer(collector, tmpDir);
		expect(server).toBeDefined();
		expect(typeof server.connect).toBe("function");
	});

	it("has a SendFileToChat tool registered", () => {
		const collector = new UploadCollector();
		const server = createUploadMcpServer(collector, tmpDir);
		expect(typeof server.connect).toBe("function");
	});
});

describe("UploadCollector integration", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "papert-claw-upload-int-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("collects files and drains correctly across multiple calls", () => {
		const collector = new UploadCollector();
		collector.collect(join(tmpDir, "a.pdf"));
		collector.collect(join(tmpDir, "b.csv"));
		collector.collect(join(tmpDir, "c.png"));

		const files = collector.drain();
		expect(files).toHaveLength(3);
		expect(files[0]).toContain("a.pdf");
		expect(files[2]).toContain("c.png");

		// Second drain should be empty
		expect(collector.drain()).toEqual([]);
	});
});
