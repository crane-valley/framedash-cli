import { ApiClient, assertSafeBaseUrl } from "@framedash/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapCaptureMetadata } from "../lib/metadata.js";
import { uploadMapCapture } from "../lib/uploader.js";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
}));

const onError = (err: Error): never => {
	throw err;
};

const CLIENT_OPTS = {
	apiKey: "fd_admin_test",
	projectId: "proj-1",
	onError,
};

function fakeResponse(init: { status: number; type?: string; body?: unknown }): Response {
	const status = init.status;
	return {
		status,
		ok: status >= 200 && status < 300,
		type: init.type ?? "default",
		headers: new Headers(),
		text: async () => (init.body === undefined ? "" : JSON.stringify(init.body)),
		json: async () => init.body,
	} as unknown as Response;
}

describe("assertSafeBaseUrl", () => {
	it("accepts https and loopback http", () => {
		for (const url of [
			"https://app.framedash.dev",
			"https://app.framedash.dev/",
			"http://localhost:3000",
			"http://localhost.:3000", // trailing-dot FQDN
			"http://api.localhost:3000",
			"http://127.0.0.1:8787",
			"http://127.0.0.5:8787", // anywhere in 127.0.0.0/8
			"http://[::1]:3000",
		]) {
			expect(() => assertSafeBaseUrl(url)).not.toThrow();
		}
	});

	it("rejects http to a non-loopback host", () => {
		expect(() => assertSafeBaseUrl("http://app.framedash.dev")).toThrow(/Insecure/);
		expect(() => assertSafeBaseUrl("http://128.0.0.1")).toThrow(/Insecure/);
	});

	it("rejects a look-alike host that merely starts with localhost", () => {
		// The substring-matching bug this replaces would accept these.
		expect(() => assertSafeBaseUrl("http://localhost.attacker.example")).toThrow(/Insecure/);
		expect(() => assertSafeBaseUrl("http://127.0.0.1.attacker.example")).toThrow(/Insecure/);
	});

	it("rejects a URL with embedded credentials (userinfo bypass)", () => {
		// https://real-host@evil.example passes the https check but the request
		// and the X-API-Key header go to evil.example.
		expect(() => assertSafeBaseUrl("https://app.framedash.dev@evil.example")).toThrow(
			/credentials/,
		);
		// biome-ignore lint/security/noSecrets: test fixture, not a real credential
		expect(() => assertSafeBaseUrl("https://user:pass@evil.example")).toThrow(/credentials/);
	});

	it("rejects non-http(s) schemes and unparseable URLs", () => {
		expect(() => assertSafeBaseUrl("ftp://app.framedash.dev")).toThrow(/Insecure/);
		expect(() => assertSafeBaseUrl("not a url")).toThrow(/Invalid/);
	});
});

describe("ApiClient transport security", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("rejects an insecure base URL at construction", () => {
		expect(() => new ApiClient({ baseUrl: "http://evil.example", ...CLIENT_OPTS })).toThrow(
			/Insecure/,
		);
	});

	it("sends redirect:manual and an abort signal", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(fakeResponse({ status: 200, body: { success: true, data: { ok: 1 } } }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new ApiClient({ baseUrl: "https://app.framedash.dev", ...CLIENT_OPTS });

		await expect(client.get("/api/v1/projects")).resolves.toEqual({ ok: 1 });
		const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(opts.redirect).toBe("manual");
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	it("refuses to follow a 3xx redirect (would leak the API key)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 302 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new ApiClient({ baseUrl: "https://app.framedash.dev", ...CLIENT_OPTS });
		await expect(client.get("/x")).rejects.toThrow(/redirect/i);
	});

	it("treats an opaqueredirect response as an error", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(fakeResponse({ status: 0, type: "opaqueredirect" }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new ApiClient({ baseUrl: "https://app.framedash.dev", ...CLIENT_OPTS });
		await expect(client.get("/x")).rejects.toThrow(/redirect/i);
	});
});

describe("uploadMapCapture transport security", () => {
	afterEach(() => vi.unstubAllGlobals());

	const metadata: MapCaptureMetadata = {
		version: "1.0",
		map_id: "map-1",
		image_path: "map-1.png",
		image_dimensions: { width: 16, height: 16 },
		world_bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
	};

	it("rejects an insecure base URL before reading the file", async () => {
		await expect(
			uploadMapCapture({
				metadata,
				imagePath: "map-1.png",
				apiKey: "fd_admin_test",
				projectId: "proj-1",
				baseUrl: "http://evil.example",
			}),
		).rejects.toThrow(/Insecure/);
	});

	it("normalizes a trailing-slash base URL so it does not build a double slash", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				fakeResponse({ status: 200, body: { success: true, mapId: "m", action: "created" } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		await uploadMapCapture({
			metadata,
			imagePath: "map-1.png",
			apiKey: "fd_admin_test",
			projectId: "proj-1",
			baseUrl: "https://app.framedash.dev/",
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.framedash.dev/api/v1/maps/upload");
	});

	it("refuses to follow a redirect and sends redirect:manual + abort signal", async () => {
		const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ status: 302 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			uploadMapCapture({
				metadata,
				imagePath: "map-1.png",
				apiKey: "fd_admin_test",
				projectId: "proj-1",
				baseUrl: "https://app.framedash.dev",
			}),
		).rejects.toThrow(/redirect/i);
		const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(opts.redirect).toBe("manual");
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});
});
