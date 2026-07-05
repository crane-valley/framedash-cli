import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./token-endpoint.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./token-endpoint.js")>();
	return { ...actual, refreshTokenGrant: vi.fn() };
});

// Passthrough wrappers (real behavior by default) so individual tests can
// inject one-shot failures with mockRejectedValueOnce.
vi.mock("./token-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./token-store.js")>();
	return {
		...actual,
		saveStoredEntry: vi.fn(actual.saveStoredEntry),
		deleteStoredEntry: vi.fn(actual.deleteStoredEntry),
	};
});

import { OAuthLoginRequiredError, OAuthTokenManager } from "./manager.js";
import { OAuthTokenRequestError, refreshTokenGrant } from "./token-endpoint.js";
import { readStoredEntry, type StoredTokenEntry, saveStoredEntry } from "./token-store.js";

const BASE_URL = "https://app.framedash.dev";
const ORIGIN = "https://app.framedash.dev";

function entry(overrides: Partial<StoredTokenEntry> = {}): StoredTokenEntry {
	return {
		access_token: "fdat_local_current",
		refresh_token: "fdrt_local_current",
		expires_at: Date.now() + 3_600_000,
		scope: "analytics:read",
		...overrides,
	};
}

describe("OAuthTokenManager", () => {
	let configHome: string;
	let previousXdg: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		previousXdg = process.env.XDG_CONFIG_HOME;
		configHome = mkdtempSync(join(tmpdir(), "framedash-cli-manager-"));
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

	it("returns the stored token without refreshing when far from expiry", async () => {
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry());
		await expect(manager.getAccessToken()).resolves.toBe("fdat_local_current");
		expect(refreshTokenGrant).not.toHaveBeenCalled();
	});

	it("refreshes when the token expires within the 60s window and persists rotation", async () => {
		await saveStoredEntry(ORIGIN, entry({ expires_at: Date.now() + 30_000 }));
		vi.mocked(refreshTokenGrant).mockResolvedValue({
			access_token: "fdat_local_new",
			refresh_token: "fdrt_local_rotated",
			expires_in: 3600,
			scope: "analytics:read",
		});
		const manager = new OAuthTokenManager(
			BASE_URL,
			ORIGIN,
			entry({ expires_at: Date.now() + 30_000 }),
		);

		await expect(manager.getAccessToken()).resolves.toBe("fdat_local_new");

		expect(refreshTokenGrant).toHaveBeenCalledWith(BASE_URL, "fdrt_local_current");
		// The ROTATED refresh token must be on disk (the old one is dead server-side).
		expect(readStoredEntry(ORIGIN)?.refresh_token).toBe("fdrt_local_rotated");
	});

	it("refreshes an already-expired token", async () => {
		await saveStoredEntry(ORIGIN, entry({ expires_at: Date.now() - 1 }));
		vi.mocked(refreshTokenGrant).mockResolvedValue({
			access_token: "fdat_local_new",
			refresh_token: "fdrt_local_rotated",
			expires_in: 3600,
			scope: "analytics:read",
		});
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() - 1 }));
		await expect(manager.getAccessToken()).resolves.toBe("fdat_local_new");
	});

	it("forceRefresh refreshes even when the token looks unexpired", async () => {
		await saveStoredEntry(ORIGIN, entry());
		vi.mocked(refreshTokenGrant).mockResolvedValue({
			access_token: "fdat_local_new",
			refresh_token: "fdrt_local_rotated",
			expires_in: 3600,
			scope: "analytics:read",
		});
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry());
		await expect(manager.forceRefresh()).resolves.toBe("fdat_local_new");
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1);
	});

	it("clears the stored entry and demands re-login on invalid_grant (accepted concurrency semantics)", async () => {
		// invalid_grant covers revoked/expired grants AND the lock-free store's
		// accepted worst case: a concurrent same-origin refresh in another
		// process won the rotation race and reuse revocation killed the grant.
		// Either way the outcome is a clean re-login prompt -- no crash, no
		// retry loop.
		await saveStoredEntry(ORIGIN, entry());
		vi.mocked(refreshTokenGrant).mockRejectedValue(
			new OAuthTokenRequestError("invalid_grant", "revoked", 400),
		);
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		await expect(manager.getAccessToken()).rejects.toBeInstanceOf(OAuthLoginRequiredError);
		await expect(manager.forceRefresh()).rejects.toThrow(/framedash login/);
		expect(readStoredEntry(ORIGIN)).toBeUndefined();
	});

	it("keeps the stored entry on a transient refresh failure", async () => {
		await saveStoredEntry(ORIGIN, entry());
		vi.mocked(refreshTokenGrant).mockRejectedValue(new Error("fetch failed"));
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		await expect(manager.getAccessToken()).rejects.toThrow("fetch failed");
		expect(readStoredEntry(ORIGIN)).toBeDefined();
	});

	it("coalesces concurrent in-process refreshes into one request", async () => {
		await saveStoredEntry(ORIGIN, entry({ expires_at: Date.now() }));
		let resolveRefresh: (value: unknown) => void = () => {};
		vi.mocked(refreshTokenGrant).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRefresh = resolve as (value: unknown) => void;
				}),
		);
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		const first = manager.getAccessToken();
		const second = manager.getAccessToken();
		await vi.waitFor(() => expect(refreshTokenGrant).toHaveBeenCalledTimes(1));
		resolveRefresh({
			access_token: "fdat_local_new",
			refresh_token: "fdrt_local_rotated",
			expires_in: 3600,
			scope: "analytics:read",
		});

		await expect(first).resolves.toBe("fdat_local_new");
		await expect(second).resolves.toBe("fdat_local_new");
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1);
	});

	it("adopts credentials rotated by another process instead of presenting a stale refresh token", async () => {
		// Simulate: another process rotated and saved before our refresh ran.
		const rotated = entry({
			access_token: "fdat_local_other_process",
			refresh_token: "fdrt_local_other_process",
			expires_at: Date.now() + 3_600_000,
		});
		await saveStoredEntry(ORIGIN, rotated);
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		await expect(manager.getAccessToken()).resolves.toBe("fdat_local_other_process");
		expect(refreshTokenGrant).not.toHaveBeenCalled();
	});

	it("refreshes with the RELOADED refresh token when the rotated access token is also stale", async () => {
		await saveStoredEntry(
			ORIGIN,
			entry({
				access_token: "fdat_local_other_process",
				refresh_token: "fdrt_local_other_process",
				expires_at: Date.now() + 10_000, // inside the 60s skew window
			}),
		);
		vi.mocked(refreshTokenGrant).mockResolvedValue({
			access_token: "fdat_local_new",
			refresh_token: "fdrt_local_rotated",
			expires_in: 3600,
			scope: "analytics:read",
		});
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		await expect(manager.getAccessToken()).resolves.toBe("fdat_local_new");

		expect(refreshTokenGrant).toHaveBeenCalledWith(BASE_URL, "fdrt_local_other_process");
	});

	it("treats a missing stored entry as logged out (no request, no resave)", async () => {
		// The manager loaded credentials at startup, but a logout completed
		// before the refresh: the store no longer has the entry.
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		await expect(manager.getAccessToken()).rejects.toBeInstanceOf(OAuthLoginRequiredError);

		expect(refreshTokenGrant).not.toHaveBeenCalled();
		expect(readStoredEntry(ORIGIN)).toBeUndefined();
	});

	it("removes the stale entry when persisting a successful rotation fails", async () => {
		await saveStoredEntry(ORIGIN, entry({ expires_at: Date.now() }));
		vi.mocked(refreshTokenGrant).mockResolvedValue({
			access_token: "fdat_local_new",
			refresh_token: "fdrt_local_rotated",
			expires_in: 3600,
			scope: "analytics:read",
		});
		// The refresh succeeded (old refresh token consumed server-side) but
		// the local persist fails.
		vi.mocked(saveStoredEntry).mockRejectedValueOnce(new Error("ENOSPC: disk full"));
		const manager = new OAuthTokenManager(BASE_URL, ORIGIN, entry({ expires_at: Date.now() }));

		await expect(manager.getAccessToken()).rejects.toThrow(/disk full/);

		// The CONSUMED old refresh token must not remain on disk -- leaving it
		// would trip server-side reuse revocation on the next run.
		expect(readStoredEntry(ORIGIN)).toBeUndefined();
	});
});
