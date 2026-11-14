import { afterEach, describe, expect, it, vi } from "vitest";
import { error, info, log, success, warn } from "./logger.js";

describe("logger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["error", error, "✗"],
		["warn", warn, "!"],
		["success", success, "✓"],
	] as const)("%s escapes control characters in server-provided text", (_name, fn, mark) => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		fn("API error: build 'x\n::warning ::pwned\x1b]52;c;eA==\x07\t\x9b'");
		expect(write).toHaveBeenCalledWith(
			`  ${mark} API error: build 'x\\u000a::warning ::pwned\\u001b]52;c;eA==\\u0007\\u0009\\u009b'\n`,
		);
	});

	it("leaves stdout data output untouched", () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		log("a\tb\nc");
		expect(write).toHaveBeenCalledWith("a\tb\nc\n");
	});

	it("writes neutral stderr information with control characters escaped", () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		info("Comparison\n::warning ::injected\x1b[2J");
		expect(write).toHaveBeenCalledWith("  Comparison\\u000a::warning ::injected\\u001b[2J\n");
	});
});
