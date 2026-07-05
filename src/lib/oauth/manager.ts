import { OAuthTokenRequestError, refreshTokenGrant, toStoredEntry } from "./token-endpoint.js";
import {
	deleteStoredEntry,
	readStoredEntry,
	type StoredTokenEntry,
	saveStoredEntry,
} from "./token-store.js";

// In-process lifecycle for one origin's stored OAuth credentials: hands out
// the access token, refreshes proactively near expiry (and on demand after a
// 401), and persists rotated refresh tokens atomically via the token store.
//
// Concurrency: refreshes are coalesced IN-PROCESS (one request per manager,
// and create-client shares one manager per origin). Across processes the
// store is last-writer-wins with no locking; a concurrent same-origin
// refresh can race rotation, whose worst case is the server's reuse
// revocation surfacing as the ordinary invalid_grant re-login path below.
// See token-store.ts for the full concurrency-model note.

/** Refresh when the access token expires within this window. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * The stored grant is dead (refresh returned invalid_grant: revoked, expired,
 * or rotated out from under us). The stored entry has already been cleared;
 * the only recovery is an interactive re-login, so callers must surface the
 * message and stop -- retrying cannot succeed.
 */
export class OAuthLoginRequiredError extends Error {
	constructor(origin: string) {
		super(
			`Your stored login for ${origin} has expired or been revoked. ` +
				`Run 'framedash login' to sign in again (CI should use FRAMEDASH_API_KEY instead).`,
		);
		this.name = "OAuthLoginRequiredError";
	}
}

export class OAuthTokenManager {
	private entry: StoredTokenEntry;
	private refreshPromise: Promise<string> | null = null;

	constructor(
		private readonly baseUrl: string,
		private readonly origin: string,
		entry: StoredTokenEntry,
	) {
		this.entry = entry;
	}

	/** Space-delimited granted scopes (safe to display). */
	get scope(): string {
		return this.entry.scope;
	}

	/** Access-token expiry, epoch ms (safe to display). */
	get expiresAt(): number {
		return this.entry.expires_at;
	}

	/**
	 * Current access token, refreshing first when it expires within 60s so an
	 * about-to-expire token is not sent only to bounce with a 401.
	 */
	async getAccessToken(): Promise<string> {
		if (this.entry.expires_at - Date.now() > EXPIRY_SKEW_MS) {
			return this.entry.access_token;
		}
		return this.refresh();
	}

	/** Force a refresh (after a 401 despite a locally-unexpired token). */
	async forceRefresh(): Promise<string> {
		return this.refresh();
	}

	/** Coalesce concurrent callers onto a single refresh request. */
	private refresh(): Promise<string> {
		if (this.refreshPromise === null) {
			this.refreshPromise = this.doRefresh().finally(() => {
				this.refreshPromise = null;
			});
		}
		return this.refreshPromise;
	}

	/**
	 * Refresh with the CURRENT stored token, then persist the rotated pair
	 * (atomic write, last-writer-wins).
	 */
	private async doRefresh(): Promise<string> {
		// Re-read first: another process may have rotated since this manager
		// loaded. Presenting an already-rotated token would trip the server's
		// reuse detection, so prefer the stored (current) credentials.
		const stored = readStoredEntry(this.origin);
		if (!stored) {
			// The entry is GONE: a logout (or an invalid_grant cleanup) completed
			// while we held stale in-memory credentials -- demand a re-login
			// rather than reviving a login the user terminated.
			throw new OAuthLoginRequiredError(this.origin);
		}
		if (stored.access_token !== this.entry.access_token) {
			this.entry = stored;
			if (stored.expires_at - Date.now() > EXPIRY_SKEW_MS) {
				// Another process's access token is still fresh: no refresh needed.
				return stored.access_token;
			}
			// Fall through and refresh with the reloaded (current) refresh token.
		}

		let entry: StoredTokenEntry;
		try {
			entry = toStoredEntry(await refreshTokenGrant(this.baseUrl, this.entry.refresh_token));
		} catch (err) {
			if (err instanceof OAuthTokenRequestError && err.code === "invalid_grant") {
				// Dead grant: revoked, expired, or a concurrent refresh in another
				// process won the rotation race (reuse revocation). Clear the local
				// entry and ask for a re-login -- the accepted worst case of the
				// lock-free store.
				await deleteStoredEntry(this.origin);
				throw new OAuthLoginRequiredError(this.origin);
			}
			// Transient failure (network, 5xx, rate limit): keep the stored entry
			// so a later attempt can retry.
			throw err;
		}
		// Persist BEFORE first use: rotation invalidated the old refresh token
		// server-side, so losing the new one would strand this login.
		try {
			await saveStoredEntry(this.origin, entry);
		} catch (err) {
			// The rotation could not be persisted, but the OLD refresh token on
			// disk is already consumed server-side: best-effort remove it so the
			// next run gets a clean re-login instead of reuse revocation.
			try {
				await deleteStoredEntry(this.origin);
			} catch {
				// Best effort: the same broken disk likely fails this too.
			}
			throw err;
		}
		this.entry = entry;
		return entry.access_token;
	}
}
