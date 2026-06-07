import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alerts } from "../commands/alerts.js";

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

describe("alerts command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	describe("list", () => {
		it("calls GET on project alerts path", async () => {
			const alertRules = [{ id: "a1", name: "High FPS Drop" }];
			const client = mockClient({ get: vi.fn().mockResolvedValue(alertRules) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await alerts(["list"]);

			expect(client.projectPath).toHaveBeenCalledWith("alerts");
			expect(client.get).toHaveBeenCalledWith("/api/v1/projects/test-project/alerts");
			expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(alertRules, null, 2));
		});
	});

	describe("create", () => {
		const requiredFlags = [
			"--name",
			"FPS Alert",
			"--map-id",
			"map-uuid-1",
			"--threshold-profile-id",
			"tp-uuid-1",
			"--metric",
			"fps",
			"--threshold-level",
			"warn",
			"--fail-percentage",
			"50",
			"--evaluation-days",
			"7",
			"--cell-size",
			"10",
			"--cooldown-minutes",
			"60",
		];

		it("sends POST with all required fields", async () => {
			const created = { id: "new-alert-id", name: "FPS Alert" };
			const client = mockClient({ post: vi.fn().mockResolvedValue(created) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await alerts(["create", ...requiredFlags]);

			expect(client.post).toHaveBeenCalledWith("/api/v1/projects/test-project/alerts", {
				name: "FPS Alert",
				mapId: "map-uuid-1",
				thresholdProfileId: "tp-uuid-1",
				metric: "fps",
				thresholdLevel: "warn",
				failPercentage: 50,
				evaluationDays: 7,
				cellSize: 10,
				cooldownMinutes: 60,
			});
			expect(loggerModule.success).toHaveBeenCalledWith("Alert rule created");
		});

		it("includes channel-ids when provided", async () => {
			const client = mockClient({ post: vi.fn().mockResolvedValue({}) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await alerts(["create", ...requiredFlags, "--channel-ids", "ch1,ch2,ch3"]);

			const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
			expect(body.channelIds).toEqual(["ch1", "ch2", "ch3"]);
		});

		it("exits with error on invalid numeric flag", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			const flags = [...requiredFlags];
			// Replace --evaluation-days value with non-numeric
			const idx = flags.indexOf("--evaluation-days");
			flags[idx + 1] = "abc";

			await expect(alerts(["create", ...flags])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"--evaluation-days must be a positive integer, got: abc",
			);

			exitSpy.mockRestore();
		});

		it("exits with error when required flag is missing", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			// Missing --name
			await expect(
				alerts(["create", "--map-id", "m1", "--threshold-profile-id", "tp1"]),
			).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("--name is required");

			exitSpy.mockRestore();
		});
	});

	describe("update", () => {
		it("sends PATCH with updated fields", async () => {
			const updated = { id: "alert-1", name: "Updated Alert" };
			const client = mockClient({ patch: vi.fn().mockResolvedValue(updated) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await alerts(["update", "alert-1", "--name", "Updated Alert", "--is-active", "false"]);

			expect(client.patch).toHaveBeenCalledWith(expect.stringContaining("alerts/alert-1"), {
				name: "Updated Alert",
				isActive: false,
			});
			expect(loggerModule.success).toHaveBeenCalledWith("Alert rule updated");
		});

		it("exits with error when no alert ID provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(alerts(["update", "--name", "Foo"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Alert ID is required: framedash alerts update <alert-id>",
			);

			exitSpy.mockRestore();
		});

		it("exits with error when no update fields provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(alerts(["update", "alert-1"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("At least one field to update is required");

			exitSpy.mockRestore();
		});

		it("rejects invalid --is-active value", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(alerts(["update", "alert-1", "--is-active", "maybe"])).rejects.toThrow(
				"process.exit",
			);
			expect(loggerModule.error).toHaveBeenCalledWith(
				expect.stringContaining('--is-active must be "true" or "false"'),
			);

			exitSpy.mockRestore();
		});
	});

	describe("delete", () => {
		it("sends DELETE for the specified alert", async () => {
			const client = mockClient({ delete: vi.fn().mockResolvedValue(undefined) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await alerts(["delete", "alert-to-remove"]);

			expect(client.delete).toHaveBeenCalledWith(expect.stringContaining("alerts/alert-to-remove"));
			expect(loggerModule.success).toHaveBeenCalledWith("Alert rule alert-to-remove deleted");
		});

		it("exits with error when no alert ID provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(alerts(["delete"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Alert ID is required: framedash alerts delete <alert-id>",
			);

			exitSpy.mockRestore();
		});
	});

	describe("subcommand dispatch", () => {
		it("shows help when no subcommand given", async () => {
			await alerts([]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash alerts <subcommand>"),
			);
		});

		it("shows help with --help", async () => {
			await alerts(["--help"]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash alerts <subcommand>"),
			);
		});

		it("exits with error on unknown subcommand", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(alerts(["bogus"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("Unknown alerts subcommand: bogus");

			exitSpy.mockRestore();
		});
	});
});
