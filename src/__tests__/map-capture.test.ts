import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapCapture } from "../commands/map-capture.js";

// Capture stderr/stdout
const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

let tempDir: string;

function validSidecar(imagePath = "test.png") {
	return JSON.stringify({
		version: "1.0",
		map_id: "test_map",
		image_path: imagePath,
		image_dimensions: { width: 512, height: 512 },
		world_bounds: {
			min: { x: 0, y: 0, z: 0 },
			max: { x: 100, y: 100, z: 10 },
		},
	});
}

// Minimal 1x1 white PNG
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
	"base64",
);

import type { UploadCredential } from "../lib/uploader.js";

const defaultOpts = {
	inputDir: undefined as string | undefined,
	upload: false,
	dryRun: false,
	credential: undefined as UploadCredential | undefined,
	projectId: undefined as string | undefined,
	baseUrl: undefined as string | undefined,
	metadataPattern: undefined as string | undefined,
};

beforeEach(async () => {
	vi.clearAllMocks();
	tempDir = await mkdtemp(join(tmpdir(), "framedash-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("mapCapture", () => {
	it("returns failure when --input-dir is missing", async () => {
		const result = await mapCapture({ ...defaultOpts });
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("--input-dir is required"));
	});

	it("returns failure when input directory does not exist", async () => {
		const result = await mapCapture({
			...defaultOpts,
			inputDir: join(tempDir, "nonexistent"),
		});
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Input directory not found"));
	});

	it("returns failure when no JSON files found", async () => {
		const result = await mapCapture({ ...defaultOpts, inputDir: tempDir });
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(
			expect.stringContaining("No JSON metadata files found"),
		);
	});

	it("returns failure when --upload is set but no credential is available", async () => {
		await writeFile(join(tempDir, "map.json"), validSidecar());
		await writeFile(join(tempDir, "test.png"), TINY_PNG);

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			upload: true,
			projectId: "proj-1",
		});
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("--api-key"));
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("framedash login"));
	});

	it("returns failure when --upload is set but --project-id is missing", async () => {
		await writeFile(join(tempDir, "map.json"), validSidecar());
		await writeFile(join(tempDir, "test.png"), TINY_PNG);

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			upload: true,
			credential: { kind: "api-key", apiKey: "fd_admin_test" },
		});
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("--project-id"));
	});

	it("validates and reports in --dry-run mode", async () => {
		await writeFile(join(tempDir, "map.json"), validSidecar());
		await writeFile(join(tempDir, "test.png"), TINY_PNG);

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
		});
		expect(result).toEqual({ ok: true, successCount: 1, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("map_id=test_map"));
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("1 succeeded, 0 failed"));
	});

	it("reports invalid JSON gracefully", async () => {
		await writeFile(join(tempDir, "bad.json"), "not json {{{");

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
		});
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 1 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"));
	});

	it("reports invalid metadata schema", async () => {
		await writeFile(join(tempDir, "bad.json"), JSON.stringify({ version: "2.0" }));

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
		});
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 1 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Invalid metadata"));
	});

	it("reports missing image file", async () => {
		await writeFile(join(tempDir, "map.json"), validSidecar("missing.png"));

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
		});
		expect(result).toEqual({ ok: false, successCount: 0, errorCount: 1 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Image not found"));
	});

	it("handles multiple files with mixed success", async () => {
		// Valid file
		await writeFile(join(tempDir, "good.json"), validSidecar());
		await writeFile(join(tempDir, "test.png"), TINY_PNG);
		// Invalid file
		await writeFile(join(tempDir, "bad.json"), JSON.stringify({ version: "2.0" }));

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
		});
		expect(result).toEqual({ ok: false, successCount: 1, errorCount: 1 });
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("1 succeeded, 1 failed"));
	});

	it("filters unrelated JSON files with --metadata-pattern", async () => {
		await writeFile(join(tempDir, "level.capture.json"), validSidecar());
		await writeFile(join(tempDir, "package.json"), JSON.stringify({ private: true }));
		await writeFile(join(tempDir, "test.png"), TINY_PNG);

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
			metadataPattern: "*.capture.json",
		});

		expect(result).toEqual({ ok: true, successCount: 1, errorCount: 0 });
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("package.json"));
	});

	it("explains how to isolate metadata when unrelated JSON fails validation", async () => {
		await writeFile(join(tempDir, "package.json"), JSON.stringify({ private: true }));

		await mapCapture({ ...defaultOpts, inputDir: tempDir, dryRun: true });

		expect(stderrWrite).toHaveBeenCalledWith(
			expect.stringContaining("--metadata-pattern '*.capture.json'"),
		);
	});

	it("validates without uploading when neither --upload nor --dry-run", async () => {
		await writeFile(join(tempDir, "map.json"), validSidecar());
		await writeFile(join(tempDir, "test.png"), TINY_PNG);

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
		});
		expect(result).toEqual({ ok: true, successCount: 1, errorCount: 0 });
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Valid"));
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("1 succeeded, 0 failed"));
	});

	it("resolves image_path relative to input dir", async () => {
		// Create a subdirectory for images
		await mkdir(join(tempDir, "images"));
		await writeFile(join(tempDir, "images", "map.png"), TINY_PNG);
		await writeFile(join(tempDir, "map.json"), validSidecar("images/map.png"));

		const result = await mapCapture({
			...defaultOpts,
			inputDir: tempDir,
			dryRun: true,
		});
		expect(result).toEqual({ ok: true, successCount: 1, errorCount: 0 });
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("1 succeeded, 0 failed"));
	});
});
