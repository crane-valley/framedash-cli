import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../lib/oauth/token-endpoint.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/oauth/token-endpoint.js")>();
	return { ...actual, revokeToken: vi.fn() };
});

vi.mock("../lib/oauth/token-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/oauth/token-store.js")>();
	return {
		...actual,
		readTokenStore: vi.fn(),
		readStoredEntry: vi.fn(),
		deleteStoredEntry: vi.fn(),
		clearTokenStore: vi.fn(),
	};
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logout } from "../commands/logout.js";
import * as loggerModule from "../lib/logger.js";
import { revokeToken } from "../lib/oauth/token-endpoint.js";
import {
	clearTokenStore,
	credentialsFilePath,
	deleteStoredEntry,
	readStoredEntry,
	readTokenStore,
	type StoredTokenEntry,
} from "../lib/oauth/token-store.js";

const ORIGIN = "https://app.framedash.dev";

function entry(refreshToken: string): StoredTokenEntry {
	return {
		access_token: "fdat_test_access",
		refresh_token: refreshToken,
		expires_at: Date.now() + 3_600_000,
		scope: "analytics:read",
	};
}

describe("logout command", () => {
	let configHome: string;
	let previousXdg: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FRAMEDASH_BASE_URL;
		vi.mocked(revokeToken).mockResolvedValue(undefined);
		// Point the (real) credentialsFilePath at an isolated temp dir so the
		// existsSync check never sees a real login on the dev machine.
		previousXdg = process.env.XDG_CONFIG_HOME;
		configHome = mkdtempSync(join(tmpdir(), "framedash-cli-logout-"));
		process.env.XDG_CONFIG_HOME = configHome;
	});

	afterEach(() => {
		if (previousXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdg;
		}
		rmSync(configHome, { recursive: true, force: true });
	});

	it("revokes the refresh token server-side and removes the local entry", async () => {
		vi.mocked(readStoredEntry).mockReturnValue(entry("fdrt_test_refresh"));

		await logout([]);

		expect(revokeToken).toHaveBeenCalledWith(ORIGIN, "fdrt_test_refresh");
		expect(deleteStoredEntry).toHaveBeenCalledWith(ORIGIN);
		expect(loggerModule.success).toHaveBeenCalledWith(expect.stringContaining(ORIGIN));
	});

	it("still clears local credentials when revocation fails, with a warning", async () => {
		vi.mocked(readStoredEntry).mockReturnValue(entry("fdrt_test_refresh"));
		vi.mocked(revokeToken).mockRejectedValue(new Error("fetch failed"));

		await logout([]);

		expect(loggerModule.warn).toHaveBeenCalledWith(expect.stringContaining("fetch failed"));
		expect(deleteStoredEntry).toHaveBeenCalledWith(ORIGIN);
	});

	it("does nothing (and does not call revoke) when no login is stored", async () => {
		vi.mocked(readStoredEntry).mockReturnValue(undefined);

		await logout([]);

		expect(revokeToken).not.toHaveBeenCalled();
		expect(deleteStoredEntry).not.toHaveBeenCalled();
		expect(loggerModule.log).toHaveBeenCalledWith(expect.stringContaining("No stored login"));
	});

	it("uses the --base-url origin for the store lookup", async () => {
		vi.mocked(readStoredEntry).mockReturnValue(undefined);

		await logout(["--base-url", "http://localhost:3000"]);

		expect(readStoredEntry).toHaveBeenCalledWith("http://localhost:3000");
	});

	it("--all revokes every stored origin and clears the file", async () => {
		vi.mocked(readTokenStore).mockReturnValue({
			[ORIGIN]: entry("fdrt_prod"),
			"http://localhost:3000": entry("fdrt_local"),
		});

		await logout(["--all"]);

		expect(revokeToken).toHaveBeenCalledWith(ORIGIN, "fdrt_prod");
		expect(revokeToken).toHaveBeenCalledWith("http://localhost:3000", "fdrt_local");
		expect(clearTokenStore).toHaveBeenCalled();
		expect(loggerModule.success).toHaveBeenCalledWith(expect.stringContaining("2 origin(s)"));
	});

	it("--all with no credentials file still runs the clear (tmp-orphan reap), then reports", async () => {
		vi.mocked(readTokenStore).mockReturnValue({});

		await logout(["--all"]);

		expect(revokeToken).not.toHaveBeenCalled();
		// Even with no store file, a crashed first save can leave a
		// credentials.json.*.tmp orphan behind: clearTokenStore reaps those.
		expect(clearTokenStore).toHaveBeenCalled();
		expect(loggerModule.log).toHaveBeenCalledWith(expect.stringContaining("No stored logins"));
	});

	it("--all deletes an unparseable credentials file (revocation skipped)", async () => {
		// A corrupt file parses to zero usable origins but still holds token
		// material on disk; logout --all must remove it anyway.
		vi.mocked(readTokenStore).mockReturnValue({});
		mkdirSync(dirname(credentialsFilePath()), { recursive: true });
		writeFileSync(credentialsFilePath(), "{corrupt!!", "utf8");

		await logout(["--all"]);

		expect(revokeToken).not.toHaveBeenCalled();
		expect(clearTokenStore).toHaveBeenCalled();
		expect(loggerModule.success).toHaveBeenCalledWith(
			expect.stringContaining("no parseable logins"),
		);
	});

	it("shows help", async () => {
		await logout(["--help"]);
		expect(loggerModule.log).toHaveBeenCalledWith(expect.stringContaining("framedash logout"));
		expect(readStoredEntry).not.toHaveBeenCalled();
	});
});
