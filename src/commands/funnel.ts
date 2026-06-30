import { buildFunnelPath } from "@framedash/api-client";
import { formatOutput } from "../lib/formatters.js";
import { error, log } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function funnel(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: HELP,
			options: {
				steps: { type: "string" },
				days: { type: "string" },
				window: { type: "string" },
			},
		},
		async ({ client, config, values }) => {
			if (!values.steps) {
				error('--steps is required (comma-separated event names, e.g. "login,tutorial,purchase")');
				process.exit(1);
			}

			const data = await client.get(
				client.projectPath(
					buildFunnelPath({
						steps: values.steps as string,
						days: values.days as string | undefined,
						window: values.window as string | undefined,
					}),
				),
			);
			log(formatOutput(data, config.format));
		},
	);
}

const HELP = `Usage: framedash funnel [options]

Analyze event funnels.

Required:
  --steps <events>       Comma-separated event names (2-8 steps)

Options:
  --days <n>             Time period in days: 7, 14, 30, 90 (default: 30)
  --window <seconds>     Conversion window: 3600, 21600, 86400, 604800 (default: 86400)
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help`;
