import { readFileSync } from "node:fs";
import { assertSafeBaseUrl } from "@framedash/api-client";
import { error } from "./logger.js";

export type OutputFormat = "json" | "table" | "csv";

export type CliConfig = {
	apiKey: string;
	projectId: string;
	baseUrl: string;
	format: OutputFormat;
};

function resolveBaseAndFormat(values: Record<string, unknown>): {
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
	const flag = values["api-key"] as string | undefined;
	if (flag) return flag;

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
		return key;
	}

	return process.env.FRAMEDASH_API_KEY;
}

/** Resolve global CLI config from parsed flags and environment variables. */
export function resolveConfig(values: Record<string, unknown>): CliConfig {
	const apiKey = resolveApiKey(values);
	if (!apiKey) {
		error("--api-key, --api-key-file, or FRAMEDASH_API_KEY env is required");
		process.exit(1);
	}

	const projectId =
		(values["project-id"] as string | undefined) ?? process.env.FRAMEDASH_PROJECT_ID;
	if (!projectId) {
		error("--project-id or FRAMEDASH_PROJECT_ID env is required");
		process.exit(1);
	}

	const { baseUrl, format } = resolveBaseAndFormat(values);
	return { apiKey, projectId, baseUrl, format };
}

/** Resolve config for commands that don't require --project-id (e.g. auth). */
export function resolveConfigWithoutProject(
	values: Record<string, unknown>,
): Omit<CliConfig, "projectId"> {
	const apiKey = resolveApiKey(values);
	if (!apiKey) {
		error("--api-key, --api-key-file, or FRAMEDASH_API_KEY env is required");
		process.exit(1);
	}

	const { baseUrl, format } = resolveBaseAndFormat(values);
	return { apiKey, baseUrl, format };
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
