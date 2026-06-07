import { z } from "zod";

// Canonical source: ingest-core/src/config.ts MAX_MAP_ID_LEN
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

/**
 * Zod schema for the JSON sidecar metadata file produced by
 * engine capture scripts (UE5 Commandlet / Unity EditorScript).
 *
 * Matches brief-tech.md Section 8.4 format.
 */
export const mapCaptureMetadataSchema = z.object({
	version: z.literal("1.0"),
	map_id: z.string().min(1).max(MAX_MAP_ID_LEN),
	image_path: z.string().min(1),
	image_dimensions: dimensionsSchema,
	world_bounds: worldBoundsSchema,
	projection: z.string().optional(),
	capture_axis: z.string().optional(),
	coordinate_system: z.string().optional(),
	engine: z.string().optional(),
	build_id: z.string().max(255).optional(),
	captured_at: z.string().datetime().optional(),
});

export type MapCaptureMetadata = z.infer<typeof mapCaptureMetadataSchema>;
