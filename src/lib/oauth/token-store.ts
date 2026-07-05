import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Local OAuth credential store for `framedash login`.
//
// Layout: a single JSON file keyed by API base-URL ORIGIN:
//   { "<origin>": { access_token, refresh_token, expires_at, scope } }
// at $XDG_CONFIG_HOME/framedash/credentials.json, defaulting to
// ~/.config/framedash/credentials.json. Windows deliberately uses the same
// ~/.config path (documented in the CLI README) so one path rule covers every
// platform.
//
// CONCURRENCY MODEL: atomic-write, last-writer-wins. Every write goes to a
// temp file in the same directory and is renamed over the destination, so
// readers always see an internally consistent snapshot; there is NO
// cross-process locking. Two concurrent same-origin refreshes can therefore
// race rotation, whose worst case is the server's reuse revocation -- which
// surfaces as the ordinary invalid_grant "run framedash login again" path.
// That trade (a rare interactive re-login vs a hand-rolled lock subsystem)
// is deliberate; CI uses API keys and is unaffected.
//
// File/dir modes are 0700/0600 on POSIX; chmod is a silent no-op on Windows.
// A corrupt or unreadable store is treated as absent (never crashes the CLI).
// Token values must NEVER be logged; callers may print scope/expiry only.

export type StoredTokenEntry = {
	access_token: string;
	refresh_token: string;
	/** Absolute expiry of the access token, Unix epoch milliseconds. */
	expires_at: number;
	/** Space-delimited granted scopes (display + status output). */
	scope: string;
};

export type TokenStore = Record<string, StoredTokenEntry>;

/** Resolve the credentials file path (honors XDG_CONFIG_HOME at call time). */
export function credentialsFilePath(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const configHome = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
	return join(configHome, "framedash", "credentials.json");
}

function isStoredTokenEntry(value: unknown): value is StoredTokenEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.access_token === "string" &&
		entry.access_token !== "" &&
		typeof entry.refresh_token === "string" &&
		entry.refresh_token !== "" &&
		typeof entry.expires_at === "number" &&
		Number.isFinite(entry.expires_at) &&
		typeof entry.scope === "string"
	);
}

/**
 * Read the whole token store. Missing, unreadable, or corrupt files -- and
 * individual malformed entries -- degrade to "absent" rather than throwing:
 * the caller then falls back to other credential sources or asks the user to
 * log in again.
 */
export function readTokenStore(): TokenStore {
	let raw: string;
	try {
		raw = readFileSync(credentialsFilePath(), "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	const store: TokenStore = {};
	for (const [origin, entry] of Object.entries(parsed)) {
		if (isStoredTokenEntry(entry)) {
			store[origin] = entry;
		}
	}
	return store;
}

/** Read the stored entry for one base-URL origin, if any. */
export function readStoredEntry(origin: string): StoredTokenEntry | undefined {
	const store = readTokenStore();
	// Own-property guard: a prototype-chain key (e.g. "toString") must never
	// masquerade as a stored entry.
	return Object.hasOwn(store, origin) ? store[origin] : undefined;
}

/**
 * Reap orphaned credentials.json.*.tmp files left by crashed writes -- they
 * hold the same token material as the store itself. Called from every write
 * and from clearTokenStore, so any mutation heals a previous crash.
 */
function reapOrphanTmps(): void {
	const filePath = credentialsFilePath();
	const base = `${filePath}.`;
	let names: string[];
	try {
		names = readdirSync(dirname(filePath));
	} catch {
		return; // Config dir itself is gone: nothing to reap.
	}
	for (const name of names) {
		const full = join(dirname(filePath), name);
		if (full.startsWith(base) && full.endsWith(".tmp")) {
			// Best-effort: reaping runs AFTER the atomic rename has already
			// committed the real write, so a cleanup failure (locked file on
			// Windows, odd FS state) must never propagate and make a successful
			// saveStoredEntry look failed. recursive covers a dir-shaped orphan.
			try {
				rmSync(full, { force: true, recursive: true });
			} catch {
				// Leave the orphan; the next mutation will retry the reap.
			}
		}
	}
}

/**
 * Persist the whole store atomically: write a temp file in the target
 * directory, then rename over the destination (rename replaces existing
 * files on both POSIX and Windows), so readers always see a complete JSON
 * document. Concurrent writers are last-writer-wins by design (see the
 * concurrency model note above).
 */
function writeTokenStore(store: TokenStore): void {
	const filePath = credentialsFilePath();
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		// mkdirSync's mode only applies on creation; tighten a pre-existing
		// directory too so credentials.json never sits in a world-readable dir.
		// Best-effort no-op on Windows.
		chmodSync(dir, 0o700);
	} catch {
		// Best effort only.
	}
	const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmpPath, filePath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		throw err;
	}
	try {
		// Re-assert the mode in case the file pre-existed with wider permissions;
		// best-effort no-op on Windows.
		chmodSync(filePath, 0o600);
	} catch {
		// Best effort only.
	}
	reapOrphanTmps();
}

/**
 * Insert or replace the entry for an origin (atomic write). Async signature
 * kept for call-site stability even though the body is synchronous.
 */
export async function saveStoredEntry(origin: string, entry: StoredTokenEntry): Promise<void> {
	const store = readTokenStore();
	store[origin] = entry;
	writeTokenStore(store);
}

/** Remove the entry for an origin. Returns true if an entry was removed. */
export async function deleteStoredEntry(origin: string): Promise<boolean> {
	const store = readTokenStore();
	// Object.hasOwn (not `in`): prototype-chain keys are not stored entries
	// and must not trigger a rewrite.
	if (!Object.hasOwn(store, origin)) return false;
	delete store[origin];
	writeTokenStore(store);
	return true;
}

/**
 * Delete the whole credentials file (logout --all), including any orphaned
 * credentials.json.*.tmp files a crashed write left behind -- those hold the
 * same token material as the store itself.
 */
export async function clearTokenStore(): Promise<void> {
	// recursive so a credentials path that is unexpectedly a directory
	// (corruption / manual tampering) is still removed rather than throwing
	// and blocking logout --all from clearing on-disk token material.
	rmSync(credentialsFilePath(), { force: true, recursive: true });
	reapOrphanTmps();
}
