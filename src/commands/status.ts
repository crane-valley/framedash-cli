import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function status(args: string[]): Promise<void> {
	await runCommand(
		{ args, help: HELP, options: { fresh: { type: "boolean", default: false } } },
		async ({ client, config, values }) => {
			const suffix = values.fresh ? "status?fresh=1" : "status";
			const data = await client.get(client.projectPath(suffix));
			log(formatOutput(data, config.format));
		},
	);
}

const HELP = `Usage: framedash status [options]

Show project status and key metrics. kpis.fetchedAt is the Unix timestamp in
milliseconds when the analytics query ran; it may be older than this command.

Options:
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  --fresh                Bypass the status cache and query analytics now
  -h, --help             Show help`;
