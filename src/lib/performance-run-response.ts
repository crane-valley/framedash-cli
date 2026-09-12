import {
	comparePerformanceRuns,
	isPerformanceRunId,
	PERFORMANCE_RUN_HITCH_THRESHOLDS,
	PERFORMANCE_RUN_MAX_SAMPLES,
	PERFORMANCE_RUN_METHOD,
	PERFORMANCE_RUN_MIN_SAMPLES,
	type PerformanceRunComparison,
} from "@framedash/api-client";
import { z } from "zod";

export const RUN_QUANTILES = ["p50", "p95", "p99"] as const;
const count = z.number().int().min(0).max(PERFORMANCE_RUN_MAX_SAMPLES);
const label = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			value.trim().length > 0 &&
			![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
	);
const timestamp = z.string().regex(/^[1-9][0-9]{0,17}$/);
const interval = (min: number) =>
	z
		.tuple([z.number().min(min).max(32768), z.number().min(min).max(32768)])
		.refine(([lower, upper]) => lower <= upper);
const observed = interval(0);
const signed = interval(-32768);
const quantiles = z
	.looseObject({ p50: observed, p95: observed, p99: observed })
	.refine((value) =>
		([0, 1] as const).every((i) => value.p50[i] <= value.p95[i] && value.p95[i] <= value.p99[i]),
	);
const deltas = z.looseObject({ p50: signed, p95: signed, p99: signed });
const metadata = z.looseObject({
	buildId: label,
	commit: label,
	branch: label,
	scenario: label,
	hardware: label,
	graphics: label,
	resolution: label,
	configuration: label,
	platform: label,
	engineVersion: label,
	sdkVersion: label,
	method: z.literal(PERFORMANCE_RUN_METHOD),
	warmupFrames: z.number().int().min(0).max(60000),
	targetFrames: count.min(PERFORMANCE_RUN_MIN_SAMPLES),
});
const hitches = z
	.array(
		z.looseObject({ thresholdMs: z.number(), count, per1000Frames: z.number().min(0).max(1000) }),
	)
	.length(4)
	.refine((values) =>
		values.every(
			(value, i) =>
				value.thresholdMs === PERFORMANCE_RUN_HITCH_THRESHOLDS[i] &&
				value.count <= (values[i - 1]?.count ?? PERFORMANCE_RUN_MAX_SAMPLES),
		),
	);

function consistentFrameEvidence(run: {
	samples: number;
	durationMs: number;
	quantiles: z.infer<typeof quantiles>;
	hitches: z.infer<typeof hitches>;
}) {
	const { samples, durationMs, quantiles: values } = run;
	const p50 = Math.ceil(samples * 0.5);
	const p95 = Math.ceil(samples * 0.95);
	const p99 = Math.ceil(samples * 0.99);
	const ranked = [
		{ rank: p50, interval: values.p50 },
		{ rank: p95, interval: values.p95 },
		{ rank: p99, interval: values.p99 },
	];
	const lowerBounds = [
		{ rank: 1, value: 0, exclusive: true },
		...ranked.map(({ rank, interval }) => ({ rank, value: interval[0], exclusive: false })),
		...run.hitches.map(({ count, thresholdMs }) => ({
			rank: samples - count + 1,
			value: thresholdMs,
			exclusive: true,
		})),
	];
	const upperBounds = [
		{ rank: samples, value: 32768, exclusive: true },
		...ranked.map(({ rank, interval }) => ({ rank, value: interval[1], exclusive: true })),
		...run.hitches.map(({ count, thresholdMs }) => ({
			rank: samples - count,
			value: thresholdMs,
			exclusive: false,
		})),
	];
	// Both measurements constrain the same sorted frames; separate totals miss intersections.
	const boundaries = [
		...new Set([
			1,
			samples + 1,
			...lowerBounds.map((bound) => bound.rank),
			...upperBounds.map((bound) => bound.rank + 1),
		]),
	]
		.filter((rank) => rank >= 1 && rank <= samples + 1)
		.sort((a, b) => a - b);
	let minimumDuration = 0;
	let maximumDuration = 0;
	for (const [index, start] of boundaries.entries()) {
		const end = boundaries[index + 1];
		if (end === undefined) break;
		const lower = lowerBounds.filter((bound) => bound.rank <= start);
		const upper = upperBounds.filter((bound) => bound.rank >= start);
		const minimum = Math.max(...lower.map((bound) => bound.value));
		const maximum = Math.min(...upper.map((bound) => bound.value));
		if (
			minimum > maximum ||
			(minimum === maximum &&
				(lower.some((bound) => bound.value === minimum && bound.exclusive) ||
					upper.some((bound) => bound.value === maximum && bound.exclusive)))
		)
			return false;
		const frames = end - start;
		minimumDuration += frames * minimum;
		maximumDuration += frames * maximum;
	}
	const tolerance = Math.max(1, durationMs * 0.000001);
	return durationMs + tolerance >= minimumDuration && durationMs - tolerance <= maximumDuration;
}

