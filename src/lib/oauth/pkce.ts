import { createHash, randomBytes } from "node:crypto";

// PKCE (RFC 7636) + CSRF-state helpers for the `framedash login` flow.
// Pure node:crypto module (no I/O) so tests exercise it directly.

/**
 * Generate an RFC 7636 code_verifier: 48 random bytes -> 64 base64url chars
 * (within the required 43-128 range, alphabet [A-Za-z0-9-_] which is a subset
 * of the allowed unreserved characters).
 */
export function generateCodeVerifier(): string {
	return randomBytes(48).toString("base64url");
}

/** Compute the S256 code_challenge: base64url(sha256(verifier)), no padding. */
export function computeS256CodeChallenge(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * Generate the CSRF `state` parameter: 24 random bytes -> 32 base64url chars.
 * Compared byte-for-byte against the loopback callback; any mismatch aborts
 * the login without a token exchange.
 */
export function generateState(): string {
	return randomBytes(24).toString("base64url");
}
