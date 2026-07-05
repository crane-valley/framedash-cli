import { describe, expect, it } from "vitest";
import { OAuthCallbackError, startLoopbackServer } from "./loopback-server.js";

// These tests hit the real ephemeral server over 127.0.0.1 (loopback only,
// no external network) because the bind address IS the security property
// under test.

const STATE = "expected-state-value-123";

async function withServer(
	fn: (server: Awaited<ReturnType<typeof startLoopbackServer>>) => Promise<void>,
): Promise<void> {
	const server = await startLoopbackServer(STATE);
	try {
		await fn(server);
	} finally {
		await server.close();
	}
}

describe("startLoopbackServer", () => {
	it("binds to 127.0.0.1 on an ephemeral port with a /callback redirect URI", async () => {
		await withServer(async (server) => {
			expect(server.port).toBeGreaterThan(0);
			expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
			// The URI the AS redirects to must resolve on loopback.
			const res = await fetch(`http://127.0.0.1:${server.port}/other`);
			expect(res.status).toBe(404);
		});
	});

	it("resolves the code for a callback with the exact expected state", async () => {
		await withServer(async (server) => {
			const wait = server.waitForCallback(5000);
			const res = await fetch(
				`${server.redirectUri}?code=fdac_test_code&state=${encodeURIComponent(STATE)}`,
			);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("close this tab");
			// The response page must not echo the authorization code.
			expect(body).not.toContain("fdac_test_code");
			await expect(wait).resolves.toEqual({ code: "fdac_test_code" });
		});
	});

	it("ignores a state-mismatched code callback: no settle, forged code never surfaces", async () => {
		await withServer(async (server) => {
			const wait = server.waitForCallback(5000);
			const res = await fetch(`${server.redirectUri}?code=fdac_forged&state=wrong-state`);
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("did not match a pending sign-in");
			// The pending login is NOT aborted: a local prankster must not be
			// able to kill a sign-in by lobbing forged callbacks at the port...
			const outcome = await Promise.race([
				wait,
				new Promise((resolve) => setTimeout(resolve, 150, "still-pending")),
			]);
			expect(outcome).toBe("still-pending");
			// ...and the legitimate callback still completes it.
			await fetch(`${server.redirectUri}?code=fdac_real&state=${encodeURIComponent(STATE)}`);
			await expect(wait).resolves.toEqual({ code: "fdac_real" });
		});
	});

	it("ignores a callback with no state at all", async () => {
		await withServer(async (server) => {
			const wait = server.waitForCallback(5000);
			const res = await fetch(`${server.redirectUri}?code=fdac_forged`);
			expect(res.status).toBe(400);
			await fetch(`${server.redirectUri}?code=fdac_real&state=${encodeURIComponent(STATE)}`);
			await expect(wait).resolves.toEqual({ code: "fdac_real" });
		});
	});

	it("ignores a forged error= callback with a wrong state (RFC 6749: error redirects carry state too)", async () => {
		await withServer(async (server) => {
			const wait = server.waitForCallback(5000);
			const res = await fetch(`${server.redirectUri}?error=access_denied&state=wrong-state`);
			expect(res.status).toBe(400);
			const outcome = await Promise.race([
				wait,
				new Promise((resolve) => setTimeout(resolve, 150, "still-pending")),
			]);
			expect(outcome).toBe("still-pending");
			// A correctly-stated error callback still settles as denial.
			const errPromise = wait.catch((e: Error) => e);
			await fetch(`${server.redirectUri}?error=access_denied&state=${encodeURIComponent(STATE)}`);
			expect(await errPromise).toBeInstanceOf(OAuthCallbackError);
		});
	});

	it("rejects with OAuthCallbackError on an error= callback", async () => {
		await withServer(async (server) => {
			const errPromise = server.waitForCallback(5000).catch((e: Error) => e);
			const res = await fetch(
				`${server.redirectUri}?error=access_denied&error_description=User+denied+access&state=${encodeURIComponent(STATE)}`,
			);
			expect(res.status).toBe(200);
			const err = await errPromise;
			expect(err).toBeInstanceOf(OAuthCallbackError);
			expect((err as Error).message).toMatch(/access_denied/);
		});
	});

	it("sanitizes control characters out of the error before it reaches the terminal", async () => {
		await withServer(async (server) => {
			const errPromise = server.waitForCallback(5000).catch((e: Error) => e);
			// %1B%5B31m is an ANSI escape sequence (ESC [ 31 m) smuggled into error=.
			await fetch(
				`${server.redirectUri}?error=access_denied%1B%5B31mINJECTED&state=${encodeURIComponent(STATE)}`,
			);
			const err = await errPromise;
			expect(err).toBeInstanceOf(OAuthCallbackError);
			expect((err as Error).message).not.toContain(String.fromCharCode(27));
			expect((err as OAuthCallbackError).code).toBe("access_denied31mINJECTED");
		});
	});

	it("rejects a callback without a code", async () => {
		await withServer(async (server) => {
			const assertion = expect(server.waitForCallback(5000)).rejects.toThrow(
				/no authorization code/,
			);
			const res = await fetch(`${server.redirectUri}?state=${encodeURIComponent(STATE)}`);
			expect(res.status).toBe(400);
			await assertion;
		});
	});

	it("only the first callback settles the flow", async () => {
		await withServer(async (server) => {
			const wait = server.waitForCallback(5000);
			await fetch(`${server.redirectUri}?code=first&state=${encodeURIComponent(STATE)}`);
			const second = await fetch(
				`${server.redirectUri}?code=second&state=${encodeURIComponent(STATE)}`,
			);
			expect(second.status).toBe(200);
			await expect(wait).resolves.toEqual({ code: "first" });
		});
	});

	it("times out when no callback arrives", async () => {
		await withServer(async (server) => {
			await expect(server.waitForCallback(50)).rejects.toThrow(/Timed out/);
		});
	});
});
