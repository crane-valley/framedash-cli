import { assertSafeBaseUrl } from "@framedash/api-client";
import type { StoredTokenEntry } from "./token-store.js";

// HTTP client for the authorization server's token and revocation endpoints
// (RFC 6749 / RFC 7009). The CLI is the seeded first-party PUBLIC client
// (migration 0058): no client secret; possession of the PKCE verifier or the
// rotating refresh token is the proof.
//
// SECURITY: token values pass through here in memory only. Error paths must
// never include request parameters (which contain tokens) -- only the
// server's error code/description and the HTTP status.

/** Well-known client_id of the seeded first-party CLI client. */
export const CLI_OAUTH_CLIENT_ID = "fdc_framedash_cli";

/** Per-request timeout for token/revocation calls. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** Structured OAuth error (RFC 6749 section 5.2) from the token endpoint. */
export class OAuthTokenRequestError extends Error {
	constructor(
		/** Machine-readable error code, e.g. "invalid_grant". */
		public readonly code: string,
		description: string,
		public readonly status: number,
	) {
		super(`Token request failed (${code}): ${description}`);
		this.name = "OAuthTokenRequestError";
	}
}

export type TokenResponse = {
	access_token: string;
	refresh_token: string;
	/** Access token lifetime in seconds. */
	expires_in: number;
	/** Space-delimited granted scopes. */
	scope: string;
};

function endpointUrl(baseUrl: string, path: string): string {
	// Origin-rooted: the AS serves its endpoints at the app origin regardless
	// of any path on the configured base URL.
	assertSafeBaseUrl(baseUrl);
	return new URL(path, baseUrl).toString();
}

async function postForm(url: string, params: URLSearchParams): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: params.toString(),
		// Never follow a redirect: it would re-send the form body (which
		// contains token material) to the redirect target.
		redirect: "manual",
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
}

async function requestToken(baseUrl: string, params: URLSearchParams): Promise<TokenResponse> {
	params.set("client_id", CLI_OAUTH_CLIENT_ID);
	const response = await postForm(endpointUrl(baseUrl, "/api/oauth/token"), params);

	let json: unknown;
	try {
		json = JSON.parse(await response.text());
	} catch {
		throw new Error(`Token endpoint returned a non-JSON response (HTTP ${response.status})`);
	}
	const obj = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};

	if (!response.ok) {
		const code = typeof obj.error === "string" ? obj.error : "unknown_error";
		const description =
			typeof obj.error_description === "string" ? obj.error_description : `HTTP ${response.status}`;
		throw new OAuthTokenRequestError(code, description, response.status);
	}

	if (
		typeof obj.access_token !== "string" ||
		obj.access_token === "" ||
		typeof obj.refresh_token !== "string" ||
		obj.refresh_token === "" ||
		typeof obj.expires_in !== "number" ||
		!Number.isFinite(obj.expires_in)
	) {
		throw new Error("Token endpoint returned an unexpected response shape");
	}
	return {
		access_token: obj.access_token,
		refresh_token: obj.refresh_token,
		expires_in: obj.expires_in,
		scope: typeof obj.scope === "string" ? obj.scope : "",
	};
}

/** RFC 6749 section 4.1.3 authorization-code exchange with the PKCE verifier. */
export async function exchangeAuthorizationCode(
	baseUrl: string,
	options: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenResponse> {
	const params = new URLSearchParams({
		grant_type: "authorization_code",
		code: options.code,
		redirect_uri: options.redirectUri,
		code_verifier: options.codeVerifier,
	});
	return requestToken(baseUrl, params);
}

/** RFC 6749 section 6 refresh grant (the server rotates the refresh token). */
export async function refreshTokenGrant(
	baseUrl: string,
	refreshToken: string,
): Promise<TokenResponse> {
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	return requestToken(baseUrl, params);
}

/**
 * RFC 7009 revocation. Revoking the refresh token disconnects the whole
 * grant server-side. Throws on transport errors; callers treat revocation
 * as best effort (local credentials are removed regardless).
 */
export async function revokeToken(baseUrl: string, token: string): Promise<void> {
	const params = new URLSearchParams({ token, client_id: CLI_OAUTH_CLIENT_ID });
	const response = await postForm(endpointUrl(baseUrl, "/api/oauth/revoke"), params);
	if (!response.ok) {
		throw new Error(`Revocation endpoint returned HTTP ${response.status}`);
	}
}

/** Convert a token response into the persisted entry shape. */
export function toStoredEntry(response: TokenResponse, now = Date.now()): StoredTokenEntry {
	return {
		access_token: response.access_token,
		refresh_token: response.refresh_token,
		expires_at: now + response.expires_in * 1000,
		scope: response.scope,
	};
}
