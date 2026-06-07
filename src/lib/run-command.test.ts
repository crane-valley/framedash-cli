import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as createClientModule from "./create-client.js";
import * as loggerModule from "./logger.js";
import { runCommand, withSubcommands } from "./run-command.js";

vi.mock("./logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
}));

vi.mock("./create-client.js", () => ({
	createClient: vi.fn(
		() =>
			({
				get: vi.fn(),
				post: vi.fn(),
				patch: vi.fn(),
				delete: vi.fn(),
				projectPath: vi.fn((s: string) => `/api/v1/projects/test-project/${s}`),
			}) as unknown as ApiClient,
	),
}));

describe("runCommand", () => {
	const handler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FRAMEDASH_API_KEY = "test-key";
		process.env.FRAMEDASH_PROJECT_ID = "test-project";
		delete process.env.FRAMEDASH_BASE_URL;
		delete process.env.FRAMEDASH_FORMAT;
	});

	it("prints help and skips handler when --help is passed", async () => {
		await runCommand({ args: ["--help"], help: "Test help text" }, handler);

		expect(handler).not.toHaveBeenCalled();
		expect(loggerModule.log).toHaveBeenCalledWith("Test help text");
	});

	it("prints help and skips handler when -h is passed", async () => {
		await runCommand({ args: ["-h"], help: "Short help" }, handler);

		expect(handler).not.toHaveBeenCalled();
		expect(loggerModule.log).toHaveBeenCalledWith("Short help");
	});

	it("passes config, client, values, and positionals to handler", async () => {
		await runCommand({ args: [], help: "help" }, handler);

		expect(handler).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: test asserts call count above
		const ctx = handler.mock.calls[0]![0];
		expect(ctx.config).toEqual({
			apiKey: "test-key",
			projectId: "test-project",
			baseUrl: "https://app.framedash.dev",
			format: "json",
		});
		expect(ctx.client).toBeDefined();
		expect(ctx.positionals).toEqual([]);
	});

	it("supports custom options and positionals", async () => {
		await runCommand(
			{
				args: ["--days", "7", "positional-arg"],
				help: "help",
				options: { days: { type: "string" } },
				allowPositionals: true,
			},
			handler,
		);

		// biome-ignore lint/style/noNonNullAssertion: test asserts call count above
		const ctx = handler.mock.calls[0]![0];
		expect(ctx.values.days).toBe("7");
		expect(ctx.positionals).toEqual(["positional-arg"]);
	});

	it("passes --format flag through to config", async () => {
		await runCommand({ args: ["--format", "table"], help: "help" }, handler);

		// biome-ignore lint/style/noNonNullAssertion: test asserts call count above
		const ctx = handler.mock.calls[0]![0];
		expect(ctx.config.format).toBe("table");
	});

	it("works in noProject mode", async () => {
		delete process.env.FRAMEDASH_PROJECT_ID;

		await runCommand({ args: [], help: "help", noProject: true }, handler);

		expect(handler).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: test asserts call count above
		const ctx = handler.mock.calls[0]![0];
		expect(ctx.config.apiKey).toBe("test-key");
		expect(ctx.config.projectId).toBe("");
		expect(createClientModule.createClient).toHaveBeenCalledWith(
			"https://app.framedash.dev",
			"test-key",
			"",
		);
	});
});

describe("withSubcommands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows help when no args provided", async () => {
		const cmd = withSubcommands("test", "Test help", { list: vi.fn() });
		await cmd([]);

		expect(loggerModule.log).toHaveBeenCalledWith("Test help");
	});

	it("shows help when --help is provided", async () => {
		const cmd = withSubcommands("test", "Test help", { list: vi.fn() });
		await cmd(["--help"]);

		expect(loggerModule.log).toHaveBeenCalledWith("Test help");
	});

	it("shows help when -h is provided", async () => {
		const cmd = withSubcommands("test", "Test help", { list: vi.fn() });
		await cmd(["-h"]);

		expect(loggerModule.log).toHaveBeenCalledWith("Test help");
	});

	it("dispatches to correct handler with remaining args", async () => {
		const listHandler = vi.fn();
		const createHandler = vi.fn();
		const cmd = withSubcommands("test", "help", {
			list: listHandler,
			create: createHandler,
		});

		await cmd(["list", "--format", "json"]);

		expect(listHandler).toHaveBeenCalledWith(["--format", "json"]);
		expect(createHandler).not.toHaveBeenCalled();
	});

	it("exits with error on unknown subcommand", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as never);

		const cmd = withSubcommands("alerts", "Help text", { list: vi.fn() });
		await expect(cmd(["bogus"])).rejects.toThrow("process.exit called");

		expect(loggerModule.error).toHaveBeenCalledWith("Unknown alerts subcommand: bogus");
		expect(loggerModule.log).toHaveBeenCalledWith("Help text");

		exitSpy.mockRestore();
	});
});
