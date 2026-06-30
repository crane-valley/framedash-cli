import { describe, expect, it } from "vitest";
import {
	type ApiBuildComparison,
	type ApiMetricDiff,
	evaluateRegression,
	formatMetricDiff,
	isRegressionMetric,
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

describe("isRegressionMetric", () => {
	it("accepts the three known metrics", () => {
		expect(isRegressionMetric("frame_time")).toBe(true);
		expect(isRegressionMetric("memory")).toBe(true);
		expect(isRegressionMetric("gpu_time")).toBe(true);
	});

	it("rejects unknown metrics", () => {
		expect(isRegressionMetric("fps")).toBe(false);
		expect(isRegressionMetric("")).toBe(false);
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
