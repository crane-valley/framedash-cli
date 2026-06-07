import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@framedash/api-client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../commands/query.js";

vi.mock("../lib/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
}));

vi.mock("../lib/create-client.js", () => ({
	createClient: vi.fn(),
}));

import * as createClientModule from "../lib/create-client.js";
import * as loggerModule from "../lib/logger.js";

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		get: vi.fn(),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
		projectPath: vi.fn((s: string) => `/api/v1/projects/test-project/${s}`),
		currentProjectId: "test-project",
		withProject: vi.fn(),
		...overrides,
	} as unknown as ApiClient;
}

describe("query command", () => {
	const tmpFiles: string[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	afterAll(async () => {
		const { unlink } = await import("node:fs/promises");
		for (const f of tmpFiles) {
			try {
				await unlink(f);
			} catch {
				// ignore cleanup errors
			}
		}
	});

	it("sends inline SQL via positional argument", async () => {
		const result = { columns: ["count()"], data: [[42]] };
		const client = mockClient({ post: vi.fn().mockResolvedValue(result) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await query(["SELECT count() FROM events"]);

		expect(client.post).toHaveBeenCalledWith("/api/v1/query", {
			sql: "SELECT count() FROM events",
			project_id: "test-project",
		});
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
	});

	it("joins multiple positional args as SQL", async () => {
		const client = mockClient({ post: vi.fn().mockResolvedValue({}) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await query(["SELECT", "count()", "FROM", "events"]);

		expect(client.post).toHaveBeenCalledWith("/api/v1/query", {
			sql: "SELECT count() FROM events",
			project_id: "test-project",
		});
	});

	it("reads SQL from --file", async () => {
		const sqlFile = join(tmpdir(), `framedash-test-${Date.now()}.sql`);
		tmpFiles.push(sqlFile);
		await writeFile(sqlFile, "SELECT event_name FROM events LIMIT 10");

		const client = mockClient({ post: vi.fn().mockResolvedValue({ data: [] }) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await query(["--file", sqlFile]);

		expect(client.post).toHaveBeenCalledWith("/api/v1/query", {
			sql: "SELECT event_name FROM events LIMIT 10",
			project_id: "test-project",
		});
	});

	it("passes --limit to request body", async () => {
		const client = mockClient({ post: vi.fn().mockResolvedValue({}) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await query(["SELECT 1", "--limit", "50"]);

		expect(client.post).toHaveBeenCalledWith("/api/v1/query", {
			sql: "SELECT 1",
			project_id: "test-project",
			limit: 50,
		});
	});

	it("exits with error when no SQL provided", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		await expect(query([])).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			"SQL query is required. Provide as argument or use --file.",
		);

		exitSpy.mockRestore();
	});

	it("exits with error when --file does not exist", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		await expect(query(["--file", "/nonexistent/query.sql"])).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("Failed to read SQL file"),
		);

		exitSpy.mockRestore();
	});

	it("exits with error when both --file and positional SQL are given", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		await expect(query(["--file", "q.sql", "SELECT", "1"])).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			"Cannot use both --file and a positional SQL argument. Provide one or the other.",
		);

		exitSpy.mockRestore();
	});

	it("formats output as CSV when --format csv", async () => {
		const result = [
			{ event_name: "login", count: 100 },
			{ event_name: "purchase", count: 25 },
		];
		const client = mockClient({ post: vi.fn().mockResolvedValue(result) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await query(["SELECT 1", "--format", "csv"]);

		const output = vi.mocked(loggerModule.log).mock.calls[0]?.[0] ?? "";
		expect(output).toContain("event_name,count");
		expect(output).toContain("login,100");
		expect(output).toContain("purchase,25");
	});

	it("shows help with --help", async () => {
		await query(["--help"]);

		expect(loggerModule.log).toHaveBeenCalledWith(
			expect.stringContaining("Usage: framedash query"),
		);
	});
});
