import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLI_OAUTH_CLIENT_ID,
	exchangeAuthorizationCode,
	OAuthTokenRequestError,
	refreshTokenGrant,
	revokeToken,
	toStoredEntry,
} from "./token-endpoint.js";

const BASE_URL = "https://app.framedash.dev";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function okTokenBody() {
	return {
		access_token: "fdat_local_test_access",
		token_type: "Bearer",
		expires_in: 3600,
		refresh_token: "fdrt_local_test_refresh",
		scope: "analytics:read",
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("exchangeAuthorizationCode", () => {
	it("posts the RFC 6749 form fields with the first-party client_id", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okTokenBody()));
		vi.stubGlobal("fetch", fetchMock);

		const result = await exchangeAuthorizationCode(BASE_URL, {
			code: "fdac_test_code",
			codeVerifier: "a".repeat(43),
			redirectUri: "http://127.0.0.1:49152/callback",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://app.framedash.dev/api/oauth/token");
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(init.redirect).toBe("manual");
		const params = new URLSearchParams(init.body as string);
		expect(params.get("grant_type")).toBe("authorization_code");
		expect(params.get("code")).toBe("fdac_test_code");
		expect(params.get("redirect_uri")).toBe("http://127.0.0.1:49152/callback");
		expect(params.get("code_verifier")).toBe("a".repeat(43));
		expect(params.get("client_id")).toBe(CLI_OAUTH_CLIENT_ID);
		expect(result.access_token).toBe("fdat_local_test_access");
	});

	it("throws OAuthTokenRequestError with the server error code", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse(400, { error: "invalid_grant", error_description: "PKCE failed" }),
				),
		);
		await expect(
			exchangeAuthorizationCode(BASE_URL, {
				code: "fdac_x",
				codeVerifier: "a".repeat(43),
				redirectUri: "http://127.0.0.1:1/callback",
			}),
		).rejects.toMatchObject({
			name: "OAuthTokenRequestError",
			code: "invalid_grant",
			status: 400,
		});
	});

	it("throws a generic error on a non-JSON response without echoing the body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 })),
		);
		await expect(
			exchangeAuthorizationCode(BASE_URL, {
				code: "fdac_x",
				codeVerifier: "a".repeat(43),
				redirectUri: "http://127.0.0.1:1/callback",
			}),
		).rejects.toThrow(/non-JSON response \(HTTP 502\)/);
	});

	it("rejects a response missing the refresh token", async () => {
		const body = { ...okTokenBody(), refresh_token: "" };
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));
		await expect(
			exchangeAuthorizationCode(BASE_URL, {
				code: "fdac_x",
				codeVerifier: "a".repeat(43),
				redirectUri: "http://127.0.0.1:1/callback",
			}),
		).rejects.toThrow(/unexpected response shape/);
	});

	it("refuses an insecure base URL before any request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			exchangeAuthorizationCode("http://app.framedash.dev", {
				code: "fdac_x",
				codeVerifier: "a".repeat(43),
				redirectUri: "http://127.0.0.1:1/callback",
			}),
		).rejects.toThrow(/Insecure base URL/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("refreshTokenGrant", () => {
	it("posts grant_type=refresh_token with the token", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okTokenBody()));
		vi.stubGlobal("fetch", fetchMock);

		await refreshTokenGrant(BASE_URL, "fdrt_local_old");

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const params = new URLSearchParams(init.body as string);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("fdrt_local_old");
		expect(params.get("client_id")).toBe(CLI_OAUTH_CLIENT_ID);
	});

	it("surfaces invalid_grant as OAuthTokenRequestError", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse(400, { error: "invalid_grant", error_description: "revoked" }),
				),
		);
		await expect(refreshTokenGrant(BASE_URL, "fdrt_local_old")).rejects.toBeInstanceOf(
			OAuthTokenRequestError,
		);
	});
});

describe("revokeToken", () => {
	it("posts the token to the revocation endpoint", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await revokeToken(BASE_URL, "fdrt_local_test_refresh");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://app.framedash.dev/api/oauth/revoke");
		const params = new URLSearchParams(init.body as string);
		expect(params.get("token")).toBe("fdrt_local_test_refresh");
	});

	it("throws on a non-2xx status so callers can warn", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
		await expect(revokeToken(BASE_URL, "fdrt_x")).rejects.toThrow(/HTTP 429/);
	});
});

describe("toStoredEntry", () => {
	it("computes an absolute expires_at from expires_in", () => {
		const now = 1_750_000_000_000;
		const entry = toStoredEntry(
			{
				access_token: "fdat_a",
				refresh_token: "fdrt_r",
				expires_in: 3600,
				scope: "analytics:read",
			},
			now,
		);
		expect(entry).toEqual({
			access_token: "fdat_a",
			refresh_token: "fdrt_r",
			expires_at: now + 3_600_000,
			scope: "analytics:read",
		});
	});
});
