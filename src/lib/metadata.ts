import { z } from "zod";

const MAX_MAP_ID_LEN = 128;

const dimensionsSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});

const vector3Schema = z.object({
	x: z.number().finite(),
	y: z.number().finite(),
	z: z.number().finite(),
});

const worldBoundsSchema = z
	.object({
		min: vector3Schema,
		max: vector3Schema,
	})
	.refine((b) => b.max.x > b.min.x && b.max.y > b.min.y, {
		message: "World max bounds must be greater than min bounds",
	});

export const mapCaptureMetadataSchema = z.object({
	version: z.literal("1.0"),
	// Zod 4.6 counts code points; the upload API limits map IDs in UTF-16 units.
	map_id: z
		.string()
		.min(1)
		.refine((value) => value.length <= MAX_MAP_ID_LEN),
	image_path: z.string().min(1),
	image_dimensions: dimensionsSchema,
	world_bounds: worldBoundsSchema,
	projection: z.string().optional(),
	capture_axis: z.string().optional(),
	coordinate_system: z.string().optional(),
	engine: z.string().optional(),
	build_id: z.string().max(255).optional(),
	// Zod 4.6 stopped accepting minute precision by default; earlier releases accepted it.
	captured_at: z.union([z.string().datetime(), z.string().datetime({ precision: -1 })]).optional(),
});

export type MapCaptureMetadata = z.infer<typeof mapCaptureMetadataSchema>;
