import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { runCommand, withSubcommands } from "../lib/run-command.js";

const HELP = `Usage: framedash threshold-profiles <subcommand> [options]

List threshold profiles (performance budgets used by alert rules).

Subcommands:
  list                   List threshold profiles

Run 'framedash threshold-profiles <subcommand> --help' for more info.`;

export const thresholdProfiles = withSubcommands("threshold-profiles", HELP, {
	list: thresholdProfilesList,
});

async function thresholdProfilesList(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash threshold-profiles list [--format json|table|csv] [global options]",
		},
		async ({ client, config }) => {
			const data = await client.get(client.projectPath("threshold-profiles"));
			log(formatOutput(data, config.format));
		},
	);
}
