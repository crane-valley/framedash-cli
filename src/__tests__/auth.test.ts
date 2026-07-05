import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../commands/auth.js";

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

describe("auth command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		delete process.env.FRAMEDASH_PROJECT_ID;
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	it("calls GET /api/v1/projects and outputs project list", async () => {
		const projects = [
			{ id: "p1", name: "Project Alpha" },
			{ id: "p2", name: "Project Beta" },
		];
		const client = mockClient({ get: vi.fn().mockResolvedValue(projects) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await auth([]);

		expect(client.get).toHaveBeenCalledWith("/api/v1/projects");
		expect(loggerModule.success).toHaveBeenCalledWith("API key is valid");
		expect(loggerModule.success).toHaveBeenCalledWith(
			"Credential source: API key from FRAMEDASH_API_KEY env",
		);
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(projects, null, 2));
	});

	it("reports the flag as the credential source when --api-key is passed", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue([]) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await auth(["--api-key", "fd_override_key"]);

		expect(loggerModule.success).toHaveBeenCalledWith(
			"Credential source: API key from --api-key flag",
		);
	});

	it("does not require --project-id", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue([]) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await auth([]);

		expect(createClientModule.createClient).toHaveBeenCalledWith(
			"https://app.framedash.dev",
			{ kind: "api-key", apiKey: "fd_test_key", source: "env" },
			"",
		);
	});

	it("uses --api-key flag over env var", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue([]) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await auth(["--api-key", "fd_override_key"]);

		expect(createClientModule.createClient).toHaveBeenCalledWith(
			"https://app.framedash.dev",
			{ kind: "api-key", apiKey: "fd_override_key", source: "flag" },
			"",
		);
	});

	it("uses --base-url flag", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue([]) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await auth(["--base-url", "https://custom.example.com"]);

		expect(createClientModule.createClient).toHaveBeenCalledWith(
			"https://custom.example.com",
			{ kind: "api-key", apiKey: "fd_test_key", source: "env" },
			"",
		);
	});

	it("outputs in table format when --format table", async () => {
		const projects = [{ id: "p1", name: "Project Alpha" }];
		const client = mockClient({ get: vi.fn().mockResolvedValue(projects) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await auth(["--format", "table"]);

		const output = vi.mocked(loggerModule.log).mock.calls[0]?.[0] ?? "";
		expect(output).toContain("id");
		expect(output).toContain("name");
		expect(output).toContain("p1");
		expect(output).toContain("Project Alpha");
	});

	it("shows help with --help", async () => {
		await auth(["--help"]);

		expect(loggerModule.log).toHaveBeenCalledWith(expect.stringContaining("Usage: framedash auth"));
		expect(createClientModule.createClient).not.toHaveBeenCalled();
	});

	it("shows help with -h", async () => {
		await auth(["-h"]);

		expect(loggerModule.log).toHaveBeenCalledWith(expect.stringContaining("Usage: framedash auth"));
	});
});
