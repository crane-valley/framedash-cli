import {
	type ApiBuildComparison,
	type EvaluateOptions,
	evaluateRegression,
} from "./perf-diff-eval.js";

export function comparisonReport(
	comparison: ApiBuildComparison,
	options: EvaluateOptions & {
		gateEnabled: boolean;
		days?: string;
		mapId?: string;
		platform?: string;
	},
) {
	const verdict = evaluateRegression(comparison, options);
	return {
		verdict,
		gate: {
			enabled: options.gateEnabled,
			statistic: "P50",
			metric: options.metric ?? "all",
			threshold_pct: options.thresholdPct ?? 0,
			status: !options.gateEnabled
				? "not_applied"
				: verdict.evaluated.length === 0
					? "no_comparable_data"
					: verdict.failed
						? "breached"
						: "within_threshold",
			evaluated_metrics: verdict.evaluated.map((diff) => diff.metric),
			breached_metrics: verdict.offenders.map((diff) => diff.metric),
		},
		comparisonContext: {
			days: Number(options.days || 30),
			map_id: options.mapId?.trim() || null,
			platform: options.platform?.trim() || null,
			fresh: true,
			ingestion_readiness: "not_verified",
			population:
				"Selected builds within the window and filters; sample/session counts do not verify expected samples or ingestion completion.",
			null_reason: "unknown",
		},
	};
}

export function formatComparisonReport(
	comparison: ApiBuildComparison,
	{ gate, comparisonContext }: ReturnType<typeof comparisonReport>,
): string {
	return `P50 comparison: ${comparisonContext.days} days; map=${comparisonContext.map_id ?? "all"}; platform=${comparisonContext.platform ?? "all"}; gate=${gate.status}; threshold=${gate.threshold_pct}%; metric=${gate.metric}. Baseline samples/sessions=${comparison.baseline?.sample_count ?? "unknown"}/${comparison.baseline?.session_count ?? "unknown"}; candidate=${comparison.candidate?.sample_count ?? "unknown"}/${comparison.candidate?.session_count ?? "unknown"}. isRegression is directional; ingestion readiness and expected samples are not verified; null causes are unknown.`;
}
