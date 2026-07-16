import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { GLOBAL_OPTIONS, resolveBaseAndFormat } from "../lib/config.js";
import { error, log, success } from "../lib/logger.js";
import { startLoopbackServer } from "../lib/oauth/loopback-server.js";
import {
	computeS256CodeChallenge,
	generateCodeVerifier,
	generateState,
} from "../lib/oauth/pkce.js";
import {
	CLI_OAUTH_CLIENT_ID,
	exchangeAuthorizationCode,
	OAuthTokenRequestError,
	revokeToken,
	toStoredEntry,
} from "../lib/oauth/token-endpoint.js";
import { credentialsFilePath, saveStoredEntry } from "../lib/oauth/token-store.js";

const HELP = `Usage: framedash login [options]

Sign in interactively via your browser (OAuth 2.1 authorization code + PKCE).
Tokens are stored in ${"~"}/.config/framedash/credentials.json (honors
XDG_CONFIG_HOME; the same path is used on Windows) and refreshed
automatically. Commands use the stored login only when no API key is given
(--api-key / --api-key-file / FRAMEDASH_API_KEY take precedence).

For CI and other non-interactive use, do NOT use login: set the
FRAMEDASH_API_KEY environment variable to a project API key instead.

Options:
  --scopes <scopes>      Space-delimited scopes to request
                         (default: analytics:read)
  --no-browser           Do not try to open the browser; print the URL only
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  -h, --help             Show help`;

/** Give the user five minutes to finish the browser consent. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** RFC 6749 scope tokens: printable ASCII except space, quote, backslash. */
const SCOPE_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Best-effort system browser launch; the URL is always printed as fallback.
 * Windows uses rundll32's FileProtocolHandler instead of `cmd /c start`
 * because start parses `&` (which every authorize URL contains) as a shell
 * operator unless escaped.
 */
function openBrowser(url: string): void {
	let command: string;
	let args: string[];
	if (process.platform === "win32") {
		command = "rundll32";
		args = ["url.dll,FileProtocolHandler", url];
	} else if (process.platform === "darwin") {
		command = "open";
		args = [url];
	} else {
		command = "xdg-open";
		args = [url];
	}
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			// Best effort: the printed URL is the fallback.
		});
		child.unref();
	} catch {
		// Best effort only.
	}
}

export async function login(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			...GLOBAL_OPTIONS,
			scopes: { type: "string" },
			"no-browser": { type: "boolean" },
		},
		allowPositionals: false,
	});

	if (values.help) {
		log(HELP);
		return;
	}

	const { baseUrl } = resolveBaseAndFormat(values as Record<string, unknown>);
	const origin = new URL(baseUrl).origin;

	// Normalize whitespace: trim, split on runs of any whitespace, and drop
	// empty tokens, so "a  b" or tab-separated input works. An empty token
	// list must fail explicitly ([].every() is vacuously true).
	const scopeList = (values.scopes ?? "analytics:read").trim().split(/\s+/).filter(Boolean);
	if (scopeList.length === 0 || !scopeList.every((scope) => SCOPE_RE.test(scope))) {
		error(`Invalid --scopes value. Use space-delimited scopes, e.g. "analytics:read".`);
		process.exit(1);
	}
	const scopes = scopeList.join(" ");

	const codeVerifier = generateCodeVerifier();
	const state = generateState();
	const server = await startLoopbackServer(state);
	try {
		const authorizeUrl = new URL("/oauth/authorize", origin);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", CLI_OAUTH_CLIENT_ID);
		authorizeUrl.searchParams.set("redirect_uri", server.redirectUri);
		authorizeUrl.searchParams.set("scope", scopes);
		authorizeUrl.searchParams.set("state", state);
		authorizeUrl.searchParams.set("code_challenge", computeS256CodeChallenge(codeVerifier));
		authorizeUrl.searchParams.set("code_challenge_method", "S256");

		log("Open this URL in your browser to sign in:");
		log("");
		log(`  ${authorizeUrl.toString()}`);
		log("");
		if (!values["no-browser"]) {
			openBrowser(authorizeUrl.toString());
		}
		success("Waiting for the browser sign-in to complete (5 minute timeout)...");

		const { code } = await server.waitForCallback(CALLBACK_TIMEOUT_MS);
		let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
		try {
			tokens = await exchangeAuthorizationCode(baseUrl, {
				code,
				codeVerifier,
				redirectUri: server.redirectUri,
			});
		} catch (err) {
			// A redirect_uri-mismatch invalid_grant almost always means the authorize
			// URL was altered before it opened (a proxy or the user swapping 127.0.0.1
			// for localhost), so the code was minted against a different host than the
			// exchange presents. Print the raw error FIRST, then the concrete fix, so
			// the ordering is not left to the top-level catch in index.ts.
			if (
				err instanceof OAuthTokenRequestError &&
				err.code === "invalid_grant" &&
				/redirect_uri/i.test(err.message)
			) {
				error(err.message);
				error(
					"This is a redirect_uri mismatch. Re-run 'framedash login' and open the printed " +
						"authorization URL EXACTLY as-is -- do not substitute localhost for 127.0.0.1 " +
						"(or vice versa) or route it through a proxy.",
				);
				// Signal failure via the exit code and unwind through `finally` so the
				// loopback server is closed before the process exits -- a direct
				// process.exit() here would skip that cleanup, and mocking it in tests
				// would diverge from production (the mock throws, running finally; the
				// real exit does not).
				process.exitCode = 1;
				return;
			}
			throw err;
		}
		// Last-writer-wins: of two racing logins for the same origin, the later
		// save is the one that sticks (see token-store.ts concurrency model).
		const entry = toStoredEntry(tokens);
		try {
			await saveStoredEntry(origin, entry);
		} catch (err) {
			// The exchange already minted a LIVE server-side grant, and we are
			// about to discard the only refresh token that could disconnect it
			// (ENOSPC/permissions on the save). Best-effort revoke so no orphaned
			// grant lingers on the server, then surface the original error.
			try {
				await revokeToken(baseUrl, tokens.refresh_token);
			} catch {
				// Best effort: the user can also revoke from Connected apps.
			}
			throw err;
		}

		success(`Logged in to ${origin}`);
		// Scope + expiry only -- NEVER print token values.
		log(`Scopes: ${entry.scope || "(none reported)"}`);
		log(`Access token expires: ${new Date(entry.expires_at).toISOString()}`);
		log(`Credentials stored in: ${credentialsFilePath()}`);
	} finally {
		await server.close();
	}
}
