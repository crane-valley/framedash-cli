import { describe, expect, it } from "vitest";
import { computeS256CodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";

// RFC 7636 requires 43-128 chars of [A-Za-z0-9-._~]; base64url output is a
// strict subset of that alphabet.
const VERIFIER_RE = /^[A-Za-z0-9\-_]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

describe("generateCodeVerifier", () => {
	it("produces a valid RFC 7636 verifier of at least 43 chars", () => {
		const verifier = generateCodeVerifier();
		expect(verifier).toMatch(VERIFIER_RE);
		expect(verifier.length).toBeGreaterThanOrEqual(43);
	});

	it("produces unique values", () => {
		const seen = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
		expect(seen.size).toBe(50);
	});
});

describe("computeS256CodeChallenge", () => {
	it("matches the RFC 7636 appendix B known-answer vector", () => {
		// https://www.rfc-editor.org/rfc/rfc7636#appendix-B
		expect(computeS256CodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	it("emits 43 chars of unpadded base64url", () => {
		expect(computeS256CodeChallenge(generateCodeVerifier())).toMatch(CHALLENGE_RE);
	});

	it("is deterministic for the same verifier", () => {
		const verifier = generateCodeVerifier();
		expect(computeS256CodeChallenge(verifier)).toBe(computeS256CodeChallenge(verifier));
	});
});

describe("generateState", () => {
	it("produces unique url-safe values", () => {
		const seen = new Set(Array.from({ length: 50 }, () => generateState()));
		expect(seen.size).toBe(50);
		for (const state of seen) {
			expect(state).toMatch(/^[A-Za-z0-9\-_]{32}$/);
		}
	});
});
