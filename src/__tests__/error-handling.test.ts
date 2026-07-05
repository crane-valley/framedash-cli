import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../commands/auth.js";
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

describe("error handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FRAMEDASH_API_KEY;
		delete process.env.FRAMEDASH_PROJECT_ID;
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	describe("missing credentials", () => {
		it("exits with an error mentioning framedash login when nothing is configured", async () => {
			// Point the OAuth token store at an empty location so the test can
			// never pick up a real stored login from the developer's machine.
			const previousXdg = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = `${process.cwd()}/definitely-missing-config-home`;
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			try {
				await expect(auth([])).rejects.toThrow("process.exit");
				expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("framedash login"));
			} finally {
				exitSpy.mockRestore();
				if (previousXdg === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = previousXdg;
				}
			}
		});
	});

	describe("missing project ID", () => {
		it("exits with error when project ID required but not set", async () => {
			process.env.FRAMEDASH_API_KEY = "fd_test_key";

			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(status([])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"--project-id or FRAMEDASH_PROJECT_ID env is required",
			);

			exitSpy.mockRestore();
		});
	});

	describe("invalid format", () => {
		it("exits with error on unsupported format value", async () => {
			process.env.FRAMEDASH_API_KEY = "fd_test_key";

			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(auth(["--format", "xml"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Invalid format: xml. Use json, table, or csv.",
			);

			exitSpy.mockRestore();
		});
	});

	describe("env var fallback", () => {
		it("uses FRAMEDASH_API_KEY env var when no --api-key flag", async () => {
			process.env.FRAMEDASH_API_KEY = "fd_from_env";
			const client: ApiClient = {
				get: vi.fn().mockResolvedValue([]),
				post: vi.fn(),
				patch: vi.fn(),
				delete: vi.fn(),
				projectPath: vi.fn(),
				currentProjectId: "",
				withProject: vi.fn(),
			} as unknown as ApiClient;
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await auth([]);

			expect(createClientModule.createClient).toHaveBeenCalledWith(
				"https://app.framedash.dev",
				{ kind: "api-key", apiKey: "fd_from_env", source: "env" },
				"",
			);
		});

		it("flag overrides env var", async () => {
			process.env.FRAMEDASH_API_KEY = "fd_from_env";
			const client: ApiClient = {
				get: vi.fn().mockResolvedValue([]),
				post: vi.fn(),
				patch: vi.fn(),
				delete: vi.fn(),
				projectPath: vi.fn(),
				currentProjectId: "",
				withProject: vi.fn(),
			} as unknown as ApiClient;
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await auth(["--api-key", "fd_from_flag"]);

			expect(createClientModule.createClient).toHaveBeenCalledWith(
				"https://app.framedash.dev",
				{ kind: "api-key", apiKey: "fd_from_flag", source: "flag" },
				"",
			);
		});

		it("uses FRAMEDASH_BASE_URL env var", async () => {
			process.env.FRAMEDASH_API_KEY = "fd_test_key";
			process.env.FRAMEDASH_BASE_URL = "https://staging.framedash.dev";
			const client: ApiClient = {
				get: vi.fn().mockResolvedValue([]),
				post: vi.fn(),
				patch: vi.fn(),
				delete: vi.fn(),
				projectPath: vi.fn(),
				currentProjectId: "",
				withProject: vi.fn(),
			} as unknown as ApiClient;
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await auth([]);

			expect(createClientModule.createClient).toHaveBeenCalledWith(
				"https://staging.framedash.dev",
				{ kind: "api-key", apiKey: "fd_test_key", source: "env" },
				"",
			);
		});

		it("uses FRAMEDASH_FORMAT env var", async () => {
			process.env.FRAMEDASH_API_KEY = "fd_test_key";
			process.env.FRAMEDASH_FORMAT = "csv";
			const data = [{ id: "p1", name: "Test" }];
			const client: ApiClient = {
				get: vi.fn().mockResolvedValue(data),
				post: vi.fn(),
				patch: vi.fn(),
				delete: vi.fn(),
				projectPath: vi.fn(),
				currentProjectId: "",
				withProject: vi.fn(),
			} as unknown as ApiClient;
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await auth([]);

			const output = vi.mocked(loggerModule.log).mock.calls[0]?.[0] ?? "";
			expect(output).toContain("id,name");
			expect(output).toContain("p1,Test");
		});
	});
});
