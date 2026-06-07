import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function dashboard(args: string[]): Promise<void> {
	await runCommand(
		{ args, help: HELP, options: { days: { type: "string" } } },
		async ({ client, config, values }) => {
			const params = new URLSearchParams({ days: (values.days as string) ?? "30" });
			const data = await client.get(client.projectPath(`dashboard?${params}`));
			log(formatOutput(data, config.format));
		},
	);
}

const HELP = `Usage: framedash dashboard [options]

Show project dashboard metrics.

Options:
  --days <n>             Time period in days: 1, 7, 14, 30 (default: 30)
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help`;
