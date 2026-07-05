import type { CliCredential } from "../lib/config.js";
import { formatOutput } from "../lib/formatters.js";
import { log, success } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

/**
 * Human-readable description of the active credential source. For a stored
 * OAuth login this shows scope and expiry ONLY -- never token material.
 */
function describeCredential(credential: CliCredential): string {
	if (credential.kind === "api-key") {
		switch (credential.source) {
			case "flag":
				return "API key from --api-key flag";
			case "file":
				return "API key from --api-key-file";
			case "env":
				return "API key from FRAMEDASH_API_KEY env";
		}
	}
	const expires = new Date(credential.entry.expires_at).toISOString();
	return `stored OAuth login for ${credential.origin} (framedash login; scopes: ${
		credential.entry.scope || "unknown"
	}; access token expires: ${expires})`;
}

export async function auth(args: string[]): Promise<void> {
	await runCommand({ args, help: HELP, noProject: true }, async ({ client, config }) => {
		const projects = await client.get<{ id: string; name: string }[]>("/api/v1/projects");
		success(config.credential.kind === "api-key" ? "API key is valid" : "OAuth login is valid");
		success(`Credential source: ${describeCredential(config.credential)}`);
		log(formatOutput(projects, config.format));
	});
}

const HELP = `Usage: framedash auth [options]

Verify your credentials and list the projects they can read. Also reports
which credential source is active: --api-key flag, --api-key-file,
FRAMEDASH_API_KEY env, or a stored OAuth login from 'framedash login'
(API keys always take precedence over a stored login).

Options:
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --api-key-file <path>  Read the API key from a file ('-' for stdin)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help`;
