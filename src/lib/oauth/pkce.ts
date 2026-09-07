import { createHash, randomBytes } from "node:crypto";

// PKCE (RFC 7636) + CSRF-state helpers for the `framedash login` flow.
// Pure node:crypto module (no I/O) so tests exercise it directly.

export function generateCodeVerifier(): string {
	return randomBytes(48).toString("base64url");
}

export function computeS256CodeChallenge(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function generateState(): string {
	return randomBytes(24).toString("base64url");
}
