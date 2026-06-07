import { ApiClient, type ApiError } from "@framedash/api-client";
import { error } from "./logger.js";

export function createClient(baseUrl: string, apiKey: string, projectId: string): ApiClient {
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
