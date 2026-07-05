import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearTokenStore,
	credentialsFilePath,
	deleteStoredEntry,
	readStoredEntry,
	readTokenStore,
	type StoredTokenEntry,
	saveStoredEntry,
} from "./token-store.js";

const ORIGIN = "https://app.framedash.dev";

function entry(overrides: Partial<StoredTokenEntry> = {}): StoredTokenEntry {
	return {
		access_token: "fdat_local_test_access",
		refresh_token: "fdrt_local_test_refresh",
		expires_at: Date.now() + 3_600_000,
		scope: "analytics:read",
		...overrides,
	};
}

describe("token store", () => {
	let configHome: string;
	let previousXdg: string | undefined;

	beforeEach(() => {
		previousXdg = process.env.XDG_CONFIG_HOME;
		configHome = mkdtempSync(join(tmpdir(), "framedash-cli-store-"));
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

	it("honors XDG_CONFIG_HOME in the credentials path", () => {
		expect(credentialsFilePath()).toBe(join(configHome, "framedash", "credentials.json"));
	});

	it("round-trips an entry keyed by origin", async () => {
		const stored = entry();
		await saveStoredEntry(ORIGIN, stored);
		expect(readStoredEntry(ORIGIN)).toEqual(stored);
		expect(readStoredEntry("https://other.example")).toBeUndefined();
	});

	it("keeps entries for other origins when saving", async () => {
		await saveStoredEntry(ORIGIN, entry());
		await saveStoredEntry(
			"http://localhost:3000",
			entry({ scope: "analytics:read resources:write" }),
		);
		const store = readTokenStore();
		expect(Object.keys(store).sort()).toEqual(["http://localhost:3000", ORIGIN].sort());
	});

	it("returns an empty store for a missing file", () => {
		expect(readTokenStore()).toEqual({});
	});

	it("treats a corrupt file as absent instead of crashing", async () => {
		await saveStoredEntry(ORIGIN, entry());
		writeFileSync(credentialsFilePath(), "{not json!!", "utf8");
		expect(readTokenStore()).toEqual({});
		expect(readStoredEntry(ORIGIN)).toBeUndefined();
	});

	it("skips malformed entries but keeps valid ones", async () => {
		await saveStoredEntry(ORIGIN, entry());
		const raw = JSON.parse(readFileSync(credentialsFilePath(), "utf8"));
		raw["https://bad.example"] = { access_token: "", refresh_token: 42 };
		raw["https://worse.example"] = "nope";
		writeFileSync(credentialsFilePath(), JSON.stringify(raw), "utf8");
		const store = readTokenStore();
		expect(Object.keys(store)).toEqual([ORIGIN]);
	});

	it("leaves no temp files behind after a save (atomic rotate)", async () => {
		await saveStoredEntry(ORIGIN, entry());
		await saveStoredEntry(ORIGIN, entry({ refresh_token: "fdrt_local_test_rotated" }));
		const files = readdirSync(dirname(credentialsFilePath()));
		expect(files).toEqual(["credentials.json"]);
		expect(readStoredEntry(ORIGIN)?.refresh_token).toBe("fdrt_local_test_rotated");
	});

	it("restricts file permissions on POSIX", async () => {
		await saveStoredEntry(ORIGIN, entry());
		if (process.platform === "win32") return; // chmod is a documented no-op
		const mode = statSync(credentialsFilePath()).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("deletes a single origin entry", async () => {
		await saveStoredEntry(ORIGIN, entry());
		await saveStoredEntry("http://localhost:3000", entry());
		await expect(deleteStoredEntry(ORIGIN)).resolves.toBe(true);
		await expect(deleteStoredEntry(ORIGIN)).resolves.toBe(false);
		expect(readStoredEntry(ORIGIN)).toBeUndefined();
		expect(readStoredEntry("http://localhost:3000")).toBeDefined();
	});

	it("clears the whole store", async () => {
		await saveStoredEntry(ORIGIN, entry());
		await clearTokenStore();
		expect(readTokenStore()).toEqual({});
		// Idempotent on a missing file.
		await expect(clearTokenStore()).resolves.toBeUndefined();
	});

	it("every mutation reaps orphaned tmp files (single-origin logout included)", async () => {
		await saveStoredEntry(ORIGIN, entry());
		const orphan = `${credentialsFilePath()}.777.dead0000.tmp`;
		writeFileSync(orphan, "{}", "utf8");

		// A delete (the single-origin logout path) heals the orphan...
		await deleteStoredEntry(ORIGIN);
		expect(readdirSync(dirname(credentialsFilePath()))).toEqual(["credentials.json"]);

		// ...and so does a save.
		writeFileSync(orphan, "{}", "utf8");
		await saveStoredEntry(ORIGIN, entry());
		expect(readdirSync(dirname(credentialsFilePath()))).toEqual(["credentials.json"]);
	});

	it("a save still succeeds when an orphan tmp cannot be trivially removed", async () => {
		await saveStoredEntry(ORIGIN, entry());
		// A directory-shaped orphan (manual tampering / odd FS state) is the case
		// that used to throw from rmSync after the atomic rename already
		// committed, poisoning an otherwise-successful save.
		const orphanDir = `${credentialsFilePath()}.777.dead0000.tmp`;
		mkdirSync(orphanDir);
		writeFileSync(join(orphanDir, "leaked.json"), "{}", "utf8");

		await expect(
			saveStoredEntry(ORIGIN, entry({ refresh_token: "fdrt_local_test_rotated" })),
		).resolves.toBeUndefined();
		// The real write committed...
		expect(readStoredEntry(ORIGIN)?.refresh_token).toBe("fdrt_local_test_rotated");
		// ...and the dir-shaped orphan was reaped too.
		expect(readdirSync(dirname(credentialsFilePath()))).toEqual(["credentials.json"]);
	});

	it("clearTokenStore reaps orphaned credentials temp files", async () => {
		await saveStoredEntry(ORIGIN, entry());
		// Simulate a crashed write: an orphaned temp file with token material.
		const orphan = `${credentialsFilePath()}.12345.abcd1234.tmp`;
		writeFileSync(orphan, JSON.stringify({ leaked: true }), "utf8");
		// Unrelated files must survive.
		const unrelated = join(dirname(credentialsFilePath()), "other.txt");
		writeFileSync(unrelated, "keep me", "utf8");

		await clearTokenStore();

		const files = readdirSync(dirname(credentialsFilePath()));
		expect(files).toEqual(["other.txt"]);
	});

	it("never treats prototype-chain keys as stored entries", async () => {
		const stored = entry();
		await saveStoredEntry(ORIGIN, stored);
		// Object.prototype members must not masquerade as entries.
		expect(readStoredEntry("toString")).toBeUndefined();
		expect(readStoredEntry("hasOwnProperty")).toBeUndefined();
		expect(readStoredEntry("constructor")).toBeUndefined();
		// ...and must not report a successful delete (or trigger a rewrite).
		await expect(deleteStoredEntry("toString")).resolves.toBe(false);
		await expect(deleteStoredEntry("constructor")).resolves.toBe(false);
		expect(readStoredEntry(ORIGIN)).toEqual(stored);
	});
});
