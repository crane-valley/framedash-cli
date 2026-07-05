import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("../lib/oauth/loopback-server.js", () => ({
	startLoopbackServer: vi.fn(),
}));

vi.mock("../lib/oauth/token-endpoint.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/oauth/token-endpoint.js")>();
	return { ...actual, exchangeAuthorizationCode: vi.fn(), revokeToken: vi.fn() };
});

vi.mock("../lib/oauth/token-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/oauth/token-store.js")>();
	return { ...actual, saveStoredEntry: vi.fn() };
});

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../commands/login.js";
import * as loggerModule from "../lib/logger.js";
import { startLoopbackServer } from "../lib/oauth/loopback-server.js";
import { computeS256CodeChallenge } from "../lib/oauth/pkce.js";
import { exchangeAuthorizationCode, revokeToken } from "../lib/oauth/token-endpoint.js";
import { saveStoredEntry } from "../lib/oauth/token-store.js";

type FakeServer = {
	port: number;
	redirectUri: string;
	waitForCallback: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
};

function fakeServer(): FakeServer {
	return {
		port: 49152,
		redirectUri: "http://127.0.0.1:49152/callback",
		waitForCallback: vi.fn().mockResolvedValue({ code: "fdac_test_code" }),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

function fakeSpawnChild(): { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } {
	return { on: vi.fn(), unref: vi.fn() };
}

const TOKENS = {
	access_token: "fdat_test_access",
	refresh_token: "fdrt_test_refresh",
	expires_in: 3600,
	scope: "analytics:read",
};

describe("login command", () => {
	let configHome: string;
	let previousXdg: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FRAMEDASH_BASE_URL;
		vi.mocked(spawn).mockReturnValue(fakeSpawnChild() as never);
		vi.mocked(exchangeAuthorizationCode).mockResolvedValue(TOKENS);
		// Isolate the credential store path from the developer's real config dir.
		previousXdg = process.env.XDG_CONFIG_HOME;
		configHome = mkdtempSync(join(tmpdir(), "framedash-cli-login-"));
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

	function authorizeUrlFromLogs(): URL {
		const urlLine = vi
			.mocked(loggerModule.log)
			.mock.calls.map((call) => call[0])
			.find((line) => typeof line === "string" && line.includes("/oauth/authorize"));
		expect(urlLine).toBeDefined();
		return new URL((urlLine as string).trim());
	}

	it("builds a correct authorize URL and completes the code exchange", async () => {
		const server = fakeServer();
		vi.mocked(startLoopbackServer).mockResolvedValue(server as never);

		await login(["--no-browser"]);

		const url = authorizeUrlFromLogs();
		expect(url.origin).toBe("https://app.framedash.dev");
		expect(url.pathname).toBe("/oauth/authorize");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe("fdc_framedash_cli");
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49152/callback");
		expect(url.searchParams.get("scope")).toBe("analytics:read");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");

		// The state minted for the loopback server must be the one in the URL.
		const expectedState = vi.mocked(startLoopbackServer).mock.calls[0]?.[0];
		expect(url.searchParams.get("state")).toBe(expectedState);

		// The challenge in the URL must be S256(verifier sent to the exchange).
		const exchangeArgs = vi.mocked(exchangeAuthorizationCode).mock.calls[0];
		expect(exchangeArgs?.[0]).toBe("https://app.framedash.dev");
		const { code, codeVerifier, redirectUri } = exchangeArgs?.[1] as {
			code: string;
			codeVerifier: string;
			redirectUri: string;
		};
		expect(code).toBe("fdac_test_code");
		expect(redirectUri).toBe("http://127.0.0.1:49152/callback");
		expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
		expect(url.searchParams.get("code_challenge")).toBe(computeS256CodeChallenge(codeVerifier));

		// Tokens stored under the origin; server closed.
		expect(saveStoredEntry).toHaveBeenCalledWith(
			"https://app.framedash.dev",
			expect.objectContaining({
				access_token: "fdat_test_access",
				refresh_token: "fdrt_test_refresh",
				scope: "analytics:read",
			}),
		);
		expect(server.close).toHaveBeenCalled();
	});

	it("never prints token values", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);

		await login(["--no-browser"]);

		const allOutput = [
			...vi.mocked(loggerModule.log).mock.calls,
			...vi.mocked(loggerModule.success).mock.calls,
		]
			.map((call) => String(call[0]))
			.join("\n");
		expect(allOutput).not.toContain("fdat_test_access");
		expect(allOutput).not.toContain("fdrt_test_refresh");
	});

	it("does not spawn a browser with --no-browser but still prints the URL", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);

		await login(["--no-browser"]);

		expect(spawn).not.toHaveBeenCalled();
		expect(() => authorizeUrlFromLogs()).not.toThrow();
	});

	it("attempts a best-effort browser launch by default", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);

		await login([]);

		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("respects --base-url for the authorize URL, exchange, and storage key", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);

		await login(["--no-browser", "--base-url", "http://localhost:3000"]);

		expect(authorizeUrlFromLogs().origin).toBe("http://localhost:3000");
		expect(vi.mocked(exchangeAuthorizationCode).mock.calls[0]?.[0]).toBe("http://localhost:3000");
		expect(saveStoredEntry).toHaveBeenCalledWith("http://localhost:3000", expect.anything());
	});

	it("propagates a denied/errored callback without exchanging or storing", async () => {
		const server = fakeServer();
		server.waitForCallback.mockRejectedValue(
			new Error("Authorization was not granted (access_denied)"),
		);
		vi.mocked(startLoopbackServer).mockResolvedValue(server as never);

		await expect(login(["--no-browser"])).rejects.toThrow(/access_denied/);

		expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
		expect(saveStoredEntry).not.toHaveBeenCalled();
		expect(server.close).toHaveBeenCalled();
	});

	it("rejects malformed --scopes", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);
		try {
			await expect(login(["--no-browser", "--scopes", 'bad"scope'])).rejects.toThrow(
				"process.exit",
			);
			expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("--scopes"));
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("normalizes runs of mixed whitespace in --scopes", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);

		await login(["--no-browser", "--scopes", "  analytics:read \t\t resources:write  "]);

		expect(authorizeUrlFromLogs().searchParams.get("scope")).toBe("analytics:read resources:write");
	});

	it("rejects whitespace-only --scopes ([].every() must not slip through)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);
		try {
			await expect(login(["--no-browser", "--scopes", " \t "])).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("--scopes"));
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("propagates exchange failures unchanged, without saving", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);
		vi.mocked(exchangeAuthorizationCode).mockRejectedValue(new Error("fetch failed"));

		await expect(login(["--no-browser"])).rejects.toThrow("fetch failed");
		expect(saveStoredEntry).not.toHaveBeenCalled();
		expect(revokeToken).not.toHaveBeenCalled();
	});

	it("best-effort revokes the freshly issued tokens when the post-exchange save fails", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);
		// The exchange minted a LIVE grant, but persisting it fails: the CLI
		// must not discard the only refresh token that can disconnect it.
		vi.mocked(saveStoredEntry).mockRejectedValueOnce(new Error("ENOSPC: disk full"));

		await expect(login(["--no-browser"])).rejects.toThrow(/disk full/);

		expect(revokeToken).toHaveBeenCalledWith("https://app.framedash.dev", "fdrt_test_refresh");
	});

	it("still surfaces the save error when the cleanup revocation itself fails", async () => {
		vi.mocked(startLoopbackServer).mockResolvedValue(fakeServer() as never);
		vi.mocked(saveStoredEntry).mockRejectedValueOnce(new Error("ENOSPC: disk full"));
		vi.mocked(revokeToken).mockRejectedValueOnce(new Error("network down"));

		await expect(login(["--no-browser"])).rejects.toThrow(/disk full/);
	});

	it("shows help without starting a server", async () => {
		await login(["--help"]);
		expect(loggerModule.log).toHaveBeenCalledWith(expect.stringContaining("framedash login"));
		expect(startLoopbackServer).not.toHaveBeenCalled();
	});
});