const complete = z
	.looseObject({
		status: z.literal("complete"),
		reasons: z.array(z.string()).length(0),
		metadata,
		startedAtUs: timestamp,
		endedAtUs: timestamp,
		samples: count.min(PERFORMANCE_RUN_MIN_SAMPLES),
		droppedSamples: z.literal(0),
		warmupSamples: count,
		durationMs: z.number().positive(),
		quantiles,
		hitches,
	})
	.refine(
		(run) =>
			run.samples === run.metadata.targetFrames &&
			run.warmupSamples === run.metadata.warmupFrames &&
			BigInt(run.endedAtUs) > BigInt(run.startedAtUs) &&
			run.durationMs - Math.max(1, run.durationMs * 0.000001) <=
				Number(BigInt(run.endedAtUs) - BigInt(run.startedAtUs)) / 1000 &&
			run.hitches.every(
				(hitch) =>
					hitch.count <= run.samples &&
					Math.abs(hitch.per1000Frames - (hitch.count * 1000) / run.samples) < 1e-9,
			),
	)
	.refine(consistentFrameEvidence);
const run = z
	.looseObject({
		runId: z.string().refine(isPerformanceRunId),
		status: z.enum(["missing", "incomplete", "invalid", "complete"]),
		reasons: z.array(z.string().min(1)),
		metadata: metadata.optional(),
		startedAtUs: timestamp.optional(),
		endedAtUs: timestamp.optional(),
		samples: count.optional(),
		droppedSamples: count.optional(),
		warmupSamples: count.max(60000).optional(),
		durationMs: z.number().min(0).optional(),
		quantiles: quantiles.optional(),
		hitches: hitches.optional(),
	})
	.refine((value) =>
		value.status === "complete" ? complete.safeParse(value).success : value.reasons.length > 0,
	);
const metric = z.looseObject({ baseline: observed, candidate: observed, deltaMs: signed });
const response = z.looseObject({
	status: z.enum(["comparable", "inconclusive"]),
	reasons: z.array(z.string().min(1)),
	baseline: run,
	candidate: run,
	repeat: run.optional(),
	windowDays: z.literal(7),
	quantiles: z.looseObject({ p50: metric, p95: metric, p99: metric }).optional(),
	repeatVariation: deltas.optional(),
});

type PerformanceRunResponse = PerformanceRunComparison & { windowDays: 7 } & (
		| { status: "comparable"; quantiles: NonNullable<PerformanceRunComparison["quantiles"]> }
		| { status: "inconclusive" }
	);

export function isPerformanceRunResponse(value: unknown): value is PerformanceRunResponse {
	const parsed = response.safeParse(value);
	if (!parsed.success) return false;
	const result = parsed.data;
	const expected = comparePerformanceRuns(result.baseline, result.candidate, result.repeat);
	if (result.status !== expected.status) return false;
	if (result.status === "inconclusive")
		return (
			result.reasons.length > 0 &&
			new Set(result.reasons).size === result.reasons.length &&
			expected.reasons.every((reason) => result.reasons.includes(reason)) &&
			!result.quantiles &&
			!result.repeatVariation
		);
	if (result.reasons.length || !result.quantiles) return false;
	const same = (a: number[] | undefined, b: number[] | undefined) =>
		a === undefined || b === undefined ? a === b : a[0] === b[0] && a[1] === b[1];
	return RUN_QUANTILES.every((q) => {
		const actual = result.quantiles?.[q];
		const calculated = expected.quantiles?.[q];
		return (
			same(actual?.baseline, calculated?.baseline) &&
			same(actual?.candidate, calculated?.candidate) &&
			same(actual?.deltaMs, calculated?.deltaMs) &&
			same(result.repeatVariation?.[q], expected.repeatVariation?.[q])
		);
	});
}
