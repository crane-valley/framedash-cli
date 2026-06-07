import { formatOutput } from "../lib/formatters.js";
import { error, log, success } from "../lib/logger.js";
import { runCommand, withSubcommands } from "../lib/run-command.js";

const HELP = `Usage: framedash maps <subcommand> [options]

Manage maps.

Subcommands:
  list                   List maps
  delete <map-id>        Delete a map

Run 'framedash maps <subcommand> --help' for more info.`;

export const maps = withSubcommands("maps", HELP, {
	list: mapsList,
	delete: mapsDelete,
});

async function mapsList(args: string[]): Promise<void> {
	await runCommand(
		{ args, help: "Usage: framedash maps list [--format json|table|csv] [global options]" },
		async ({ client, config }) => {
			const data = await client.get(client.projectPath("maps"));
			log(formatOutput(data, config.format));
		},
	);
}

async function mapsDelete(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash maps delete <map-id> [global options]",
			allowPositionals: true,
		},
		async ({ client, positionals }) => {
			const mapId = positionals[0];
			if (!mapId) {
				error("Map ID is required: framedash maps delete <map-id>");
				process.exit(1);
			}

			await client.delete(client.projectPath(`maps/${encodeURIComponent(mapId)}`));
			success(`Map ${mapId} deleted`);
		},
	);
}
