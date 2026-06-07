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
