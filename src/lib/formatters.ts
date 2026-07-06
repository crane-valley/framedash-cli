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
	// The /api/v1/query endpoint returns { rows: [...], rowCount: N }. Tabulate
	// the rows themselves rather than dumping the whole array into one JSON cell.
	if (isQueryResult(data)) {
		return formatTable(data.rows);
	}

	// A single object whose values contain nested arrays/objects (e.g. the
	// dashboard's { kpis, dailyActiveUsers, topEvents }) renders one titled
	// section per key rather than a single blob-cell row. Flat arrays-of-objects
	// (maps list, alerts list, builds) fall through to the plain table renderer
	// unchanged.
	if (isSectionedPayload(data)) {
		return formatSections(data as Record<string, unknown>);
	}

	const rows = toRows(data);
	if (rows.length === 0) return "(no data)";

	const firstRow = rows[0];
	if (!firstRow) return "(no data)";

	return renderRows(rows, Object.keys(firstRow));
}

/**
 * True for the /api/v1/query result envelope { rows: [...], rowCount: number }.
 * Only that endpoint returns this shape, so table format can safely unwrap it to
 * tabulate the individual records instead of rendering one giant JSON cell.
 */
function isQueryResult(data: unknown): data is { rows: unknown[]; rowCount: number } {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
	const obj = data as Record<string, unknown>;
	return Array.isArray(obj.rows) && typeof obj.rowCount === "number";
}

/**
 * True for an envelope-style object whose every field is a nested array/object
 * (e.g. the dashboard's { kpis, dailyActiveUsers, topEvents } or status's
 * { project, kpis }). Records that mix scalar fields with a nested one -- such as
 * an alert row's scalars plus channelIds: [] -- stay on the plain one-row table
 * path, so `alerts create/update --format table` output does not regress.
 */
function isSectionedPayload(data: unknown): boolean {
	if (Array.isArray(data)) return false;
	if (typeof data !== "object" || data === null) return false;
	const values = Object.values(data);
	if (values.length === 0) return false;
	return values.every((v) => v !== null && typeof v === "object");
}

/** Render each top-level key of a sectioned payload as a titled sub-table. */
function formatSections(obj: Record<string, unknown>): string {
	const sections = Object.entries(obj).map(([key, value]) => {
		let table: string;
		if (Array.isArray(value)) {
			table = formatArraySection(value);
		} else if (value !== null && typeof value === "object") {
			table = formatObjectSection(value as Record<string, unknown>);
		} else {
			table = cellString(value);
		}
		return `## ${key}\n${table}`;
	});
	return sections.join("\n\n");
}

/** An array-of-objects section: normal table, nested objects flattened to dot-paths. */
function formatArraySection(arr: unknown[]): string {
	if (arr.length === 0) return "(no data)";
	const rows = arr.map((item) =>
		typeof item === "object" && item !== null && !Array.isArray(item)
			? flattenOneLevel(item as Record<string, unknown>)
			: { value: item },
	);
	return renderRows(rows, unionKeys(rows));
}

/** An object section: two-column key/value rows. */
function formatObjectSection(obj: Record<string, unknown>): string {
	const rows = Object.entries(obj).map(([key, value]) => ({ key, value }));
	if (rows.length === 0) return "(no data)";
	return renderRows(rows, ["key", "value"]);
}

/** Flatten one level of nested objects into dot-path keys; deeper nesting stays JSON. */
function flattenOneLevel(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
				out[`${key}.${subKey}`] = subValue;
			}
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Union of row keys in first-seen order. */
function unionKeys(rows: Record<string, unknown>[]): string[] {
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
	}
	return keys;
}

/** Render aligned columns for the given rows/keys using cellString for each cell. */
function renderRows(rows: Record<string, unknown>[], keys: string[]): string {
	if (rows.length === 0 || keys.length === 0) return "(no data)";
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
