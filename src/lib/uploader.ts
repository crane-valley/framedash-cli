import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { assertSafeBaseUrl } from "@framedash/api-client";
import type { MapCaptureMetadata } from "./metadata.js";

/** Upload timeout: generous vs the JSON client since it streams an image blob. */
const UPLOAD_TIMEOUT_MS = 120_000;

const MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

export type UploadOptions = {
	metadata: MapCaptureMetadata;
	imagePath: string;
	apiKey: string;
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
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"X-API-Key": opts.apiKey,
			"X-Project-Id": opts.projectId,
		},
		body: formData,
		redirect: "manual",
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	});

	// Do not follow a redirect: fetch would re-send the X-API-Key header to the
	// redirect target (undici keeps custom headers across cross-origin redirects).
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
