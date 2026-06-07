import { describe, expect, it } from "vitest";
import { mapCaptureMetadataSchema } from "../lib/metadata.js";

function validSidecar() {
	return {
		version: "1.0" as const,
		map_id: "de_dust2",
		image_path: "de_dust2_overhead.png",
		image_dimensions: { width: 4096, height: 4096 },
		world_bounds: {
			min: { x: -2400.0, y: -1200.0, z: 0.0 },
			max: { x: 2400.0, y: 1200.0, z: 500.0 },
		},
		projection: "orthographic",
		capture_axis: "top_down_z",
		coordinate_system: "left_handed_z_up",
		engine: "unreal_5.4",
		build_id: "abc123",
		captured_at: "2026-02-15T10:30:00Z",
	};
}

describe("mapCaptureMetadataSchema", () => {
	it("accepts a valid sidecar", () => {
		const result = mapCaptureMetadataSchema.safeParse(validSidecar());
		expect(result.success).toBe(true);
	});

	it("accepts minimal required fields only", () => {
		const result = mapCaptureMetadataSchema.safeParse({
			version: "1.0",
			map_id: "test_map",
			image_path: "test.png",
			image_dimensions: { width: 512, height: 512 },
			world_bounds: {
				min: { x: 0, y: 0, z: 0 },
				max: { x: 100, y: 100, z: 10 },
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects wrong version", () => {
		const data = { ...validSidecar(), version: "2.0" };
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects empty map_id", () => {
		const data = { ...validSidecar(), map_id: "" };
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects map_id exceeding 128 characters", () => {
		const data = { ...validSidecar(), map_id: "a".repeat(129) };
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects empty image_path", () => {
		const data = { ...validSidecar(), image_path: "" };
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects zero image width", () => {
		const data = {
			...validSidecar(),
			image_dimensions: { width: 0, height: 4096 },
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects negative image height", () => {
		const data = {
			...validSidecar(),
			image_dimensions: { width: 4096, height: -1 },
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects non-integer dimensions", () => {
		const data = {
			...validSidecar(),
			image_dimensions: { width: 4096.5, height: 4096 },
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects world bounds where max <= min (x)", () => {
		const data = {
			...validSidecar(),
			world_bounds: {
				min: { x: 100, y: 0, z: 0 },
				max: { x: 50, y: 100, z: 10 },
			},
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects world bounds where max <= min (y)", () => {
		const data = {
			...validSidecar(),
			world_bounds: {
				min: { x: 0, y: 100, z: 0 },
				max: { x: 100, y: 100, z: 10 },
			},
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects NaN in world bounds", () => {
		const data = {
			...validSidecar(),
			world_bounds: {
				min: { x: Number.NaN, y: 0, z: 0 },
				max: { x: 100, y: 100, z: 10 },
			},
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects Infinity in world bounds", () => {
		const data = {
			...validSidecar(),
			world_bounds: {
				min: { x: 0, y: 0, z: 0 },
				max: { x: Number.POSITIVE_INFINITY, y: 100, z: 10 },
			},
		};
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects invalid captured_at format", () => {
		const data = { ...validSidecar(), captured_at: "not-a-date" };
		const result = mapCaptureMetadataSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("rejects missing required fields", () => {
		const result = mapCaptureMetadataSchema.safeParse({});
		expect(result.success).toBe(false);
	});
});
