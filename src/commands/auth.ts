import { formatOutput } from "../lib/formatters.js";
import { log, success } from "../lib/logger.js";
import { runCommand } from "../lib/run-command.js";

export async function auth(args: string[]): Promise<void> {
	await runCommand({ args, help: HELP, noProject: true }, async ({ client, config }) => {
		const projects = await client.get<{ id: string; name: string }[]>("/api/v1/projects");
		success("API key is valid");
		log(formatOutput(projects, config.format));
	});
}

const HELP = `Usage: framedash auth [options]

Verify your API key and show the project bound to it.

Options:
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help`;
