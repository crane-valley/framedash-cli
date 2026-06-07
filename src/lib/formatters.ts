import type { OutputFormat } from "./config.js";

/** Format data for CLI output in the requested format. */
export function formatOutput(data: unknown, format: OutputFormat): string {
	switch (format) {
		case "json":
			return JSON.stringify(data, null, 2);
		case "table":
			return formatTable(data);
		case "csv":
			return formatCsv(data);
	}
}

function formatTable(data: unknown): string {
	const rows = toRows(data);
	if (rows.length === 0) return "(no data)";

	const firstRow = rows[0];
	if (!firstRow) return "(no data)";

	const keys = Object.keys(firstRow);
	const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => cellString(r[k]).length)));

	const header = keys.map((k, i) => k.padEnd(widths[i] ?? k.length)).join("  ");
	const separator = widths.map((w) => "-".repeat(w)).join("  ");
	const body = rows
		.map((row) => keys.map((k, i) => cellString(row[k]).padEnd(widths[i] ?? k.length)).join("  "))
		.join("\n");

	return `${header}\n${separator}\n${body}`;
}

function formatCsv(data: unknown): string {
	const rows = toRows(data);
	if (rows.length === 0) return "";

	const firstRow = rows[0];
	if (!firstRow) return "";

	const keys = Object.keys(firstRow);
	const header = keys.map(escapeCsv).join(",");
	const body = rows
		.map((row) => keys.map((k) => escapeCsv(cellString(row[k]))).join(","))
		.join("\n");

	return `${header}\n${body}`;
}

/** Convert a cell value to a string for tabular output, JSON-encoding nested objects/arrays. */
function cellString(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function escapeCsv(value: string): string {
	// Prevent CSV formula injection (OWASP) — also catch whitespace-prefixed formulas
	const trimmed = value.trimStart();
	if (trimmed.length > 0 && /^[=+\-@]/.test(trimmed)) {
		value = `'${value}`;
	}
	if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function toRows(data: unknown): Record<string, unknown>[] {
	if (Array.isArray(data)) {
		return data.map((item) =>
			typeof item === "object" && item !== null
				? (item as Record<string, unknown>)
				: { value: item },
		);
	}
	if (typeof data === "object" && data !== null) return [data as Record<string, unknown>];
	return [{ value: data }];
}
