import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { runCommand, withSubcommands } from "../lib/run-command.js";

const HELP = `Usage: framedash projects <subcommand> [options]

List the projects your credentials can read, including each project's id
(required by --project-id / FRAMEDASH_PROJECT_ID for most other commands).

Subcommands:
  list                   List projects

Run 'framedash projects <subcommand> --help' for more info.`;

export const projects = withSubcommands("projects", HELP, {
	list: projectsList,
});

async function projectsList(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash projects list [--format json|table|csv] [global options]",
			noProject: true,
		},
		async ({ client, config }) => {
			const data =
				await client.get<{ id: string; name: string; createdAt: string }[]>("/api/v1/projects");
			log(formatOutput(data, config.format));
		},
	);
}
