import type { Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveApiKey } from "../lib/config.js";
import { error, log, success } from "../lib/logger.js";
import { mapCaptureMetadataSchema } from "../lib/metadata.js";
import { uploadMapCapture } from "../lib/uploader.js";

const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const MAP_CAPTURE_HELP = `Usage: framedash map-capture [options]

Upload captured map images and metadata to Framedash SaaS.

Reads JSON sidecar metadata files from --input-dir, validates them,
and optionally uploads the associated images to the Framedash API.

Required:
  --input-dir <path>     Directory containing JSON metadata files and images

Upload options (all required together):
  --upload               Enable upload to Framedash API
  --api-key <key>        Admin API key. Prefer FRAMEDASH_API_KEY env or
                         --api-key-file: a key passed as --api-key is visible
                         in the process list and shell history.
  --api-key-file <path>  Read the admin API key from a file ('-' for stdin)
  --project-id <uuid>    Target project ID, or set FRAMEDASH_PROJECT_ID env

Optional:
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --dry-run              Validate files without uploading

Examples:
  # Validate metadata files only
  framedash map-capture --input-dir ./captures --dry-run

  # Upload to Framedash (key from env, not the command line)
  FRAMEDASH_API_KEY=... FRAMEDASH_PROJECT_ID=... \\
  framedash map-capture --input-dir ./captures --upload`;

/** CLI entry point for map-capture — parses args then delegates to mapCapture(). */
export async function mapCaptureCommand(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"input-dir": { type: "string" },
			"api-key": { type: "string" },
			"api-key-file": { type: "string" },
			"project-id": { type: "string" },
			"base-url": { type: "string", default: "https://app.framedash.dev" },
			upload: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
	});

	if (values.help) {
		log(MAP_CAPTURE_HELP);
		return;
	}

	// Resolve the API key only when an upload will actually run, so a validation
	// dry run with --api-key-file - does not block on stdin (or fail on a missing
	// file) for a key it never uses.
	const willUpload = Boolean(values.upload) && !values["dry-run"];
	const result = await mapCapture({
		inputDir: values["input-dir"],
		upload: values.upload,
		dryRun: values["dry-run"],
		apiKey: willUpload ? resolveApiKey(values) : undefined,
		projectId: values["project-id"] ?? process.env.FRAMEDASH_PROJECT_ID,
		baseUrl: values["base-url"] ?? "https://app.framedash.dev",
	});
	if (!result.ok) {
		process.exit(1);
	}
}

export type MapCaptureOptions = {
	inputDir: string | undefined;
	upload: boolean | undefined;
	dryRun: boolean | undefined;
	apiKey: string | undefined;
	projectId: string | undefined;
	baseUrl: string | undefined;
};

export type MapCaptureResult = {
	ok: boolean;
	successCount: number;
	errorCount: number;
};

export async function mapCapture(opts: MapCaptureOptions): Promise<MapCaptureResult> {
	const fail = { ok: false, successCount: 0, errorCount: 0 } as const;

	if (!opts.inputDir) {
		error("--input-dir is required");
		return fail;
	}

	const upload = Boolean(opts.upload);
	const dryRun = Boolean(opts.dryRun);

	if (upload && !dryRun) {
		if (!opts.apiKey) {
			error("--api-key (or FRAMEDASH_API_KEY env) is required with --upload");
			return fail;
		}
		if (!opts.projectId) {
			error("--project-id (or FRAMEDASH_PROJECT_ID env) is required with --upload");
			return fail;
		}
	}

	const resolvedDir = resolve(opts.inputDir);

	let dirStat: Stats;
	try {
		dirStat = await stat(resolvedDir);
	} catch {
		error(`Input directory not found: ${resolvedDir}`);
		return fail;
	}
	if (!dirStat.isDirectory()) {
		error(`Not a directory: ${resolvedDir}`);
		return fail;
	}

	const files = await readdir(resolvedDir);
	const jsonFiles = files.filter((f) => f.endsWith(".json"));

	if (jsonFiles.length === 0) {
		error(`No JSON metadata files found in ${resolvedDir}`);
		return fail;
	}

	log(`Found ${jsonFiles.length} metadata file(s) in ${resolvedDir}`);

	const realInputDir = await realpath(resolvedDir);
	let successCount = 0;
	let errorCount = 0;

	for (const jsonFile of jsonFiles) {
		const jsonPath = join(resolvedDir, jsonFile);
		try {
			const raw = await readFile(jsonPath, "utf-8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				error(`${jsonFile}: Invalid JSON`);
				errorCount++;
				continue;
			}

			const result = mapCaptureMetadataSchema.safeParse(parsed);
			if (!result.success) {
				const issues = result.error.issues.map((i) => i.message).join("; ");
				error(`${jsonFile}: Invalid metadata \u2014 ${issues}`);
				errorCount++;
				continue;
			}

			const metadata = result.data;

			// Verify image file exists and is within input directory
			if (isAbsolute(metadata.image_path)) {
				error(`${jsonFile}: Absolute image paths are not allowed: ${metadata.image_path}`);
				errorCount++;
				continue;
			}
			const imagePath = await realpath(resolve(resolvedDir, metadata.image_path)).catch(() => null);
			if (!imagePath) {
				error(`${jsonFile}: Image not found: ${metadata.image_path}`);
				errorCount++;
				continue;
			}
			const rel = relative(realInputDir, imagePath);
			if (rel.startsWith("..") || isAbsolute(rel)) {
				error(`${jsonFile}: Image path escapes input directory: ${metadata.image_path}`);
				errorCount++;
				continue;
			}
			const imgStat = await stat(imagePath);
			if (!imgStat.isFile()) {
				error(`${jsonFile}: Image path is not a file: ${metadata.image_path}`);
				errorCount++;
				continue;
			}

			const imgExt = extname(imagePath).toLowerCase();
			if (!ALLOWED_IMAGE_EXTS.has(imgExt)) {
				error(`${jsonFile}: Unsupported image format: ${imgExt}`);
				errorCount++;
				continue;
			}

			if (dryRun) {
				success(
					`${jsonFile}: map_id=${metadata.map_id}, ` +
						`image=${metadata.image_path}, ` +
						`bounds=[${metadata.world_bounds.min.x},${metadata.world_bounds.min.y}]` +
						`→[${metadata.world_bounds.max.x},${metadata.world_bounds.max.y}], ` +
						`size=${metadata.image_dimensions.width}x${metadata.image_dimensions.height}`,
				);
				successCount++;
				continue;
			}

			if (upload) {
				const uploadResult = await uploadMapCapture({
					metadata,
					imagePath,
					apiKey: opts.apiKey as string,
					projectId: opts.projectId as string,
					baseUrl: opts.baseUrl ?? "https://app.framedash.dev",
				});
				success(
					`${metadata.map_id}: ${uploadResult.action} ` +
						`(${metadata.image_dimensions.width}x${metadata.image_dimensions.height})`,
				);
			} else {
				success(`${jsonFile}: Valid (map_id=${metadata.map_id})`);
			}

			successCount++;
		} catch (err) {
			error(`${jsonFile}: ${err instanceof Error ? err.message : String(err)}`);
			errorCount++;
		}
	}

	log("");
	log(`Done: ${successCount} succeeded, ${errorCount} failed`);
	return { ok: errorCount === 0, successCount, errorCount };
}
