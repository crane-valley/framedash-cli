import { buildBuildComparePath } from "@framedash/api-client";
import { formatOutput } from "../lib/formatters.js";
import { error, log, success } from "../lib/logger.js";
import {
	type ApiBuildComparison,
	evaluateRegression,
	formatMetricDiff,
	isRegressionMetric,
	loadTimeMapConflict,
	type RegressionMetric,
} from "../lib/perf-diff-eval.js";
import { runCommand } from "../lib/run-command.js";

export async function perfDiff(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: HELP,
			options: {
				baseline: { type: "string" },
				candidate: { type: "string" },
				metric: { type: "string" },
				days: { type: "string" },
				map: { type: "string" },
				platform: { type: "string" },
				threshold: { type: "string" },
				"fail-on-regression": { type: "boolean" },
			},
		},
		async ({ client, config, values }) => {
			// Trim so the local equality/required checks match the server (the route
			// trims too) and a stray-whitespace build id does not waste an API round-trip.
			const baseline = (values.baseline as string | undefined)?.trim();
			const candidate = (values.candidate as string | undefined)?.trim();
			if (!baseline || !candidate) {
				error("--baseline and --candidate are required (build IDs; see 'framedash builds')");
				process.exit(1);
			}
			// A build compared against itself is a zero diff that would pass the gate;
			// fail fast on a misconfigured CI (e.g. BASE_SHA == GITHUB_SHA).
			if (baseline === candidate) {
				error("--baseline and --candidate must be different build IDs");
				process.exit(1);
			}

			let metric: RegressionMetric | undefined;
			if (values.metric !== undefined) {
				const raw = (values.metric as string).trim();
				if (!isRegressionMetric(raw)) {
					error(
						`Invalid --metric '${raw}'. Allowed: frame_time, memory, gpu_time, io.read_bytes, io.read_time_ms, io.read_ops, load_time_ms`,
					);
					process.exit(1);
				}
				metric = raw;
			}

			// map_load rows have an empty map_id; a map-filtered load_time_ms compare
			// returns no rows and would wrongly trip the fail-closed gate.
			const mapConflict = loadTimeMapConflict(metric, values.map as string | undefined);
			if (mapConflict) {
				error(mapConflict);
				process.exit(1);
			}

			let thresholdPct = 0;
			if (values.threshold !== undefined) {
				thresholdPct = Number(values.threshold);
				if (!Number.isFinite(thresholdPct) || thresholdPct < 0) {
					error("--threshold must be a non-negative number (percent)");
					process.exit(1);
				}
			}

			const comparison = await client.get<ApiBuildComparison>(
				client.projectPath(
					buildBuildComparePath({
						baseline,
						candidate,
						days: values.days as string | undefined,
						mapId: values.map as string | undefined,
						platform: values.platform as string | undefined,
					}),
				),
			);

			// A non-error 2xx with a malformed body must not crash the gate with a raw
			// TypeError; fail closed with a clear message instead.
			if (!comparison || !Array.isArray(comparison.diffs)) {
				error("Unexpected response from the builds/compare API (no comparison data).");
				process.exit(1);
			}

			// Always print the comparison so CI logs carry the numbers. JSON gets the
			// full object (baseline/candidate stats + diffs); table/csv get the diff rows.
			if (config.format === "json") {
				log(formatOutput(comparison, "json"));
			} else {
				log(formatOutput(comparison.diffs, config.format));
			}

			if (!values["fail-on-regression"]) return;

			const verdict = evaluateRegression(comparison, { metric, thresholdPct });

			// Fail closed: if --fail-on-regression was requested but nothing was
			// comparable (wrong build IDs, or the chosen metric has no data on the
			// platform), do not let the build pass an unmeasured gate.
			if (verdict.evaluated.length === 0) {
				error(
					metric
						? `No comparable '${metric}' data between these builds; cannot evaluate a regression.`
						: "No comparable performance data between these builds; cannot evaluate a regression.",
				);
				process.exit(1);
			}

			if (verdict.failed) {
				error(
					`Performance regression detected (threshold ${thresholdPct}%): ${verdict.offenders
						.map(formatMetricDiff)
						.join("; ")}`,
				);
				process.exit(1);
			}

			success(
				`No performance regression beyond ${thresholdPct}% (${verdict.evaluated.length} metric(s) checked).`,
			);
		},
	);
}

const HELP = `Usage: framedash perf-diff --baseline <id> --candidate <id> [options]

Compare two builds' performance (P50/P95 frame time, memory, GPU time, disk io.*
read metrics, and map/level load time) and, with --fail-on-regression, exit
non-zero when the candidate regressed -- so a CI
job can gate a merge on a build-over-build performance regression. Build IDs are
whatever your SDK reported as build_id (set it from CI, e.g. the git SHA); list
them with 'framedash builds'.

Required:
  --baseline <id>        Known-good build_id to compare against
  --candidate <id>       New build_id under test

Options:
  --metric <name>        Gate on one metric only: frame_time, memory, gpu_time,
                         io.read_bytes, io.read_time_ms, io.read_ops, load_time_ms
                         (default: all). Lower is better; a positive % is a
                         regression. io.* need disk-IO tracking enabled in the SDK;
                         load_time_ms needs SDK map-load timing (BeginMapLoad/EndMapLoad).
  --threshold <pct>      Tolerate a regression up to this percent (default: 0 =
                         any worsening fails). e.g. --threshold 5 ignores <=5% noise.
  --fail-on-regression   Exit 1 if a regression beyond the threshold is found
                         (otherwise perf-diff only reports and exits 0)
  --days <n>             Time period in days: 7, 14, 30, 90 (default: 30)
  --map <id>             Restrict the comparison to one map. NOT valid with
                         --metric load_time_ms (map_load rows carry an empty
                         map_id; use the dashboard per-map breakdown instead).
  --platform <name>      Restrict the comparison to one platform
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help

Example (GitHub Actions gate):
  framedash perf-diff --baseline "$BASE_SHA" --candidate "$GITHUB_SHA" \\
    --threshold 5 --fail-on-regression`;
