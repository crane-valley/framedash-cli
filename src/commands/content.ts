import { readFile } from "node:fs/promises";
import { formatOutput } from "../lib/formatters.js";
import { error, log, success } from "../lib/logger.js";
import { runCommand, withSubcommands } from "../lib/run-command.js";

const HELP = `Usage: framedash content <subcommand> [options]

Manage content registry entries.

Subcommands:
  list                   List content entries
  import <file.json>     Import content entries from JSON
  delete <id>            Delete by UUID, or use --type + --content-id

Run 'framedash content <subcommand> --help' for more info.`;

const DELETE_HELP = `Usage: framedash content delete <uuid> [global options]
       framedash content delete --type <type> --content-id <id> [global options]

Delete a content entry by UUID or by type + content ID pair.`;

export const content = withSubcommands("content", HELP, {
	list: contentList,
	import: contentImport,
	delete: contentDelete,
});

async function contentList(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash content list [--type <content-type>] [--format json|table|csv] [global options]",
			options: { type: { type: "string" } },
		},
		async ({ client, config, values }) => {
			const params = values.type ? `?${new URLSearchParams({ type: values.type as string })}` : "";
			const data = await client.get(`/api/v1/content${params}`);
			log(formatOutput(data, config.format));
		},
	);
}

async function contentImport(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash content import <file.json> [global options]",
			allowPositionals: true,
		},
		async ({ client, config, positionals }) => {
			const filePath = positionals[0];
			if (!filePath) {
				error("JSON file path is required: framedash content import <file.json>");
				process.exit(1);
			}

			let raw: string;
			try {
				raw = await readFile(filePath, "utf-8");
			} catch (err) {
				const msg = err instanceof Error ? err.message : "unknown error";
				error(`Failed to read file: ${filePath} (${msg})`);
				process.exit(1);
			}

			let entries: unknown;
			try {
				entries = JSON.parse(raw);
			} catch {
				error("Invalid JSON file");
				process.exit(1);
			}

			// Accept both { entries: [...] } and plain [...]
			const payload = Array.isArray(entries) ? { entries } : entries;

			const data = await client.post("/api/v1/content", payload);
			success("Content imported");
			log(formatOutput(data, config.format));
		},
	);
}

async function contentDelete(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: DELETE_HELP,
			options: {
				type: { type: "string" },
				"content-id": { type: "string" },
			},
			allowPositionals: true,
		},
		async ({ client, values, positionals }) => {
			const id = positionals[0];
			if (id && (values.type || values["content-id"])) {
				error("Cannot combine <uuid> with --type/--content-id. Choose one mode.");
				process.exit(1);
			}
			if (id) {
				const params = new URLSearchParams({ id });
				await client.delete(`/api/v1/content?${params}`);
				success(`Content entry ${id} deleted`);
			} else if (values.type && values["content-id"]) {
				const params = new URLSearchParams({
					contentType: values.type as string,
					contentId: values["content-id"] as string,
				});
				await client.delete(`/api/v1/content?${params}`);
				success("Content entry deleted");
			} else {
				error("Provide <uuid> or both --type and --content-id");
				process.exit(1);
			}
		},
	);
}
