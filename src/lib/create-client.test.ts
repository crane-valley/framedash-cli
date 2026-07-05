import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({ log: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() }));

import type { CliCredential } from "./config.js";
import { createClient, resetOAuthManagerCacheForTests } from "./create-client.js";
import * as loggerModule from "./logger.js";
import { readStoredEntry, saveStoredEntry } from "./oauth/token-store.js";

const BASE_URL = "https://app.framedash.dev";
const ORIGIN = "https://app.framedash.dev";

function oauthCredential(expiresInMs: number): Extract<CliCredential, { kind: "oauth" }> {
	return {
		kind: "oauth",
		origin: ORIGIN,
		entry: {
			access_token: "fdat_test_current",
			refresh_token: "fdrt_test_current",
			expires_at: Date.now() + expiresInMs,
			scope: "analytics:read",
		},
	};
}

function apiSuccess(data: unknown): Response {
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function apiError(status: number, title: string): Response {
	return new Response(JSON.stringify({ success: false, title, status }), {
		status,
		headers: { "Content-Type": "application/problem+json" },
	});
}

function tokenSuccess(): Response {
	return new Response(
		JSON.stringify({
			access_token: "fdat_test_refreshed",
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: "fdrt_test_rotated",
			scope: "analytics:read",
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function requestHeader(init: RequestInit | undefined, name: string): string | undefined {
	return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("createClient", () => {
	let configHome: string;
	let previousXdg: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		resetOAuthManagerCacheForTests();
		previousXdg = process.env.XDG_CONFIG_HOME;
		configHome = mkdtempSync(join(tmpdir(), "framedash-cli-client-"));
		process.env.XDG_CONFIG_HOME = configHome;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (previousXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdg;
		}
		rmSync(configHome, { recursive: true, force: true });
	});

	it("sends X-API-Key for an api-key credential", async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiSuccess([]));
		vi.stubGlobal("fetch", fetchMock);
		const client = createClient(
			BASE_URL,
			{
				kind: "api-key",
				apiKey: "fd_test_key",
				source: "env",
			},
			"proj-1",
		);

		await client.get("/api/v1/projects");

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(requestHeader(init, "X-API-Key")).toBe("fd_test_key");
		expect(requestHeader(init, "Authorization")).toBeUndefined();
	});

	it("sends the stored Bearer token for an unexpired OAuth credential", async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiSuccess([{ id: "p1" }]));
		vi.stubGlobal("fetch", fetchMock);
		const client = createClient(BASE_URL, oauthCredential(3_600_000), "proj-1");

		await expect(client.get("/api/v1/projects")).resolves.toEqual([{ id: "p1" }]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(requestHeader(init, "Authorization")).toBe("Bearer fdat_test_current");
		expect(requestHeader(init, "X-API-Key")).toBeUndefined();
	});

	it("proactively refreshes a token that expires within 60s and persists rotation", async () => {
		await saveStoredEntry(ORIGIN, oauthCredential(30_000).entry);
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			if (String(url).endsWith("/api/oauth/token")) return tokenSuccess();
			return apiSuccess([]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = createClient(BASE_URL, oauthCredential(30_000), "proj-1");

		await client.get("/api/v1/projects");

		const urls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(urls[0]).toBe("https://app.framedash.dev/api/oauth/token");
		const apiInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
		expect(requestHeader(apiInit, "Authorization")).toBe("Bearer fdat_test_refreshed");
		expect(readStoredEntry(ORIGIN)?.refresh_token).toBe("fdrt_test_rotated");
	});

	it("refreshes once and retries after a 401, then succeeds", async () => {
		const credential = oauthCredential(3_600_000);
		// The reload-under-lock treats a MISSING stored entry as logged out,
		// so the store must hold the login this manager started from.
		await saveStoredEntry(ORIGIN, credential.entry);
		let apiCalls = 0;
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			if (String(url).endsWith("/api/oauth/token")) return tokenSuccess();
			apiCalls++;
			return apiCalls === 1 ? apiError(401, "unauthorized") : apiSuccess([{ id: "p1" }]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = createClient(BASE_URL, credential, "proj-1");

		await expect(client.get("/api/v1/projects")).resolves.toEqual([{ id: "p1" }]);

		expect(apiCalls).toBe(2);
		const retryInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
		expect(requestHeader(retryInit, "Authorization")).toBe("Bearer fdat_test_refreshed");
	});

	it("exits with a re-login instruction when refresh returns invalid_grant, clearing the entry", async () => {
		await saveStoredEntry(ORIGIN, oauthCredential(0).entry);
		const fetchMock = vi.fn(async (url: string) => {
			if (String(url).endsWith("/api/oauth/token")) {
				return new Response(
					JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return apiSuccess([]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);
		try {
			const client = createClient(BASE_URL, oauthCredential(0), "proj-1");
			await expect(client.get("/api/v1/projects")).rejects.toThrow("process.exit");
			expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("framedash login"));
			expect(readStoredEntry(ORIGIN)).toBeUndefined();
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("throws instead of exiting for API errors in throwOnError mode", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiError(500, "boom")));
		const client = createClient(BASE_URL, oauthCredential(3_600_000), "proj-1", {
			throwOnError: true,
		});

		await expect(client.get("/api/v1/projects")).rejects.toMatchObject({ status: 500 });
	});

	it("withProject keeps the OAuth credential and changes only the project", async () => {
		const fetchMock = vi.fn().mockResolvedValue(apiSuccess([]));
		vi.stubGlobal("fetch", fetchMock);
		const client = createClient(BASE_URL, oauthCredential(3_600_000), "proj-1");

		const other = client.withProject("proj-2");
		await other.get("/api/v1/some-endpoint");

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(requestHeader(init, "Authorization")).toBe("Bearer fdat_test_current");
		expect(requestHeader(init, "X-Project-Id")).toBe("proj-2");
		expect(other.projectPath("maps")).toBe("/api/v1/projects/proj-2/maps");
	});

	it("shares ONE token manager across createClient calls for the same origin", async () => {
		// run-profile-test builds a second (throwOnError) client for its ingest
		// poll. With independent managers, the second refresh would present the
		// already-rotated refresh token and the server would revoke the grant;
		// a shared manager makes rotation state process-wide singular.
		const credential = oauthCredential(30_000); // inside the 60s skew window
		await saveStoredEntry(ORIGIN, credential.entry);
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			if (String(url).endsWith("/api/oauth/token")) return tokenSuccess();
			return apiSuccess([]);
		});
		vi.stubGlobal("fetch", fetchMock);

		const defaultClient = createClient(BASE_URL, credential, "proj-1");
		const pollClient = createClient(BASE_URL, credential, "proj-1", { throwOnError: true });

		await defaultClient.get("/api/v1/projects");
		await pollClient.get("/api/v1/projects");

		// Exactly ONE refresh across both clients; the poll client rides on the
		// shared manager's already-refreshed token.
		const tokenCalls = fetchMock.mock.calls.filter((call) =>
			String(call[0]).endsWith("/api/oauth/token"),
		);
		expect(tokenCalls).toHaveLength(1);
		const lastApiInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
		expect(requestHeader(lastApiInit, "Authorization")).toBe("Bearer fdat_test_refreshed");
	});
});
