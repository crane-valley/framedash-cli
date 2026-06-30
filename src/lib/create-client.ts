import { ApiClient, type ApiError } from "@framedash/api-client";
import { error } from "./logger.js";

/**
 * Create the CLI's API client. By default a request error prints a message and
 * exits the process (the right behavior for one-shot commands). Pass
 * `throwOnError` for a client used inside a retry loop (e.g. the run-profile-test
 * ingest poll), where a transient 429/5xx must be thrown and retried, not exit.
 */
export function createClient(
	baseUrl: string,
	apiKey: string,
	projectId: string,
	options?: { throwOnError?: boolean },
): ApiClient {
	if (options?.throwOnError) {
		return new ApiClient({
			baseUrl,
			apiKey,
			projectId,
			onError(err: ApiError): never {
				throw err;
			},
		});
	}
	return new ApiClient({
		baseUrl,
		apiKey,
		projectId,
		onError(err: ApiError): never {
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
		},
	});
}
