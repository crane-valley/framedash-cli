import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// RFC 8252 section 7.3 loopback redirect receiver for `framedash login`.
//
// SECURITY invariants:
//  - Binds STRICTLY to 127.0.0.1 (never 0.0.0.0 / ::) on an ephemeral port,
//    so nothing off-host can reach the callback.
//  - The `state` parameter is validated FIRST, for success AND error
//    callbacks alike, BEFORE the caller ever sees a code. A mismatched or
//    missing state does NOT settle the login: the request gets a generic
//    400 and the flow keeps waiting for the legitimate callback -- a forged
//    local request can neither abort nor complete a pending sign-in, and
//    any accompanying code is discarded (no token exchange happens).
//  - Responses to the browser are static HTML with no token/code material,
//    and nothing from the callback URL is reflected into the page.

const HTML_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
} as const;

function page(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 32rem;"><h1 style="font-size: 1.2rem;">${title}</h1><p>${body}</p></body></html>`;
}

const SUCCESS_PAGE = page("Login complete", "You can close this tab and return to the terminal.");
const FAILURE_PAGE = page(
	"Login failed",
	"The sign-in did not complete. Close this tab and check the terminal for details.",
);
const DONE_PAGE = page("Login already completed", "You can close this tab.");

/**
 * The authorization server bounced back an OAuth error (e.g. the user hit
 * Deny -> access_denied). Distinguished from local failures so the CLI can
 * present it as a normal outcome rather than a bug.
 */
export class OAuthCallbackError extends Error {
	constructor(
		public readonly code: string,
		description: string | null,
	) {
		super(`Authorization was not granted (${code})${description ? `: ${description}` : ""}`);
		this.name = "OAuthCallbackError";
	}
}

/**
 * Keep attacker-influenced callback values printable before they reach the
 * terminal: strip everything outside a conservative ASCII subset (kills
 * control characters / ANSI escapes) and cap the length.
 */
function sanitizeForTerminal(value: string): string {
	return value.replace(/[^a-zA-Z0-9 _.,:;/'()-]/g, "").slice(0, 200);
}

export type LoopbackServer = {
	/** The ephemeral port actually bound on 127.0.0.1. */
	port: number;
	/** The exact redirect URI to register in the authorize request. */
	redirectUri: string;
	/** Resolve with the authorization code, or reject on error/timeout. */
	waitForCallback: (timeoutMs: number) => Promise<{ code: string }>;
	close: () => Promise<void>;
};

/**
 * Start the loopback callback receiver. `expectedState` is the CSRF state
 * minted for this login attempt; only a /callback request carrying exactly
 * that state can complete the flow.
 */
export function startLoopbackServer(expectedState: string): Promise<LoopbackServer> {
	let settled = false;
	let resolveCallback: (value: { code: string }) => void = () => {};
	let rejectCallback: (reason: Error) => void = () => {};
	const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});
	// A rejection that nobody has awaited yet (e.g. state mismatch arriving
	// before waitForCallback is called) must not crash the process.
	callbackPromise.catch(() => {});

	const settle = (outcome: { code: string } | Error): void => {
		if (settled) return;
		settled = true;
		if (outcome instanceof Error) {
			rejectCallback(outcome);
		} else {
			resolveCallback(outcome);
		}
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== "/callback") {
			res.writeHead(404, HTML_HEADERS);
			res.end(page("Not found", "Nothing to see here."));
			return;
		}
		if (settled) {
			res.writeHead(200, HTML_HEADERS);
			res.end(DONE_PAGE);
			return;
		}

		// STRICT state validation FIRST, for success AND error callbacks alike
		// (RFC 6749 section 4.1.2.1 requires `state` in error redirects too).
		// A mismatched/missing state is treated as an unexpected request and
		// deliberately does NOT settle: neither a forged error= callback nor a
		// forged code may abort or complete someone's pending login, and the
		// accompanying code (if any) is never handed to the caller, so no
		// token exchange can happen for a forged/replayed callback.
		const state = url.searchParams.get("state");
		if (state !== expectedState) {
			res.writeHead(400, HTML_HEADERS);
			res.end(page("Unexpected request", "This request did not match a pending sign-in."));
			return;
		}

		const errorParam = url.searchParams.get("error");
		if (errorParam !== null) {
			res.writeHead(200, HTML_HEADERS);
			res.end(FAILURE_PAGE);
			const description = url.searchParams.get("error_description");
			settle(
				new OAuthCallbackError(
					sanitizeForTerminal(errorParam) || "unknown_error",
					description ? sanitizeForTerminal(description) : null,
				),
			);
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) {
			res.writeHead(400, HTML_HEADERS);
			res.end(FAILURE_PAGE);
			settle(new Error("Login callback carried no authorization code."));
			return;
		}

		res.writeHead(200, HTML_HEADERS);
		res.end(SUCCESS_PAGE);
		settle({ code });
	});

	// Refuse to linger: once the single callback settles the login, keep-alive
	// sockets must not hold the process open.
	server.keepAliveTimeout = 1000;

	return new Promise<LoopbackServer>((resolve, reject) => {
		server.once("error", reject);
		// STRICT loopback bind: 127.0.0.1 only (never 0.0.0.0/::), ephemeral port.
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Loopback server failed to report a bound port"));
				server.close();
				return;
			}
			const port = address.port;
			resolve({
				port,
				redirectUri: `http://127.0.0.1:${port}/callback`,
				waitForCallback: (timeoutMs: number) => {
					return new Promise<{ code: string }>((resolveWait, rejectWait) => {
						const timer = setTimeout(() => {
							settle(
								new Error(
									`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser login callback.`,
								),
							);
						}, timeoutMs);
						timer.unref();
						callbackPromise
							.then((value) => {
								clearTimeout(timer);
								resolveWait(value);
							})
							.catch((err: Error) => {
								clearTimeout(timer);
								rejectWait(err);
							});
					});
				},
				close: () =>
					new Promise<void>((resolveClose) => {
						server.close(() => resolveClose());
						// Node >= 18.2 only; on older 18.x the short keepAliveTimeout
						// set above still lets close() finish promptly.
						if (typeof server.closeAllConnections === "function") {
							server.closeAllConnections();
						}
					}),
			});
		});
	});
}
