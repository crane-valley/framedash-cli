import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { GLOBAL_OPTIONS, resolveBaseAndFormat } from "../lib/config.js";
import { log, success, warn } from "../lib/logger.js";
import { revokeToken } from "../lib/oauth/token-endpoint.js";
import {
	clearTokenStore,
	credentialsFilePath,
	deleteStoredEntry,
	readStoredEntry,
	readTokenStore,
} from "../lib/oauth/token-store.js";

const HELP = `Usage: framedash logout [options]

Sign out of a stored OAuth login (created by 'framedash login'): revokes the
session server-side (best effort) and removes the locally stored tokens for
the resolved base URL. API keys (FRAMEDASH_API_KEY etc.) are not affected.

Options:
  --all                  Revoke and remove ALL stored logins for every origin
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  -h, --help             Show help`;

/**
 * Best-effort server-side revocation of the refresh token (RFC 7009 kills
 * the whole grant). A transport failure only warns: the local credentials
 * are removed regardless, and an unreachable server must not block logout.
 */
async function bestEffortRevoke(origin: string, refreshToken: string): Promise<void> {
	try {
		await revokeToken(origin, refreshToken);
	} catch (err) {
		warn(
			`Could not revoke the server-side session for ${origin} ` +
				`(${err instanceof Error ? err.message : String(err)}); removing local credentials anyway. ` +
				`You can also revoke it from the dashboard's Connected apps page.`,
		);
	}
}

export async function logout(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: { ...GLOBAL_OPTIONS, all: { type: "boolean" } },
		allowPositionals: false,
	});

	if (values.help) {
		log(HELP);
		return;
	}

	if (values.all) {
		const store = readTokenStore();
		const origins = Object.keys(store);
		const hadFile = existsSync(credentialsFilePath());
		for (const origin of origins) {
			const entry = store[origin];
			if (entry) {
				await bestEffortRevoke(origin, entry.refresh_token);
			}
		}
		// Always clear: this removes the file (including the corrupt/unparseable
		// case, which still holds token material) AND reaps any orphaned
		// credentials.json.*.tmp files from crashed writes.
		await clearTokenStore();
		if (origins.length > 0) {
			success(`Logged out of ${origins.length} origin(s); credentials file removed.`);
		} else if (hadFile) {
			success(
				"Removed the local credentials file (it contained no parseable logins; " +
					"server-side revocation was skipped).",
			);
		} else {
			log("No stored logins.");
		}
		return;
	}

	const { baseUrl } = resolveBaseAndFormat(values as Record<string, unknown>);
	const origin = new URL(baseUrl).origin;
	const entry = readStoredEntry(origin);
	if (!entry) {
		log(`No stored login for ${origin}.`);
		return;
	}
	await bestEffortRevoke(origin, entry.refresh_token);
	await deleteStoredEntry(origin);
	success(`Logged out of ${origin}`);
}
