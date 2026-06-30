import { buildBuildsPath } from "@framedash/api-client";
import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function builds(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: HELP,
			options: {
				days: { type: "string" },
			},
		},
		async ({ client, config, values }) => {
			const data = await client.get(
				client.projectPath(buildBuildsPath({ days: values.days as string | undefined })),
			);
			log(formatOutput(data, config.format));
		},
	);
}

const HELP = `Usage: framedash builds [options]

List the builds seen for the project (newest first), so you can pick build IDs
to compare with 'framedash perf-diff'. A build is any non-empty build_id that
produced performance events in the window (set build_id from your CI, e.g. the
git SHA, when initializing the SDK).

Options:
  --days <n>             Time period in days: 7, 14, 30, 90 (default: 30)
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help`;
