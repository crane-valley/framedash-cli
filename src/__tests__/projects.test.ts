import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "../commands/projects.js";

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

describe("projects command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		delete process.env.FRAMEDASH_PROJECT_ID;
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	describe("list", () => {
		it("calls GET /api/v1/projects and outputs the project list", async () => {
			const projectList = [
				{ id: "p1", name: "Project Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
				{ id: "p2", name: "Project Beta", createdAt: "2026-02-01T00:00:00.000Z" },
			];
			const client = mockClient({ get: vi.fn().mockResolvedValue(projectList) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await projects(["list"]);

			expect(client.get).toHaveBeenCalledWith("/api/v1/projects");
			expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(projectList, null, 2));
		});

		it("does not require --project-id", async () => {
			const client = mockClient({ get: vi.fn().mockResolvedValue([]) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await projects(["list"]);

			expect(createClientModule.createClient).toHaveBeenCalledWith(
				"https://app.framedash.dev",
				{ kind: "api-key", apiKey: "fd_test_key", source: "env" },
				"",
			);
		});

		it("outputs table format when requested", async () => {
			const projectList = [
				{ id: "p1", name: "Project Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
			];
			const client = mockClient({ get: vi.fn().mockResolvedValue(projectList) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await projects(["list", "--format", "table"]);

			const output = vi.mocked(loggerModule.log).mock.calls[0]?.[0] ?? "";
			expect(output).toContain("id");
			expect(output).toContain("name");
			expect(output).toContain("p1");
			expect(output).toContain("Project Alpha");
		});

		it("shows help with --help", async () => {
			await projects(["list", "--help"]);

			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("Usage: framedash projects list"),
			);
			expect(createClientModule.createClient).not.toHaveBeenCalled();
		});
	});

	describe("subcommand dispatch", () => {
		it("shows help when no subcommand given", async () => {
			await projects([]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash projects <subcommand>"),
			);
		});

		it("shows help with --help", async () => {
			await projects(["--help"]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash projects <subcommand>"),
			);
		});

		it("exits with error on unknown subcommand", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(projects(["delete"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("Unknown projects subcommand: delete");

			exitSpy.mockRestore();
		});
	});
});
