import { describe, expect, it } from "vitest";
import {
	type ApiBuildComparison,
	type ApiMetricDiff,
	evaluateRegression,
	formatMetricDiff,
	isRegressionMetric,
	loadTimeMapConflict,
} from "./perf-diff-eval.js";

function diff(metric: ApiMetricDiff["metric"], diffPct: number | null): ApiMetricDiff {
	return {
		metric,
		baselineP50: 10,
		candidateP50: diffPct === null ? null : 10 * (1 + diffPct / 100),
		diffPct,
		isRegression: diffPct !== null && diffPct > 0,
		baselineTail: 20,
		candidateTail: 20,
	};
}

function comparison(diffs: ApiMetricDiff[]): ApiBuildComparison {
	return { baseline: { build_id: "base" }, candidate: { build_id: "cand" }, diffs };
}

/** A zero-baseline diff row: percent change is undefined (null) but the raw P50s
 * carry the "0 -> candidate" movement the gate must still evaluate. */
function zeroBaselineDiff(metric: ApiMetricDiff["metric"], candidateP50: number): ApiMetricDiff {
	return {
		metric,
		baselineP50: 0,
		candidateP50,
		diffPct: null,
		isRegression: candidateP50 > 0,
		baselineTail: 0,
		candidateTail: candidateP50,
	};
}

describe("isRegressionMetric", () => {
	it("accepts the core performance metrics", () => {
		expect(isRegressionMetric("frame_time")).toBe(true);
		expect(isRegressionMetric("memory")).toBe(true);
		expect(isRegressionMetric("gpu_time")).toBe(true);
	});

	it("accepts the disk io.* metrics", () => {
		expect(isRegressionMetric("io.read_bytes")).toBe(true);
		expect(isRegressionMetric("io.read_time_ms")).toBe(true);
		expect(isRegressionMetric("io.read_ops")).toBe(true);
	});

	it("accepts the map load-time metric", () => {
		expect(isRegressionMetric("load_time_ms")).toBe(true);
	});

	it("rejects unknown metrics", () => {
		expect(isRegressionMetric("fps")).toBe(false);
		expect(isRegressionMetric("io.write_bytes")).toBe(false);
		expect(isRegressionMetric("")).toBe(false);
	});
});

describe("loadTimeMapConflict", () => {
	it("rejects --metric load_time_ms combined with --map", () => {
		const msg = loadTimeMapConflict("load_time_ms", "arena");
		expect(msg).not.toBeNull();
		expect(msg).toContain("empty map_id");
	});

	it("ignores a whitespace-only --map value (treated as absent)", () => {
		expect(loadTimeMapConflict("load_time_ms", "   ")).toBeNull();
	});

	it("allows load_time_ms without --map", () => {
		expect(loadTimeMapConflict("load_time_ms", undefined)).toBeNull();
	});

	it("allows --map with any other metric", () => {
		expect(loadTimeMapConflict("frame_time", "arena")).toBeNull();
		expect(loadTimeMapConflict("io.read_bytes", "arena")).toBeNull();
	});

	it("allows --map when no metric filter is set (gates all metrics)", () => {
		expect(loadTimeMapConflict(undefined, "arena")).toBeNull();
	});
});

