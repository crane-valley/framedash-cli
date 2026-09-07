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

function printAndExit(err: ApiError): never {
	if (err.status === 429) {
		const retryAfter = err.retryAfter;
		if (retryAfter !== undefined) {
			error(`Rate limit exceeded (429). Retry after ${retryAfter}s.`);
		} else {
			const reset = err.headers.get("X-RateLimit-Reset");
			const resetNum = reset ? Number(reset) : Number.NaN;
			// The server (apps/web/src/lib/api-rate-limit.ts, setRateLimitHeaders)
			// emits this header as a millisecond unix timestamp, not seconds --
			// parse it directly, no *1000 conversion.
			const resetStr =
				!Number.isNaN(resetNum) && resetNum > 0
					? new Date(resetNum).toLocaleTimeString()
					: "unknown";
			error(`Rate limit exceeded (429). Resets at ${resetStr}.`);
		}
	} else {
		error(err.message);
	}
	process.exit(1);
}

/**
 * One-shot commands exit on request errors, but a retry loop must receive transient 429/5xx
 * failures as exceptions. Both client modes share OAuth rotation state so a refresh token is
 * consumed only once.
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
		return new ApiClient({
			baseUrl,
			apiKey: credential.apiKey,
			projectId,
			queryTimeoutMs: 120_000,
			onError,
		});
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
			queryTimeoutMs: 120_000,
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
		throw err;
	}
}

function isApiError(err: unknown): err is ApiError {
	return err instanceof ApiError;
}
