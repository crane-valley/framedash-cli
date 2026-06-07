import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboard } from "../commands/dashboard.js";
import { funnel } from "../commands/funnel.js";
import { retention } from "../commands/retention.js";
import { status } from "../commands/status.js";

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

describe("status command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	it("calls GET on project status path", async () => {
		const statusData = { projectName: "My Game", totalEvents: 12345 };
		const client = mockClient({ get: vi.fn().mockResolvedValue(statusData) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await status([]);

		expect(client.projectPath).toHaveBeenCalledWith("status");
		expect(client.get).toHaveBeenCalledWith("/api/v1/projects/test-project/status");
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(statusData, null, 2));
	});

	it("shows help with --help", async () => {
		await status(["--help"]);
		expect(loggerModule.log).toHaveBeenCalledWith(
			expect.stringContaining("Usage: framedash status"),
		);
	});
});

describe("dashboard command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	it("calls GET with default 30 days", async () => {
		const kpi = { avgFps: 58.3, p95FrameTime: 22.1 };
		const client = mockClient({ get: vi.fn().mockResolvedValue(kpi) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await dashboard([]);

		expect(client.projectPath).toHaveBeenCalledWith(expect.stringContaining("dashboard?days=30"));
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(kpi, null, 2));
	});

	it("passes custom --days parameter", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue({}) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await dashboard(["--days", "7"]);

		expect(client.projectPath).toHaveBeenCalledWith(expect.stringContaining("dashboard?days=7"));
	});

	it("shows help with --help", async () => {
		await dashboard(["--help"]);
		expect(loggerModule.log).toHaveBeenCalledWith(
			expect.stringContaining("Usage: framedash dashboard"),
		);
	});
});

describe("retention command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	it("calls GET with default 30 days", async () => {
		const cohorts = { day1: 0.85, day7: 0.42, day30: 0.15 };
		const client = mockClient({ get: vi.fn().mockResolvedValue(cohorts) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await retention([]);

		expect(client.projectPath).toHaveBeenCalledWith(expect.stringContaining("retention?days=30"));
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(cohorts, null, 2));
	});

	it("passes custom --days parameter", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue({}) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await retention(["--days", "14"]);

		expect(client.projectPath).toHaveBeenCalledWith(expect.stringContaining("retention?days=14"));
	});

	it("shows help with --help", async () => {
		await retention(["--help"]);
		expect(loggerModule.log).toHaveBeenCalledWith(
			expect.stringContaining("Usage: framedash retention"),
		);
	});
});

describe("funnel command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	it("calls GET with --steps parameter", async () => {
		const funnelData = {
			steps: [
				{ event: "login", count: 1000 },
				{ event: "tutorial", count: 750 },
				{ event: "purchase", count: 200 },
			],
		};
		const client = mockClient({ get: vi.fn().mockResolvedValue(funnelData) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await funnel(["--steps", "login,tutorial,purchase"]);

		const pathArg = vi.mocked(client.projectPath).mock.calls[0]?.[0] ?? "";
		expect(pathArg).toContain("funnels?");
		expect(pathArg).toContain("steps=login%2Ctutorial%2Cpurchase");
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(funnelData, null, 2));
	});

	it("passes --days and --window parameters", async () => {
		const client = mockClient({ get: vi.fn().mockResolvedValue({}) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await funnel(["--steps", "a,b", "--days", "7", "--window", "3600"]);

		const pathArg = vi.mocked(client.projectPath).mock.calls[0]?.[0] ?? "";
		expect(pathArg).toContain("days=7");
		expect(pathArg).toContain("window=3600");
	});

	it("exits with error when --steps is missing", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		await expect(funnel([])).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("--steps is required"));

		exitSpy.mockRestore();
	});

	it("shows help with --help", async () => {
		await funnel(["--help"]);
		expect(loggerModule.log).toHaveBeenCalledWith(
			expect.stringContaining("Usage: framedash funnel"),
		);
	});
});
