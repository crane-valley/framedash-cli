import { readFileSync } from "node:fs";
import { assertSafeBaseUrl } from "@framedash/api-client";
import { error } from "./logger.js";
import { readStoredEntry, type StoredTokenEntry } from "./oauth/token-store.js";

export type OutputFormat = "json" | "table" | "csv";

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

export function resolveBaseAndFormat(values: Record<string, unknown>): {
	baseUrl: string;
	format: OutputFormat;
} {
	const baseUrl =
		(values["base-url"] as string | undefined) ??
		nonBlankEnv("FRAMEDASH_BASE_URL") ??
		"https://app.framedash.dev";

	// The API key is sent on every request; refuse a base URL that would expose
	// it (http to a non-loopback host, or a poisoned --base-url / FRAMEDASH_BASE_URL).
	try {
		assertSafeBaseUrl(baseUrl);
	} catch (err) {
		error(err instanceof Error ? err.message : `Invalid base URL: ${baseUrl}`);
		process.exit(1);
	}

	const formatStr =
		(values.format as string | undefined) ?? nonBlankEnv("FRAMEDASH_FORMAT") ?? "json";
	if (formatStr !== "json" && formatStr !== "table" && formatStr !== "csv") {
		error(`Invalid format: ${formatStr}. Use json, table, or csv.`);
		process.exit(1);
	}

	return { baseUrl, format: formatStr };
}

// GitHub Actions expands an unset `vars.X` to an empty string, which must not override the default.
function nonBlankEnv(name: string): string | undefined {
	const value = process.env[name];
	return value?.trim() ? value : undefined;
}

/**
 * API-key files, stdin, and environment variables let callers keep credentials out of the
 * process argument list.
 */
export function resolveApiKey(values: Record<string, unknown>): string | undefined {
	return resolveApiKeyWithSource(values)?.apiKey;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

const API_KEY_SOURCE_LABEL: Record<ApiKeySource, string> = {
	flag: "--api-key",
	file: "--api-key-file",
	env: "FRAMEDASH_API_KEY",
};

export function resolveApiKeyWithSource(
	values: Record<string, unknown>,
): { apiKey: string; source: ApiKeySource } | undefined {
	const resolved = readApiKey(values);
	if (resolved && CONTROL_CHAR.test(resolved.apiKey)) {
		// undici's invalid-header error embeds the full key, and the top-level catch prints it.
		error(
			`API key from ${API_KEY_SOURCE_LABEL[resolved.source]} contains a control character (e.g. an embedded newline); check how the secret was stored`,
		);
		process.exit(1);
	}
	return resolved;
}

function readApiKey(
	values: Record<string, unknown>,
): { apiKey: string; source: ApiKeySource } | undefined {
	const flag = (values["api-key"] as string | undefined)?.trim();
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

	const envKey = process.env.FRAMEDASH_API_KEY?.trim();
	return envKey ? { apiKey: envKey, source: "env" } : undefined;
}

/**
 * NOTE: throws a TypeError (from `new URL`) when `baseUrl` is not a valid URL and no API key
 * short-circuits the lookup. Callers that accept raw user input for the base URL (map-capture)
 * must validate or catch accordingly; resolveConfig* callers are safe because
 * resolveBaseAndFormat has already vetted the URL.
 */
export function resolveCredential(
	values: Record<string, unknown>,
	baseUrl: string,
): CliCredential | undefined {
	const key = resolveApiKeyWithSource(values);
	if (key) return { kind: "api-key", ...key };

	const origin = new URL(baseUrl).origin;
	const entry = readStoredEntry(origin);
	if (entry && CONTROL_CHAR.test(entry.access_token)) {
		error(`Stored login for ${origin} has a malformed access token; run 'framedash login' again`);
		process.exit(1);
	}
	if (entry) return { kind: "oauth", origin, entry };

	return undefined;
}

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

export function parsePositiveInt(value: string, flagName: string): number {
	const num = Number(value);
	if (!Number.isInteger(num) || num <= 0) {
		error(`--${flagName} must be a positive integer, got: ${value}`);
		process.exit(1);
	}
	return num;
}

export function parseNumber(value: string, flagName: string): number {
	const num = Number(value);
	if (Number.isNaN(num)) {
		error(`--${flagName} must be a number, got: ${value}`);
		process.exit(1);
	}
	return num;
}

export const GLOBAL_OPTIONS = {
	"api-key": { type: "string" as const },
	"api-key-file": { type: "string" as const },
	"project-id": { type: "string" as const },
	"base-url": { type: "string" as const },
	format: { type: "string" as const },
	help: { type: "boolean" as const, short: "h" as const },
};
