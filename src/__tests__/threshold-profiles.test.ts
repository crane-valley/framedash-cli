import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { thresholdProfiles } from "../commands/threshold-profiles.js";

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

describe("threshold-profiles command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	describe("list", () => {
		it("calls GET on project threshold-profiles path and outputs result", async () => {
			const profileList = [
				{ id: "tp1", name: "Console 60fps" },
				{ id: "tp2", name: "Handheld 30fps" },
			];
			const client = mockClient({ get: vi.fn().mockResolvedValue(profileList) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await thresholdProfiles(["list"]);

			expect(client.projectPath).toHaveBeenCalledWith("threshold-profiles");
			expect(client.get).toHaveBeenCalledWith("/api/v1/projects/test-project/threshold-profiles");
			expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(profileList, null, 2));
		});

		it("outputs table format when requested", async () => {
			const profileList = [{ id: "tp1", name: "Console 60fps" }];
			const client = mockClient({ get: vi.fn().mockResolvedValue(profileList) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await thresholdProfiles(["list", "--format", "table"]);

			const output = vi.mocked(loggerModule.log).mock.calls[0]?.[0] ?? "";
			expect(output).toContain("id");
			expect(output).toContain("name");
			expect(output).toContain("tp1");
		});
	});

	describe("subcommand dispatch", () => {
		it("shows help when no subcommand given", async () => {
			await thresholdProfiles([]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash threshold-profiles <subcommand>"),
			);
		});

		it("exits with error on unknown subcommand", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(thresholdProfiles(["create"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Unknown threshold-profiles subcommand: create",
			);

			exitSpy.mockRestore();
		});
	});
});
