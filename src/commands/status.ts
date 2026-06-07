import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function status(args: string[]): Promise<void> {
	await runCommand({ args, help: HELP }, async ({ client, config }) => {
		const data = await client.get(client.projectPath("status"));
		log(formatOutput(data, config.format));
	});
}

const HELP = `Usage: framedash status [options]

Show project status and key metrics.

Options:
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help`;
