import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapCaptureMetadata } from "../lib/metadata.js";
import { uploadMapCapture } from "../lib/uploader.js";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
}));

function baseMetadata(): MapCaptureMetadata {
	return {
		version: "1.0",
		map_id: "level-1",
		image_path: "level-1.png",
		image_dimensions: { width: 16, height: 16 },
		world_bounds: { min: { x: -10, y: -2, z: -30 }, max: { x: 10, y: 8, z: 40 } },
	};
}

async function uploadAndCaptureForm(metadata: MapCaptureMetadata): Promise<FormData> {
	const fetchMock = vi.fn().mockResolvedValue({
		status: 200,
		ok: true,
		type: "default",
		headers: new Headers(),
		json: async () => ({ success: true, mapId: metadata.map_id, action: "created" }),
		text: async () => "",
	});
	vi.stubGlobal("fetch", fetchMock);
	await uploadMapCapture({
		metadata,
		imagePath: "level-1.png",
		credential: { kind: "api-key", apiKey: "fd_admin_test" },
		projectId: "proj-1",
		baseUrl: "https://app.framedash.dev",
	});
	return (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
}

describe("uploadMapCapture map axes", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("sends X/Y ground bounds and no upAxis for a sidecar without up_axis", async () => {
		const form = await uploadAndCaptureForm(baseMetadata());

		expect(form.get("worldMinY")).toBe("-2");
		expect(form.get("worldMaxY")).toBe("8");
		expect(form.has("upAxis")).toBe(false);
	});

	it("sends engine Z as the ground Y bounds for a Y-up sidecar", async () => {
		const form = await uploadAndCaptureForm({ ...baseMetadata(), version: "1.1", up_axis: "y" });

		expect(form.get("upAxis")).toBe("y");
		expect(form.get("worldMinX")).toBe("-10");
		expect(form.get("worldMaxX")).toBe("10");
		expect(form.get("worldMinY")).toBe("-30");
		expect(form.get("worldMaxY")).toBe("40");
	});

	it("sends an explicit Z-up axis so a map can be switched back", async () => {
		const form = await uploadAndCaptureForm({ ...baseMetadata(), version: "1.1", up_axis: "z" });

		expect(form.get("upAxis")).toBe("z");
		expect(form.get("worldMinY")).toBe("-2");
	});
});
