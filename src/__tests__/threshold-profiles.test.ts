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

	describe("create", () => {
		it("posts a threshold profile and outputs the result", async () => {
			const created = { id: "tp1", name: "Desktop QA" };
			const client = mockClient({ post: vi.fn().mockResolvedValue(created) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await thresholdProfiles([
				"create",
				"--name",
				"Desktop QA",
				"--fps-good",
				"60",
				"--fps-warn",
				"30",
				"--frame-time-good",
				"16",
				"--frame-time-warn",
				"33",
				"--memory-good",
				"512",
				"--memory-warn",
				"1024",
				"--gpu-time-good",
				"16",
				"--gpu-time-warn",
				"33",
				"--platform",
				"windows",
				"--resolution",
				"1920x1080",
				"--build-config",
				"shipping",
				"--gpu",
				"RTX 4090",
				"--storage",
				"NVMe",
			]);

			expect(client.post).toHaveBeenCalledWith("/api/v1/projects/test-project/threshold-profiles", {
				name: "Desktop QA",
				fpsGood: "60",
				fpsWarn: "30",
				frameTimeGood: "16",
				frameTimeWarn: "33",
				memoryGood: "512",
				memoryWarn: "1024",
				gpuTimeGood: "16",
				gpuTimeWarn: "33",
				platform: "windows",
				resolution: "1920x1080",
				buildConfig: "shipping",
				gpu: "RTX 4090",
				storage: "NVMe",
			});
			expect(loggerModule.success).toHaveBeenCalledWith("Threshold profile created");
			expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(created, null, 2));
		});

		it("requires name", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(thresholdProfiles(["create"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("--name is required");
			expect(exitSpy).toHaveBeenCalledWith(1);

			exitSpy.mockRestore();
		});
	});

	describe("delete", () => {
		it("sends DELETE for the specified threshold profile", async () => {
			const client = mockClient({ delete: vi.fn().mockResolvedValue(undefined) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await thresholdProfiles(["delete", "profile-to-remove"]);

			expect(client.projectPath).toHaveBeenCalledWith("threshold-profiles/profile-to-remove");
			expect(client.delete).toHaveBeenCalledWith(
				expect.stringContaining("threshold-profiles/profile-to-remove"),
			);
			expect(loggerModule.success).toHaveBeenCalledWith(
				"Threshold profile profile-to-remove deleted",
			);
		});

		it("exits with error when no profile ID provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(thresholdProfiles(["delete"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Threshold profile ID is required: framedash threshold-profiles delete <profile-id>",
			);
			expect(exitSpy).toHaveBeenCalledWith(1);

			exitSpy.mockRestore();
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

			await expect(thresholdProfiles(["unknown"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Unknown threshold-profiles subcommand: unknown",
			);

			exitSpy.mockRestore();
		});
	});
});
