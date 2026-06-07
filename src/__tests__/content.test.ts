import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@framedash/api-client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { content } from "../commands/content.js";

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

describe("content command", () => {
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

	describe("list", () => {
		it("calls GET /api/v1/content without filter", async () => {
			const entries = [{ id: "c1", contentType: "item", contentId: "sword" }];
			const client = mockClient({ get: vi.fn().mockResolvedValue(entries) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await content(["list"]);

			expect(client.get).toHaveBeenCalledWith("/api/v1/content");
			expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(entries, null, 2));
		});

		it("passes --type as query parameter", async () => {
			const client = mockClient({ get: vi.fn().mockResolvedValue([]) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await content(["list", "--type", "weapon"]);

			expect(client.get).toHaveBeenCalledWith(
				expect.stringContaining("/api/v1/content?type=weapon"),
			);
		});
	});

	describe("import", () => {
		it("reads JSON file and sends POST", async () => {
			const importData = [{ contentType: "item", contentId: "shield", data: {} }];
			const filePath = join(tmpdir(), `framedash-content-${Date.now()}.json`);
			tmpFiles.push(filePath);
			await writeFile(filePath, JSON.stringify(importData));

			const imported = { count: 1 };
			const client = mockClient({ post: vi.fn().mockResolvedValue(imported) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await content(["import", filePath]);

			expect(client.post).toHaveBeenCalledWith("/api/v1/content", {
				entries: importData,
			});
			expect(loggerModule.success).toHaveBeenCalledWith("Content imported");
		});

		it("passes object payload as-is (not wrapping in entries)", async () => {
			const importData = {
				entries: [{ contentType: "npc", contentId: "guard", data: {} }],
			};
			const filePath = join(tmpdir(), `framedash-content-obj-${Date.now()}.json`);
			tmpFiles.push(filePath);
			await writeFile(filePath, JSON.stringify(importData));

			const client = mockClient({ post: vi.fn().mockResolvedValue({}) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await content(["import", filePath]);

			expect(client.post).toHaveBeenCalledWith("/api/v1/content", importData);
		});

		it("exits with error when file path not provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(content(["import"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				expect.stringContaining("JSON file path is required"),
			);

			exitSpy.mockRestore();
		});

		it("exits with error when file does not exist", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(content(["import", "/nonexistent/data.json"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to read file"),
			);

			exitSpy.mockRestore();
		});

		it("exits with error on invalid JSON", async () => {
			const filePath = join(tmpdir(), `framedash-bad-json-${Date.now()}.json`);
			tmpFiles.push(filePath);
			await writeFile(filePath, "{ not valid json }");

			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(content(["import", filePath])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith("Invalid JSON file");

			exitSpy.mockRestore();
		});
	});

	describe("delete", () => {
		it("deletes by UUID positional argument", async () => {
			const client = mockClient({ delete: vi.fn().mockResolvedValue(undefined) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await content(["delete", "uuid-to-delete"]);

			expect(client.delete).toHaveBeenCalledWith(
				expect.stringContaining("/api/v1/content?id=uuid-to-delete"),
			);
			expect(loggerModule.success).toHaveBeenCalledWith("Content entry uuid-to-delete deleted");
		});

		it("deletes by --type and --content-id pair", async () => {
			const client = mockClient({ delete: vi.fn().mockResolvedValue(undefined) });
			vi.mocked(createClientModule.createClient).mockReturnValue(client);

			await content(["delete", "--type", "weapon", "--content-id", "sword-01"]);

			const deletePath = vi.mocked(client.delete).mock.calls[0]?.[0] ?? "";
			expect(deletePath).toContain("contentType=weapon");
			expect(deletePath).toContain("contentId=sword-01");
			expect(loggerModule.success).toHaveBeenCalledWith("Content entry deleted");
		});

		it("exits with error when only --type is provided without --content-id", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(content(["delete", "--type", "weapon"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Provide <uuid> or both --type and --content-id",
			);

			exitSpy.mockRestore();
		});

		it("exits with error when neither UUID nor type+content-id provided", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(content(["delete"])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Provide <uuid> or both --type and --content-id",
			);

			exitSpy.mockRestore();
		});

		it("exits with error when a UUID is combined with --type/--content-id", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			await expect(
				content(["delete", "uuid-to-delete", "--type", "weapon", "--content-id", "sword-01"]),
			).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(
				"Cannot combine <uuid> with --type/--content-id. Choose one mode.",
			);

			exitSpy.mockRestore();
		});
	});

	describe("subcommand dispatch", () => {
		it("shows help when no subcommand given", async () => {
			await content([]);
			expect(loggerModule.log).toHaveBeenCalledWith(
				expect.stringContaining("framedash content <subcommand>"),
			);
		});
	});
});
