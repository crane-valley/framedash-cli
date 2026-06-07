import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maps } from "../commands/maps.js";

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

describe("maps command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "fd_test_key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	describe("list", () => {
		it("calls GET on project maps path and outputs result", async () => {
			const mapList = [
				{ id: "m1", name: "Level 1" },
				{ id: "m2", name: "Level 2" },
			];
			const client = mockClient({ get: vi.fn().mockResolvedValue(mapList) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await maps(["list"]);

			expect(client.projectPath).toHaveBeenCalledWith("maps");
			expect(client.get).toHaveBeenCalledWith("/api/v1/projects/test-project/maps");
			expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(mapList, null, 2));
		});

		it("outputs table format when requested", async () => {
			const mapList = [{ id: "m1", name: "Level 1" }];
			const client = mockClient({ get: vi.fn().mockResolvedValue(mapList) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await maps(["list", "--format", "table"]);

			const output = vi.mocked(loggerModule.log).mock.calls[0]?.[0] ?? "";
			expect(output).toContain("id");
			expect(output).toContain("name");
			expect(output).toContain("m1");
		});
	});

	describe("delete", () => {
		it("sends DELETE for the specified map", async () => {
			const client = mockClient({ delete: vi.fn().mockResolvedValue(undefined) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await maps(["delete", "map-to-remove"]);

			expect(client.projectPath).toHaveBeenCalledWith("maps/map-to-remove");
			expect(client.delete).toHaveBeenCalledWith(expect.stringContaining("maps/map-to-remove"));
			expect(loggerModule.success).toHaveBeenCalledWith("Map map-to-remove deleted");
		});

		it("URL-encodes the map ID", async () => {
			const client = mockClient({ delete: vi.fn().mockResolvedValue(undefined) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await maps(["delete", "map/with/slashes"]);

			expect(client.projectPath).toHaveBeenCalledWith("maps/map%2Fwith%2Fslashes");
			expect(client.delete).toHaveBeenCalledTimes(1);
		});

		it("exits with error when no map ID provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(maps(["delete"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Map ID is required: framedash maps delete <map-id>",
			);

			exitSpy.mockRestore();
		});
	});

	describe("subcommand dispatch", () => {
		it("shows help when no subcommand given", async () => {
			await maps([]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash maps <subcommand>"),
			);
		});

		it("exits with error on unknown subcommand", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(maps(["upload"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("Unknown maps subcommand: upload");

			exitSpy.mockRestore();
		});
	});
});
