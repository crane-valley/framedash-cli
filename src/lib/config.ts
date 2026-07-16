import { readFileSync } from "node:fs";
import { assertSafeBaseUrl } from "@framedash/api-client";
import { error } from "./logger.js";
import { readStoredEntry, type StoredTokenEntry } from "./oauth/token-store.js";

export type OutputFormat = "json" | "table" | "csv";

/** Where an API key came from (drives `framedash auth` source display). */
export type ApiKeySource = "flag" | "file" | "env";

/**
 * The resolved credential for a run. Precedence: --api-key > --api-key-file >
 * FRAMEDASH_API_KEY env > OAuth tokens stored by `framedash login` for the
 * resolved base URL's origin. The OAuth variant carries the stored entry so
 * the client starts from it without re-reading the store; the token values
 * inside must never be logged.
 */
export type CliCredential =
	| { kind: "api-key"; apiKey: string; source: ApiKeySource }
	| { kind: "oauth"; origin: string; entry: StoredTokenEntry };

export type CliConfig = {
	credential: CliCredential;
	projectId: string;
	baseUrl: string;
	format: OutputFormat;
};

const NO_CREDENTIAL_MESSAGE =
	"No credentials found: pass --api-key/--api-key-file, set FRAMEDASH_API_KEY, " +
	"or run 'framedash login' (interactive). CI/non-interactive use should set FRAMEDASH_API_KEY. " +
	"Create a key on your project's API Keys page at https://app.framedash.dev. Docs: https://docs.framedash.dev.";

/** Resolve --base-url/--format (and env fallbacks) for commands that need no credential. */
export function resolveBaseAndFormat(values: Record<string, unknown>): {
	baseUrl: string;
	format: OutputFormat;
} {
	const baseUrl =
		(values["base-url"] as string | undefined) ??
		process.env.FRAMEDASH_BASE_URL ??
		"https://app.framedash.dev";

	// The API key is sent on every request; refuse a base URL that would expose
	// it (http to a non-loopback host, or a poisoned --base-url / FRAMEDASH_BASE_URL).
	try {
		assertSafeBaseUrl(baseUrl);
	} catch (err) {
		error(err instanceof Error ? err.message : `Invalid base URL: ${baseUrl}`);
		process.exit(1);
	}

	const formatStr = (values.format as string | undefined) ?? process.env.FRAMEDASH_FORMAT ?? "json";
	if (formatStr !== "json" && formatStr !== "table" && formatStr !== "csv") {
		error(`Invalid format: ${formatStr}. Use json, table, or csv.`);
		process.exit(1);
	}

	return { baseUrl, format: formatStr };
}

/**
 * Resolve the API key, preferring sources that keep it out of the process
 * argument list: --api-key flag, then --api-key-file (a path, or "-" for stdin),
 * then the FRAMEDASH_API_KEY env var. Returns undefined if none is set.
 */
export function resolveApiKey(values: Record<string, unknown>): string | undefined {
	return resolveApiKeyWithSource(values)?.apiKey;
}

/** As resolveApiKey, but also reports WHICH source supplied the key. */
export function resolveApiKeyWithSource(
	values: Record<string, unknown>,
): { apiKey: string; source: ApiKeySource } | undefined {
	const flag = values["api-key"] as string | undefined;
	if (flag) return { apiKey: flag, source: "flag" };

	const file = values["api-key-file"] as string | undefined;
	if (file) {
		const label = file === "-" ? "stdin" : file;
		// readFileSync(0) blocks forever on an interactive TTY; require piped input.
		if (file === "-" && process.stdin.isTTY) {
			error("Cannot read the API key from stdin: no piped input (stdin is a terminal)");
			process.exit(1);
		}
		let raw: string;
		try {
			// fd 0 reads piped stdin synchronously (e.g. `... | framedash --api-key-file -`).
			raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
		} catch (err) {
			error(
				`Failed to read --api-key-file (${label}): ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(1);
		}
		const key = raw.trim();
		if (!key) {
			error(`--api-key-file (${label}) is empty`);
			process.exit(1);
		}
		return { apiKey: key, source: "file" };
	}

	const envKey = process.env.FRAMEDASH_API_KEY;
	return envKey ? { apiKey: envKey, source: "env" } : undefined;
}

/**
 * Resolve the credential for the given base URL. API keys (flag > file > env)
 * win over a stored OAuth login; the OAuth token store is consulted only for
 * the resolved base URL's exact origin. Returns undefined when nothing is set.
 *
 * NOTE: throws a TypeError (from `new URL`) when `baseUrl` is not a valid
 * URL and no API key short-circuits the lookup. Callers that accept raw user
 * input for the base URL (map-capture) must validate or catch accordingly;
 * resolveConfig* callers are safe because resolveBaseAndFormat has already
 * vetted the URL.
 */
export function resolveCredential(
	values: Record<string, unknown>,
	baseUrl: string,
): CliCredential | undefined {
	const key = resolveApiKeyWithSource(values);
	if (key) return { kind: "api-key", ...key };

	const origin = new URL(baseUrl).origin;
	const entry = readStoredEntry(origin);
	if (entry) return { kind: "oauth", origin, entry };

	return undefined;
}

/** Resolve global CLI config from parsed flags and environment variables. */
export function resolveConfig(values: Record<string, unknown>): CliConfig {
	const { baseUrl, format } = resolveBaseAndFormat(values);
	const credential = resolveCredential(values, baseUrl);
	if (!credential) {
		error(NO_CREDENTIAL_MESSAGE);
		process.exit(1);
	}

	const projectId =
		(values["project-id"] as string | undefined) ?? process.env.FRAMEDASH_PROJECT_ID;
	if (!projectId) {
		error("--project-id or FRAMEDASH_PROJECT_ID env is required");
		process.exit(1);
	}

	return { credential, projectId, baseUrl, format };
}

/** Resolve config for commands that don't require --project-id (e.g. auth). */
export function resolveConfigWithoutProject(
	values: Record<string, unknown>,
): Omit<CliConfig, "projectId"> {
	const { baseUrl, format } = resolveBaseAndFormat(values);
	const credential = resolveCredential(values, baseUrl);
	if (!credential) {
		error(NO_CREDENTIAL_MESSAGE);
		process.exit(1);
	}

	return { credential, baseUrl, format };
}

/** Parse a string flag as a positive integer with a descriptive error. */
export function parsePositiveInt(value: string, flagName: string): number {
	const num = Number(value);
	if (!Number.isInteger(num) || num <= 0) {
		error(`--${flagName} must be a positive integer, got: ${value}`);
		process.exit(1);
	}
	return num;
}

/** Parse a string flag as a non-negative number with a descriptive error. */
export function parseNumber(value: string, flagName: string): number {
	const num = Number(value);
	if (Number.isNaN(num)) {
		error(`--${flagName} must be a number, got: ${value}`);
		process.exit(1);
	}
	return num;
}

/**
 * Global parseArgs option definitions shared by all commands.
 * Spread into each command's parseArgs call.
 */
export const GLOBAL_OPTIONS = {
	"api-key": { type: "string" as const },
	"api-key-file": { type: "string" as const },
	"project-id": { type: "string" as const },
	"base-url": { type: "string" as const },
	format: { type: "string" as const },
	help: { type: "boolean" as const, short: "h" as const },
};
