import { readFile } from "node:fs/promises";
import { buildContentPath } from "@framedash/api-client";
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
			const data = await client.get(buildContentPath({ type: values.type as string | undefined }));
			log(formatOutput(data, config.format));
		},
	);
}

async function contentImport(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: `Usage: framedash content import <file.json> [global options]

Accepted JSON: an array or { "entries": [...] }. Each entry requires non-empty
string fields contentType, contentId, and displayName. Optional description and
category are strings or null; metadata is an object or null.`,
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
			const validationError = validateContentImportPayload(payload);
			if (validationError) {
				error(validationError);
				process.exit(1);
			}

			const data = await client.post("/api/v1/content", payload);
			success("Content imported");
			log(formatOutput(data, config.format));
		},
	);
}

const CONTENT_IMPORT_SHAPE =
	"Required fields: contentType, contentId, displayName (non-empty strings). " +
	"Optional: description/category must be strings or null; metadata must be an object or null.";

function validateContentImportPayload(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return `Import JSON must be an array or an object with an entries array. ${CONTENT_IMPORT_SHAPE}`;
	}
	const entries = (payload as { entries?: unknown }).entries;
	if (!Array.isArray(entries) || entries.length === 0) {
		return `Import JSON must contain a non-empty entries array. ${CONTENT_IMPORT_SHAPE}`;
	}
	for (const [index, entry] of entries.entries()) {
		const validationError = validateContentImportEntry(entry, index + 1);
		if (validationError) {
			return validationError;
		}
	}
	return null;
}

function validateContentImportEntry(entry: unknown, entryNumber: number): string | null {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return `Entry ${entryNumber} must be an object. ${CONTENT_IMPORT_SHAPE}`;
	}
	const record = entry as Record<string, unknown>;
	for (const field of ["contentType", "contentId", "displayName"] as const) {
		if (typeof record[field] !== "string" || record[field].trim().length === 0) {
			return `Entry ${entryNumber}: ${field} is required and must be a non-empty string. ${CONTENT_IMPORT_SHAPE}`;
		}
	}
	for (const field of ["description", "category"] as const) {
		if (
			record[field] !== undefined &&
			record[field] !== null &&
			typeof record[field] !== "string"
		) {
			return `Entry ${entryNumber}: ${field} must be a string or null. ${CONTENT_IMPORT_SHAPE}`;
		}
	}
	if (
		record.metadata !== undefined &&
		record.metadata !== null &&
		(typeof record.metadata !== "object" || Array.isArray(record.metadata))
	) {
		return `Entry ${entryNumber}: metadata must be an object or null. ${CONTENT_IMPORT_SHAPE}`;
	}
	return null;
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
