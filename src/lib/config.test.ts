import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("./logger.js", () => ({ error: vi.fn() }));

import { readFileSync } from "node:fs";
import { resolveApiKey, resolveCredential } from "./config.js";
import * as loggerModule from "./logger.js";

// Override process.stdin.isTTY for the duration of `fn`, then restore it.
// isTTY is `undefined` under a non-TTY stdin (the usual test-runner state),
// so we redefine the property rather than assign through the getter.
function withStdinTty(isTty: boolean, fn: () => void): void {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: isTty, configurable: true });
	try {
		fn();
	} finally {
		if (descriptor) {
			Object.defineProperty(process.stdin, "isTTY", descriptor);
		} else {
			delete (process.stdin as { isTTY?: boolean }).isTTY;
		}
	}
}

function expectExit(fn: () => unknown): void {
	const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit");
	}) as never);
	try {
		expect(fn).toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalled();
	} finally {
		exitSpy.mockRestore();
	}
}

describe("resolveApiKey", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FRAMEDASH_API_KEY;
	});

	it("prefers the --api-key flag over file and env", () => {
		process.env.FRAMEDASH_API_KEY = "env-key";
		expect(resolveApiKey({ "api-key": "flag-key", "api-key-file": "k.txt" })).toBe("flag-key");
		expect(readFileSync).not.toHaveBeenCalled();
	});

	it("reads and trims the key from --api-key-file", () => {
		vi.mocked(readFileSync).mockReturnValue("file-key\n" as unknown as Buffer);
		expect(resolveApiKey({ "api-key-file": "k.txt" })).toBe("file-key");
		expect(readFileSync).toHaveBeenCalledWith("k.txt", "utf8");
	});

	it("reads the key from stdin (fd 0) when --api-key-file is '-'", () => {
		withStdinTty(false, () => {
			vi.mocked(readFileSync).mockReturnValue("stdin-key\n" as unknown as Buffer);
			expect(resolveApiKey({ "api-key-file": "-" })).toBe("stdin-key");
			expect(readFileSync).toHaveBeenCalledWith(0, "utf8");
		});
	});

	it("exits when --api-key-file is '-' but stdin is an interactive TTY", () => {
		withStdinTty(true, () => {
			expectExit(() => resolveApiKey({ "api-key-file": "-" }));
			// Must not block on readFileSync(0) -- the guard rejects before reading.
			expect(readFileSync).not.toHaveBeenCalled();
		});
	});

	it("falls back to FRAMEDASH_API_KEY", () => {
		process.env.FRAMEDASH_API_KEY = "env-key";
		expect(resolveApiKey({})).toBe("env-key");
	});

	it("returns undefined when nothing is set", () => {
		expect(resolveApiKey({})).toBeUndefined();
	});

	it("exits when the key file is empty/whitespace", () => {
		vi.mocked(readFileSync).mockReturnValue("   \n" as unknown as Buffer);
		expectExit(() => resolveApiKey({ "api-key-file": "k.txt" }));
	});

	it("exits when the key file cannot be read", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expectExit(() => resolveApiKey({ "api-key-file": "missing.txt" }));
	});
});

describe("resolveCredential precedence", () => {
	const BASE_URL = "https://app.framedash.dev";
	const STORE_JSON = JSON.stringify({
		"https://app.framedash.dev": {
			access_token: "fdat_stored_access",
			refresh_token: "fdrt_stored_refresh",
			expires_at: 9_999_999_999_999,
			scope: "analytics:read",
		},
	});

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FRAMEDASH_API_KEY;
	});

	it("prefers the --api-key flag over everything (store never read)", () => {
		process.env.FRAMEDASH_API_KEY = "env-key";
		vi.mocked(readFileSync).mockReturnValue(STORE_JSON as unknown as Buffer);
		expect(resolveCredential({ "api-key": "flag-key", "api-key-file": "k.txt" }, BASE_URL)).toEqual(
			{ kind: "api-key", apiKey: "flag-key", source: "flag" },
		);
		expect(readFileSync).not.toHaveBeenCalled();
	});

	it("prefers --api-key-file over env and stored tokens", () => {
		process.env.FRAMEDASH_API_KEY = "env-key";
		vi.mocked(readFileSync).mockReturnValue("file-key\n" as unknown as Buffer);
		expect(resolveCredential({ "api-key-file": "k.txt" }, BASE_URL)).toEqual({
			kind: "api-key",
			apiKey: "file-key",
			source: "file",
		});
	});

	it("prefers FRAMEDASH_API_KEY env over a stored OAuth token", () => {
		process.env.FRAMEDASH_API_KEY = "env-key";
		vi.mocked(readFileSync).mockReturnValue(STORE_JSON as unknown as Buffer);
		expect(resolveCredential({}, BASE_URL)).toEqual({
			kind: "api-key",
			apiKey: "env-key",
			source: "env",
		});
		expect(readFileSync).not.toHaveBeenCalled();
	});

	it("falls back to the stored OAuth token for the base URL origin", () => {
		vi.mocked(readFileSync).mockReturnValue(STORE_JSON as unknown as Buffer);
		expect(resolveCredential({}, "https://app.framedash.dev/nested/path")).toEqual({
			kind: "oauth",
			origin: "https://app.framedash.dev",
			entry: {
				access_token: "fdat_stored_access",
				refresh_token: "fdrt_stored_refresh",
				expires_at: 9_999_999_999_999,
				scope: "analytics:read",
			},
		});
	});

	it("ignores stored tokens for a different origin", () => {
		vi.mocked(readFileSync).mockReturnValue(STORE_JSON as unknown as Buffer);
		expect(resolveCredential({}, "https://other.framedash.dev")).toBeUndefined();
	});

	it("treats a corrupt token store as no credential", () => {
		vi.mocked(readFileSync).mockReturnValue("{corrupt!" as unknown as Buffer);
		expect(resolveCredential({}, BASE_URL)).toBeUndefined();
	});

	it("returns undefined when nothing is configured", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(resolveCredential({}, BASE_URL)).toBeUndefined();
	});
});
