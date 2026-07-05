import { describe, expect, it } from "vitest";
import { formatOutput } from "../lib/formatters.js";

describe("formatOutput", () => {
	describe("json format", () => {
		it("formats array as indented JSON", () => {
			const data = [{ id: 1, name: "test" }];
			expect(formatOutput(data, "json")).toBe(JSON.stringify(data, null, 2));
		});

		it("formats object as indented JSON", () => {
			const data = { count: 42 };
			expect(formatOutput(data, "json")).toBe(JSON.stringify(data, null, 2));
		});
	});

	describe("table format", () => {
		it("formats array of objects as aligned table", () => {
			const data = [
				{ id: "1", name: "Alice" },
				{ id: "22", name: "Bob" },
			];
			const result = formatOutput(data, "table");
			const lines = result.split("\n");
			expect(lines).toHaveLength(4); // header + separator + 2 rows
			expect(lines[0]).toContain("id");
			expect(lines[0]).toContain("name");
			expect(lines[1]).toMatch(/^-+/);
			expect(lines[2]).toContain("1");
			expect(lines[2]).toContain("Alice");
			expect(lines[3]).toContain("22");
			expect(lines[3]).toContain("Bob");
		});

		it("formats single object as one-row table", () => {
			const data = { status: "ok", count: 5 };
			const result = formatOutput(data, "table");
			const lines = result.split("\n");
			expect(lines).toHaveLength(3);
			expect(lines[0]).toContain("status");
			expect(lines[2]).toContain("ok");
		});

		it("returns placeholder for empty array", () => {
			expect(formatOutput([], "table")).toBe("(no data)");
		});

		it("handles null values", () => {
			const data = [{ a: "x", b: null }];
			const result = formatOutput(data, "table");
			expect(result).toContain("a");
			expect(result).toContain("b");
		});

		it("renders nested objects as JSON instead of [object Object]", () => {
			const data = [{ id: "1", world_bounds: { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } } }];
			const result = formatOutput(data, "table");
			expect(result).not.toContain("[object Object]");
			expect(result).toContain('"min"');
		});

		it("renders nested arrays as JSON instead of comma-stringified values", () => {
			const data = [{ id: "1", tags: [{ name: "a" }, { name: "b" }] }];
			const result = formatOutput(data, "table");
			expect(result).not.toContain("[object Object]");
			expect(result).toContain('"name"');
		});

		it("renders a single object with nested values as sections", () => {
			const data = {
				kpis: { dau: 100, sessions: 250 },
				topEvents: [
					{ name: "player.death", count: 42 },
					{ name: "level.up", count: 30 },
				],
				dailyActiveUsers: [{ date: "2026-07-01", count: 10 }],
			};
			const result = formatOutput(data, "table");
			// One section per key
			expect(result).toContain("kpis");
			expect(result).toContain("topEvents");
			expect(result).toContain("dailyActiveUsers");
			// Object section renders as key/value rows
			expect(result).toContain("dau");
			expect(result).toContain("100");
			// Array-of-objects section renders as a normal table
			expect(result).toContain("player.death");
			expect(result).not.toContain("[object Object]");
		});

		it("flattens nested objects to dot-path columns one level deep in array sections", () => {
			const data = {
				profiles: [{ name: "PC", thresholds: { fps: 60, mem: 1024 } }],
			};
			const result = formatOutput(data, "table");
			expect(result).toContain("thresholds.fps");
			expect(result).toContain("60");
			expect(result).not.toContain("[object Object]");
		});

		it("keeps a record with scalar fields plus one nested field as a one-row table", () => {
			// Alert create/update responses are scalars plus channelIds: [] -- these
			// must stay a single row, not fan out into per-field sections.
			const data = { id: "a1", name: "High mem", metric: "memory", channelIds: [] };
			const result = formatOutput(data, "table");
			const lines = result.split("\n");
			expect(lines).toHaveLength(3); // header + separator + one row
			expect(lines[0]).toContain("id");
			expect(lines[0]).toContain("channelIds");
			expect(result).not.toContain("## id");
		});

		it("does not section or dot-path-flatten a top-level array (no regression)", () => {
			const data = [{ id: "1", meta: { a: 1 } }];
			const result = formatOutput(data, "table");
			// Nested object still JSON-stringified, not flattened to meta.a
			expect(result).toContain('"a"');
			expect(result).not.toContain("meta.a");
		});
	});

	describe("csv format", () => {
		it("formats array with header row", () => {
			const data = [
				{ id: "1", name: "Alice" },
				{ id: "2", name: "Bob" },
			];
			const result = formatOutput(data, "csv");
			const lines = result.split("\n");
			expect(lines[0]).toBe("id,name");
			expect(lines[1]).toBe("1,Alice");
			expect(lines[2]).toBe("2,Bob");
		});

		it("escapes values with commas", () => {
			const data = [{ msg: "hello, world" }];
			const result = formatOutput(data, "csv");
			expect(result).toContain('"hello, world"');
		});

		it("escapes values with double quotes", () => {
			const data = [{ msg: 'say "hi"' }];
			const result = formatOutput(data, "csv");
			expect(result).toContain('"say ""hi"""');
		});

		it("returns empty string for empty array", () => {
			expect(formatOutput([], "csv")).toBe("");
		});

		it("prefixes formula-injection chars with single quote", () => {
			const data = [{ val: "=cmd|'/c calc'!A1" }];
			const result = formatOutput(data, "csv");
			// Should be prefixed with ' to prevent Excel formula execution
			expect(result).toContain("'=cmd");
		});

		it("prefixes + - @ leading chars", () => {
			const cases = ["+1", "-1", "@sum"];
			for (const val of cases) {
				const data = [{ v: val }];
				const result = formatOutput(data, "csv");
				expect(result).toContain(`'${val}`);
			}
		});

		it("renders nested objects as quoted JSON instead of [object Object]", () => {
			const data = [{ id: "1", bounds: { min: 0, max: 100 } }];
			const result = formatOutput(data, "csv");
			expect(result).not.toContain("[object Object]");
			expect(result).toContain('"{""min"":0,""max"":100}"');
		});

		it("renders nested arrays as quoted JSON", () => {
			const data = [{ id: "1", items: [{ a: 1 }, { a: 2 }] }];
			const result = formatOutput(data, "csv");
			expect(result).not.toContain("[object Object]");
			expect(result).toContain('"a"');
		});
	});
});
