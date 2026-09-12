import { isPerformanceRunId } from "@framedash/api-client";
import { formatOutput } from "../lib/formatters.js";
import { log } from "../lib/logger.js";
import { isPerformanceRunResponse, RUN_QUANTILES } from "../lib/performance-run-response.js";
import { runCommand } from "../lib/run-command.js";

const HELP = `Usage: framedash run-diff --baseline <run-uuid> --candidate <run-uuid> [options]

Compare bounded per-frame runs from the last 7 days. Requires analytics:read.
  --baseline <uuid>  Baseline run ID (not a build ID)
  --candidate <uuid> Candidate run ID
  --repeat <uuid>    Unchanged repeat of the baseline build and commit
  --format <fmt>     json (default), table, csv

Reports P50/P95/P99 intervals in milliseconds, exact hitch counts/rates, and
required-condition mismatches. A comparable result is not a regression verdict.
Exit 0: comparable report; 2: inconclusive evidence; 1: command/API error.
Existing perf-diff gates are unchanged.`;

export async function runDiff(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: HELP,
			options: {
				baseline: { type: "string" },
				candidate: { type: "string" },
				repeat: { type: "string" },
			},
		},
		async ({ client, config, values }) => {
			const { baseline, candidate, repeat } = values;
			const ids = [baseline, candidate, ...(repeat !== undefined ? [repeat] : [])];
			if (
				!isPerformanceRunId(baseline) ||
				!isPerformanceRunId(candidate) ||
				(repeat !== undefined && !isPerformanceRunId(repeat)) ||
				new Set(ids).size !== ids.length
			) {
				throw new Error(
					"--baseline, --candidate and optional --repeat must be distinct lowercase UUID v4 run IDs",
				);
			}
			const params = new URLSearchParams({ baseline, candidate, ...(repeat && { repeat }) });
			const result = await client.get<unknown>(
				client.projectPath(`performance-runs/compare?${params}`),
			);
			if (
				!isPerformanceRunResponse(result) ||
				result.baseline?.runId !== baseline ||
				result.candidate?.runId !== candidate ||
				result.repeat?.runId !== repeat
			)
				throw new Error("Unexpected response from performance-runs/compare");
			if (config.format === "json") log(formatOutput(result, "json"));
			else if (result.status === "inconclusive")
				log(
					formatOutput(
						[{ status: result.status, reasons: result.reasons.join("; ") }],
						config.format,
					),
				);
			else
				log(
					formatOutput(
						RUN_QUANTILES.map((metric) => ({
							metric,
							unit: "ms",
							baseline: result.quantiles[metric].baseline.join(".."),
							candidate: result.quantiles[metric].candidate.join(".."),
							delta: result.quantiles[metric].deltaMs.join(".."),
						})),
						config.format,
					),
				);
			if (result.status === "inconclusive") process.exitCode = 2;
		},
	);
}
