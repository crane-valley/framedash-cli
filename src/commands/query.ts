import { readFile } from "node:fs/promises";
import { parsePositiveInt } from "../lib/config.js";
import { formatOutput } from "../lib/formatters.js";
import { error, log } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function query(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: HELP,
			options: {
				limit: { type: "string" },
				file: { type: "string", short: "f" },
			},
			allowPositionals: true,
		},
		async ({ client, config, values, positionals }) => {
			// The raw-query endpoint requires the data:admin scope, which OAuth
			// grants can never carry (OAUTH_ALLOWED_SCOPES is deliberately limited
			// to analytics:read + resources:write). Falling back to a stored login
			// would always 403, so fail early with the actionable fix instead.
			if (config.credential.kind === "oauth") {
				error(
					"framedash query requires an API key with the data:admin scope. OAuth login " +
						"cannot grant data:admin; set FRAMEDASH_API_KEY or use --api-key / --api-key-file.",
				);
				process.exit(1);
			}

			if (values.file && positionals.length > 0) {
				error("Cannot use both --file and a positional SQL argument. Provide one or the other.");
				process.exit(1);
			}

			let sql: string;
			if (values.file) {
				try {
					sql = await readFile(values.file as string, "utf-8");
				} catch (err) {
					const msg = err instanceof Error ? err.message : "unknown error";
					error(`Failed to read SQL file: ${values.file} (${msg})`);
					process.exit(1);
				}
			} else if (positionals.length > 0) {
				sql = positionals.join(" ");
			} else {
				error("SQL query is required. Provide as argument or use --file.");
				process.exit(1);
			}

			const body: Record<string, unknown> = {
				sql,
				project_id: config.projectId,
			};
			if (values.limit) {
				body.limit = parsePositiveInt(values.limit as string, "limit");
			}

			const data = await client.post("/api/v1/query", body);
			log(formatOutput(data, config.format));
		},
	);
}

const HELP = `Usage: framedash query <sql> [options]
       framedash query --file query.sql [options]

Execute a read-only ClickHouse query.

Requires an API key with the data:admin scope ('framedash login' OAuth
tokens cannot be used: data:admin is not grantable via OAuth).

Arguments:
  <sql>                  SQL query string

Options:
  -f, --file <path>      Read SQL from file
  --limit <n>            Max rows (default: 1000)
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help

Examples:
  framedash query "SELECT count() FROM events"
  framedash query "SELECT event_name, count() FROM events GROUP BY event_name" --format table
  framedash query --file complex-query.sql --limit 100`;
