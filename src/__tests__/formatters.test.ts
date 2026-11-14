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
		it("renders and aligns 150,000 rows without a RangeError", () => {
			const rows = Array.from({ length: 150_000 }, (_, index) => ({
				id: String(index),
				name: index === 149_999 ? "longest name" : "x",
			}));
			const lines = formatOutput(rows, "table").split("\n");
			expect(lines).toHaveLength(150_002);
			expect(lines[0]).toBe("id      name        ");
			expect(lines[1]).toBe("------  ------------");
			expect(lines[2]).toBe("0       x           ");
			expect(lines.at(-1)).toBe("149999  longest name");
		});

		it("formats array of objects as aligned table", () => {
			const data = [
				{ id: "1", name: "Alice" },
				{ id: "22", name: "Bob" },
			];
			const result = formatOutput(data, "table");
			const lines = result.split("\n");
			expect(lines).toHaveLength(4);
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

		it("escapes C0, DEL and C1 controls in cells and headers and aligns on the escaped text", () => {
			const data = [
				{ event_name: "boss\x1b]8;;https://evil.example\x07kill", "k\tey": "x" },
				{ event_name: "line\r\nbreak\x7f\x9b2J", "k\tey": "y" },
			];
			const first = "boss\\u001b]8;;https://evil.example\\u0007kill";
			const second = "line\\u000d\\u000abreak\\u007f\\u009b2J";
			const lines = formatOutput(data, "table").split("\n");
			expect(lines).toEqual([
				`${"event_name".padEnd(first.length)}  k\\u0009ey`,
				`${"-".repeat(first.length)}  ---------`,
				`${first}  ${"x".padEnd(9)}`,
				`${second.padEnd(first.length)}  ${"y".padEnd(9)}`,
			]);
		});

		it("escapes control characters in sectioned payload titles and cells", () => {
			const result = formatOutput({ "t\x1b[2J": [{ name: "a\nb" }] }, "table");
			expect(result).toBe("## t\\u001b[2J\nname    \n--------\na\\u000ab");
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
			expect(result).toContain("kpis");
			expect(result).toContain("topEvents");
			expect(result).toContain("dailyActiveUsers");
			expect(result).toContain("dau");
			expect(result).toContain("100");
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
			const data = { id: "a1", name: "High mem", metric: "memory", channelIds: [] };
			const result = formatOutput(data, "table");
			const lines = result.split("\n");
			expect(lines).toHaveLength(3);
			expect(lines[0]).toContain("id");
			expect(lines[0]).toContain("channelIds");
			expect(result).not.toContain("## id");
		});

		it("does not section or dot-path-flatten a top-level array (no regression)", () => {
			const data = [{ id: "1", meta: { a: 1 } }];
			const result = formatOutput(data, "table");
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
			const cases = [
				"+1+cmd|' /C calc'!A0",
				"-1+cmd|' /C calc'!A0",
				"=1+2",
				"@SUM(A1:A2)",
				"-5-5",
				"-",
				"-.",
				"+-1",
				"-1e",
				"-0x10",
				" -1+2",
				"-1..",
				"-..5",
				"-1..2..3",
				"-1..2+cmd",
			];
			for (const val of cases) {
				expect(formatOutput([{ v: val }], "csv")).toContain(`'${val}`);
			}
		});

		it("emits string cells holding a plain numeric literal without the prefix", () => {
			const cases = [
				"-5",
				"+5",
				"-3.2",
				"-9223372036854775808",
				"-1e-5",
				"+1E+10",
				"-.5",
				"-5.",
				" -5",
				"-0.0625..0.125",
				"-1..1",
				"+1e-3..-2E+4",
			];
			for (const val of cases) {
				expect(formatOutput([{ v: val }], "csv")).toBe(`v\n${val}`);
			}
		});

		it("escapes control characters except tab so a cell cannot start a new line", () => {
			const result = formatOutput(
				[{ build_id: "ci-1\n::warning ::pwned", note: "a\tb\r\x1b]52;c;eA==\x07\x7f\x85" }],
				"csv",
			);
			expect(result).toBe(
				"build_id,note\nci-1\\u000a::warning ::pwned,a\tb\\u000d\\u001b]52;c;eA==\\u0007\\u007f\\u0085",
			);
		});

		it("applies the formula prefix after escaping control characters", () => {
			expect(formatOutput([{ v: "-5\n=1+2" }], "csv")).toBe("v\n'-5\\u000a=1+2");
			expect(formatOutput([{ v: "\t=1+2" }], "csv")).toBe("v\n'\t=1+2");
		});

		it("emits numeric cells verbatim, without the formula-injection prefix", () => {
			const result = formatOutput([{ diffPct: -3.2, delta: -1, big: -5n, ok: false }], "csv");
			expect(result).toBe("diffPct,delta,big,ok\n-3.2,-1,-5,false");
		});

		it("unwraps the /api/v1/query { rows, rowCount } envelope into column rows", () => {
			const data = {
				rows: [
					{ event_name: "login", count: 100 },
					{ event_name: "purchase", count: 25 },
				],
				rowCount: 2,
			};
			const result = formatOutput(data, "csv");
			expect(result).toBe("event_name,count\nlogin,100\npurchase,25");
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
