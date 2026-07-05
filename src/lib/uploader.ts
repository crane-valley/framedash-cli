import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { assertSafeBaseUrl } from "@framedash/api-client";
import type { MapCaptureMetadata } from "./metadata.js";
import type { OAuthTokenManager } from "./oauth/manager.js";

/** Upload timeout: generous vs the JSON client since it streams an image blob. */
const UPLOAD_TIMEOUT_MS = 120_000;

const MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

/**
 * Upload credential: a project API key (X-API-Key) or the process-shared
 * OAuth token manager (Authorization: Bearer, refreshed via the same
 * rotation state every other client in this process uses).
 */
export type UploadCredential =
	| { kind: "api-key"; apiKey: string }
	| { kind: "oauth"; manager: OAuthTokenManager };

export type UploadOptions = {
	metadata: MapCaptureMetadata;
	imagePath: string;
	credential: UploadCredential;
	projectId: string;
	baseUrl: string;
};

export type UploadResult = {
	success: boolean;
	mapId: string;
	action: "created" | "updated";
};

/**
 * Upload a map image + metadata to the Framedash API.
 * Sends multipart/form-data to POST /api/v1/maps/upload.
 */
export async function uploadMapCapture(opts: UploadOptions): Promise<UploadResult> {
	assertSafeBaseUrl(opts.baseUrl);
	const imageBuffer = await readFile(opts.imagePath);
	const ext = extname(opts.imagePath).toLowerCase();
	const mimeType = MIME_MAP[ext];
	if (!mimeType) {
		throw new Error(`Unsupported image format: ${ext}`);
	}

	const formData = new FormData();
	formData.set("mapId", opts.metadata.map_id);
	formData.set("name", opts.metadata.map_id);
	formData.set("worldMinX", String(opts.metadata.world_bounds.min.x));
	formData.set("worldMinY", String(opts.metadata.world_bounds.min.y));
	formData.set("worldMaxX", String(opts.metadata.world_bounds.max.x));
	formData.set("worldMaxY", String(opts.metadata.world_bounds.max.y));
	formData.set("imageWidth", String(opts.metadata.image_dimensions.width));
	formData.set("imageHeight", String(opts.metadata.image_dimensions.height));

	const blob = new Blob([imageBuffer], { type: mimeType });
	formData.set("image", blob, basename(opts.imagePath));

	// Trim trailing slashes (as ApiClient does) so a base URL like
	// "https://host/" does not produce "https://host//api/..." -- the app would
	// 308-redirect the double slash, which redirect:"manual" below now rejects.
	const base = opts.baseUrl.replace(/\/+$/, "");
	const url = `${base}/api/v1/maps/upload`;

	const send = async (forceRefresh: boolean): Promise<Response> => {
		const authHeader: Record<string, string> =
			opts.credential.kind === "api-key"
				? { "X-API-Key": opts.credential.apiKey }
				: {
						Authorization: `Bearer ${
							forceRefresh
								? await opts.credential.manager.forceRefresh()
								: await opts.credential.manager.getAccessToken()
						}`,
					};
		return fetch(url, {
			method: "POST",
			headers: { ...authHeader, "X-Project-Id": opts.projectId },
			body: formData,
			redirect: "manual",
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
	};

	let response = await send(false);
	// Mirror the API client's OAuth 401 handling: refresh once and retry once
	// (the shared manager serializes rotation with every other client).
	if (response.status === 401 && opts.credential.kind === "oauth") {
		response = await send(true);
	}

	// Do not follow a redirect: fetch would re-send the credential header to
	// the redirect target -- undici keeps custom headers like X-API-Key across
	// CROSS-origin redirects (it strips only Authorization/Cookie there), and a
	// SAME-origin redirect re-sends the Authorization: Bearer token too.
	if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
		throw new Error(
			`Upload failed: unexpected redirect (status ${response.status || "opaque"}); refusing to resend credentials to the redirect target`,
		);
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Upload failed (${response.status}): ${body}`);
	}

	return (await response.json()) as UploadResult;
}
