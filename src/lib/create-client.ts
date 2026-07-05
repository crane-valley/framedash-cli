import { ApiClient, ApiError } from "@framedash/api-client";
import type { CliCredential } from "./config.js";
import { error } from "./logger.js";
import { OAuthLoginRequiredError, OAuthTokenManager } from "./oauth/manager.js";

export type CreateClientOptions = { throwOnError?: boolean };

/**
 * ONE token manager per origin per process. Refresh tokens are single-use
 * (rotation), so two independent managers over the same stored login would
 * race: the second to refresh presents an already-consumed token, which the
 * server treats as theft and answers by revoking the whole grant. Commands
 * that build several clients (e.g. run-profile-test's exit-on-error client
 * plus its throwing poll client) must therefore share rotation state.
 */
const managerCache = new Map<string, OAuthTokenManager>();

/** Test-only: drop cached managers so each test starts from its own entry. */
export function resetOAuthManagerCacheForTests(): void {
	managerCache.clear();
}

/**
 * Process-shared token manager for an origin. Also used by non-ApiClient
 * consumers (the map-capture uploader) so EVERY Bearer credential in the
 * process rides on the same rotation state.
 */
export function getSharedOAuthManager(
	baseUrl: string,
	credential: Extract<CliCredential, { kind: "oauth" }>,
): OAuthTokenManager {
	let manager = managerCache.get(credential.origin);
	if (!manager) {
		manager = new OAuthTokenManager(baseUrl, credential.origin, credential.entry);
		managerCache.set(credential.origin, manager);
	}
	return manager;
}

/** Print an ApiError (with 429 rate-limit detail) and exit -- the default for one-shot commands. */
function printAndExit(err: ApiError): never {
	if (err.status === 429) {
		const retryAfter = err.retryAfter;
		if (retryAfter !== undefined) {
			error(`Rate limit exceeded (429). Retry after ${retryAfter}s.`);
		} else {
			const reset = err.headers.get("X-RateLimit-Reset");
			const resetNum = reset ? Number(reset) : Number.NaN;
			const resetStr =
				!Number.isNaN(resetNum) && resetNum > 0
					? new Date(resetNum * 1000).toLocaleTimeString()
					: "unknown";
			error(`Rate limit exceeded (429). Resets at ${resetStr}.`);
		}
	} else {
		error(err.message);
	}
	process.exit(1);
}

/**
 * Create the CLI's API client from the resolved credential. By default a
 * request error prints a message and exits the process (the right behavior
 * for one-shot commands). Pass `throwOnError` for a client used inside a
 * retry loop (e.g. the run-profile-test ingest poll), where a transient
 * 429/5xx must be thrown and retried, not exit.
 *
 * API keys go on X-API-Key as before. A stored OAuth login gets a wrapper
 * that refreshes near expiry, retries exactly once after a 401, and persists
 * rotated refresh tokens.
 */
export function createClient(
	baseUrl: string,
	credential: CliCredential,
	projectId: string,
	options?: CreateClientOptions,
): ApiClient {
	const onError: (err: ApiError) => never = options?.throwOnError
		? (err): never => {
				throw err;
			}
		: printAndExit;

	if (credential.kind === "api-key") {
		return new ApiClient({ baseUrl, apiKey: credential.apiKey, projectId, onError });
	}

	return new OAuthApiClient(
		baseUrl,
		projectId,
		getSharedOAuthManager(baseUrl, credential),
		options,
	);
}

/**
 * ApiClient facade for the OAuth path. Extends ApiClient so the rest of the
 * CLI (typed against ApiClient) needs no changes, but every verb delegates
 * to a short-lived inner client carrying the CURRENT access token from the
 * token manager; the superclass instance itself never sends a request.
 *
 * 401 handling: refresh once, retry once. A second failure surfaces like any
 * other API error. A dead grant (refresh -> invalid_grant) always prints the
 * re-login instruction and exits, even in throwOnError mode -- retry loops
 * (which swallow thrown errors) must not spin on an unrecoverable credential.
 */
class OAuthApiClient extends ApiClient {
	constructor(
		private readonly oauthBaseUrl: string,
		private readonly oauthProjectId: string,
		private readonly manager: OAuthTokenManager,
		private readonly options?: CreateClientOptions,
	) {
		super({
			baseUrl: oauthBaseUrl,
			projectId: oauthProjectId,
			// Never sent: all verbs are overridden to use the inner client.
			accessToken: "oauth-managed-placeholder",
			onError: (err): never => {
				throw err;
			},
		});
	}

	override async get<T = unknown>(path: string): Promise<T> {
		return this.execute((client) => client.get<T>(path));
	}

	override async post<T = unknown>(path: string, body?: unknown): Promise<T> {
		return this.execute((client) => client.post<T>(path, body));
	}

	override async patch<T = unknown>(path: string, body: unknown): Promise<T> {
		return this.execute((client) => client.patch<T>(path, body));
	}

	override async delete<T = unknown>(path: string): Promise<T> {
		return this.execute((client) => client.delete<T>(path));
	}

	override withProject(projectId: string): ApiClient {
		return new OAuthApiClient(this.oauthBaseUrl, projectId, this.manager, this.options);
	}

	private buildInner(accessToken: string): ApiClient {
		return new ApiClient({
			baseUrl: this.oauthBaseUrl,
			projectId: this.oauthProjectId,
			accessToken,
			onError: (err): never => {
				throw err;
			},
		});
	}

	private async token(forceRefresh: boolean): Promise<string> {
		try {
			return forceRefresh ? await this.manager.forceRefresh() : await this.manager.getAccessToken();
		} catch (err) {
			if (err instanceof OAuthLoginRequiredError) {
				error(err.message);
				process.exit(1);
			}
			throw err;
		}
	}

	private async execute<T>(fn: (client: ApiClient) => Promise<T>): Promise<T> {
		const accessToken = await this.token(false);
		try {
			return await fn(this.buildInner(accessToken));
		} catch (err) {
			if (isApiError(err) && err.status === 401) {
				// The server rejected a token we believed valid (revoked access
				// token, clock skew): refresh and retry exactly once.
				const freshToken = await this.token(true);
				try {
					return await fn(this.buildInner(freshToken));
				} catch (retryErr) {
					return this.reportError(retryErr);
				}
			}
			return this.reportError(err);
		}
	}

	private reportError(err: unknown): never {
		if (isApiError(err) && !this.options?.throwOnError) {
			printAndExit(err);
		}
		// throwOnError mode, or a non-API failure (network error): propagate,
		// matching the api-key client (index.ts prints and exits).
		throw err;
	}
}

function isApiError(err: unknown): err is ApiError {
	return err instanceof ApiError;
}
