import { describe, expect, it } from "vitest";
import { formatOutput } from "./formatters.js";

const queryResult = {
	rows: [
		{ event_name: "login", count: 100 },
		{ event_name: "purchase", count: 25 },
	],
	rowCount: 2,
};

describe("formatOutput table for /api/v1/query results", () => {
	it("tabulates the rows of a {rows, rowCount} query result", () => {
		const out = formatOutput(queryResult, "table");
		const lines = out.split("\n");
		// Header from the first row's keys, a separator, then one line per record.
		expect(lines[0]).toContain("event_name");
		expect(lines[0]).toContain("count");
		expect(lines[1]).toMatch(/^-+/);
		expect(lines[2]).toContain("login");
		expect(lines[2]).toContain("100");
		expect(lines[3]).toContain("purchase");
		expect(lines[3]).toContain("25");
		// The whole rows array must NOT be dumped into a single JSON cell.
		expect(out).not.toContain('[{"event_name"');
		expect(out).not.toContain("rowCount");
	});

	it("renders (no data) for an empty query result", () => {
		expect(formatOutput({ rows: [], rowCount: 0 }, "table")).toBe("(no data)");
	});

	it("leaves json output unchanged (full envelope)", () => {
		expect(formatOutput(queryResult, "json")).toBe(JSON.stringify(queryResult, null, 2));
	});

	it("leaves a plain array table render unchanged", () => {
		const out = formatOutput(queryResult.rows, "table");
		expect(out.split("\n")[0]).toContain("event_name");
		expect(out).toContain("login");
	});
});