describe("evaluateRegression", () => {
	it("passes when the candidate improved (negative diffPct)", () => {
		const v = evaluateRegression(comparison([diff("frame_time", -5)]));
		expect(v.failed).toBe(false);
		expect(v.offenders).toHaveLength(0);
		expect(v.evaluated).toHaveLength(1);
	});

	it("fails when any metric regressed beyond the default 0 threshold", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 4)]));
		expect(v.failed).toBe(true);
		expect(v.offenders.map((o) => o.metric)).toEqual(["frame_time"]);
	});

	it("tolerates a regression within the threshold", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 3)]), { thresholdPct: 5 });
		expect(v.failed).toBe(false);
		expect(v.evaluated).toHaveLength(1);
	});

	it("fails when a regression exceeds the threshold", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 6)]), { thresholdPct: 5 });
		expect(v.failed).toBe(true);
	});

	it("treats exactly-at-threshold as not a failure (strictly greater fails)", () => {
		const v = evaluateRegression(comparison([diff("memory", 5)]), { thresholdPct: 5 });
		expect(v.failed).toBe(false);
	});

	it("gates only the requested metric", () => {
		const v = evaluateRegression(comparison([diff("frame_time", -1), diff("memory", 20)]), {
			metric: "frame_time",
		});
		expect(v.failed).toBe(false);
		expect(v.evaluated.map((d) => d.metric)).toEqual(["frame_time"]);
	});

	it("flags every regressing metric when no metric filter is given", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 2), diff("memory", 8)]));
		expect(v.failed).toBe(true);
		expect(v.offenders.map((o) => o.metric).sort()).toEqual(["frame_time", "memory"]);
	});

	it("gates on an io.* disk metric like any other lower-is-better metric", () => {
		const v = evaluateRegression(comparison([diff("io.read_bytes", 12)]), {
			metric: "io.read_bytes",
		});
		expect(v.failed).toBe(true);
		expect(v.offenders.map((o) => o.metric)).toEqual(["io.read_bytes"]);
	});

	it("fails a zero-baseline io.* metric that went positive (regression from zero)", () => {
		const v = evaluateRegression(comparison([zeroBaselineDiff("io.read_bytes", 1_048_576)]));
		expect(v.failed).toBe(true);
		expect(v.offenders.map((o) => o.metric)).toEqual(["io.read_bytes"]);
		expect(v.evaluated).toHaveLength(1);
	});

	it("gates on load_time_ms like any other lower-is-better metric", () => {
		const v = evaluateRegression(comparison([diff("load_time_ms", 15)]), {
			metric: "load_time_ms",
		});
		expect(v.failed).toBe(true);
		expect(v.offenders.map((o) => o.metric)).toEqual(["load_time_ms"]);
	});

	it("fails a zero-baseline load_time_ms that went positive (regression from zero)", () => {
		const v = evaluateRegression(comparison([zeroBaselineDiff("load_time_ms", 1200)]));
		expect(v.failed).toBe(true);
		expect(v.offenders.map((o) => o.metric)).toEqual(["load_time_ms"]);
		expect(v.evaluated).toHaveLength(1);
	});

	it("fails a zero-baseline regression regardless of the threshold (infinite worsening)", () => {
		const v = evaluateRegression(comparison([zeroBaselineDiff("io.read_bytes", 5)]), {
			thresholdPct: 1000,
		});
		expect(v.failed).toBe(true);
	});

	it("does not fail an unchanged zero-baseline metric (0 -> 0) but counts it as evaluated", () => {
		const v = evaluateRegression(comparison([zeroBaselineDiff("io.read_ops", 0)]));
		expect(v.failed).toBe(false);
		expect(v.offenders).toHaveLength(0);
		expect(v.evaluated).toHaveLength(1);
	});

	it("skips metrics with a null diffPct (not comparable)", () => {
		const v = evaluateRegression(comparison([diff("gpu_time", null)]));
		expect(v.failed).toBe(false);
		expect(v.evaluated).toHaveLength(0);
		expect(v.offenders).toHaveLength(0);
	});

	it("reports no evaluated metrics when the requested metric has no data", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 5), diff("gpu_time", null)]), {
			metric: "gpu_time",
		});
		expect(v.evaluated).toHaveLength(0);
		expect(v.failed).toBe(false);
	});

	it("clamps a non-finite threshold to 0 (fails safe, gate stays strict)", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 2)]), {
			thresholdPct: Number.NaN,
		});
		expect(v.failed).toBe(true);
		const inf = evaluateRegression(comparison([diff("frame_time", 2)]), {
			thresholdPct: Number.POSITIVE_INFINITY,
		});
		expect(inf.failed).toBe(true);
	});

	it("clamps a negative threshold to 0", () => {
		const v = evaluateRegression(comparison([diff("frame_time", 2)]), { thresholdPct: -10 });
		expect(v.failed).toBe(true);
	});

	it("does not crash on a malformed comparison (missing diffs)", () => {
		const v = evaluateRegression({} as ApiBuildComparison);
		expect(v.failed).toBe(false);
		expect(v.evaluated).toHaveLength(0);
		expect(v.offenders).toHaveLength(0);
	});

	it("skips a diff whose diffPct is undefined (not just null)", () => {
		const malformed = { ...diff("frame_time", 0), diffPct: undefined } as unknown as ApiMetricDiff;
		const v = evaluateRegression(comparison([malformed]));
		expect(v.evaluated).toHaveLength(0);
		expect(v.failed).toBe(false);
	});
});

describe("formatMetricDiff", () => {
	it("formats a regression with a + sign and one decimal", () => {
		expect(formatMetricDiff(diff("frame_time", 4))).toBe("frame_time: +4.0% (P50 10.00 -> 10.40)");
	});

	it("formats an improvement with a - sign", () => {
		expect(formatMetricDiff(diff("frame_time", -5))).toBe("frame_time: -5.0% (P50 10.00 -> 9.50)");
	});

	it("reports no comparable data when diffPct is null", () => {
		expect(formatMetricDiff(diff("gpu_time", null))).toBe("gpu_time: no comparable data");
	});

	it("describes a zero-baseline regression instead of 'no comparable data'", () => {
		expect(formatMetricDiff(zeroBaselineDiff("io.read_bytes", 1_048_576))).toBe(
			"io.read_bytes: baseline 0 -> 1048576.00 (regression from zero)",
		);
	});

	it("reports no comparable data (no crash) when diffPct is undefined", () => {
		const malformed = { ...diff("gpu_time", 0), diffPct: undefined } as unknown as ApiMetricDiff;
		expect(formatMetricDiff(malformed)).toBe("gpu_time: no comparable data");
	});

	it("renders n/a (no crash) when a P50 value is missing", () => {
		const malformed = {
			...diff("frame_time", 4),
			baselineP50: undefined,
		} as unknown as ApiMetricDiff;
		expect(formatMetricDiff(malformed)).toBe("frame_time: +4.0% (P50 n/a -> 10.40)");
	});
});
