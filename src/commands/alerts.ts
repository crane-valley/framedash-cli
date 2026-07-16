import { parseNumber, parsePositiveInt } from "../lib/config.js";
import { formatOutput } from "../lib/formatters.js";
import { error, log, success } from "../lib/logger.js";
import { runCommand, withSubcommands } from "../lib/run-command.js";

const HELP = `Usage: framedash alerts <subcommand> [options]

Manage alert rules.

Subcommands:
  list                   List alert rules
  create                 Create a new alert rule
  update <id>            Update an alert rule
  delete <id>            Deactivate an alert rule (soft-delete; reactivate with
                         'alerts update <id> --is-active true')

Run 'framedash alerts <subcommand> --help' for more info.`;

const CREATE_HELP = `Usage: framedash alerts create [options]

Create a new alert rule.

Required:
  --name <name>                    Alert rule name
  --map-id <uuid>                  Map ID (list IDs with 'framedash maps list')
  --metric <metric>                Metric name
  --threshold-level <level>        Threshold level
  --fail-percentage <n>            Failure percentage (0-100)
  --evaluation-days <n>            Evaluation period in days
  --cell-size <n>                  Cell size
  --cooldown-minutes <n>           Cooldown period in minutes

One of the following is required:
  --threshold-profile-ids <ids>    Threshold profile IDs (comma-separated, up to 10)
  --threshold-profile-id <uuid>    Threshold profile ID (single-profile bundle)
                                   (list IDs with 'framedash threshold-profiles list')

Optional:
  --channel-ids <id1,id2,...>      Notification channel IDs (comma-separated)`;

export const alerts = withSubcommands("alerts", HELP, {
	list: alertsList,
	create: alertsCreate,
	update: alertsUpdate,
	delete: alertsDelete,
});

async function alertsList(args: string[]): Promise<void> {
	await runCommand(
		{ args, help: "Usage: framedash alerts list [--format json|table|csv] [global options]" },
		async ({ client, config }) => {
			const data = await client.get(client.projectPath("alerts"));
			log(formatOutput(data, config.format));
		},
	);
}

async function alertsCreate(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: CREATE_HELP,
			options: {
				name: { type: "string" },
				"map-id": { type: "string" },
				"threshold-profile-id": { type: "string" },
				"threshold-profile-ids": { type: "string" },
				metric: { type: "string" },
				"threshold-level": { type: "string" },
				"fail-percentage": { type: "string" },
				"evaluation-days": { type: "string" },
				"cell-size": { type: "string" },
				"cooldown-minutes": { type: "string" },
				"channel-ids": { type: "string" },
			},
		},
		async ({ client, config, values }) => {
			const required = [
				"name",
				"map-id",
				"metric",
				"threshold-level",
				"fail-percentage",
				"evaluation-days",
				"cell-size",
				"cooldown-minutes",
			] as const;

			for (const flag of required) {
				if (!values[flag]) {
					error(`--${flag} is required`);
					process.exit(1);
				}
			}
			if (!values["threshold-profile-id"] && !values["threshold-profile-ids"]) {
				error("--threshold-profile-id or --threshold-profile-ids is required");
				process.exit(1);
			}

			const body: Record<string, unknown> = {
				name: values.name,
				mapId: values["map-id"],
				metric: values.metric,
				thresholdLevel: values["threshold-level"],
				failPercentage: parseNumber(values["fail-percentage"] as string, "fail-percentage"),
				evaluationDays: parsePositiveInt(values["evaluation-days"] as string, "evaluation-days"),
				cellSize: parsePositiveInt(values["cell-size"] as string, "cell-size"),
				cooldownMinutes: parsePositiveInt(values["cooldown-minutes"] as string, "cooldown-minutes"),
			};
			if (values["threshold-profile-ids"]) {
				body.thresholdProfileIds = parseIds(
					values["threshold-profile-ids"] as string,
					"threshold-profile-ids",
				);
			} else {
				body.thresholdProfileId = values["threshold-profile-id"];
			}

			if (values["channel-ids"]) {
				body.channelIds = parseIds(values["channel-ids"] as string, "channel-ids");
			}

			const data = await client.post(client.projectPath("alerts"), body);
			success("Alert rule created");
			log(formatOutput(data, config.format));
		},
	);
}

async function alertsUpdate(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash alerts update <alert-id> [--name ...] [--threshold-profile-id id | --threshold-profile-ids id1,id2] [--is-active true|false] [--channel-ids id1,id2]",
			options: {
				name: { type: "string" },
				"is-active": { type: "string" },
				"channel-ids": { type: "string" },
				"threshold-profile-id": { type: "string" },
				"threshold-profile-ids": { type: "string" },
				"fail-percentage": { type: "string" },
				"evaluation-days": { type: "string" },
				"cooldown-minutes": { type: "string" },
			},
			allowPositionals: true,
		},
		async ({ client, config, values, positionals }) => {
			const alertId = positionals[0];
			if (!alertId) {
				error("Alert ID is required: framedash alerts update <alert-id>");
				process.exit(1);
			}

			const body: Record<string, unknown> = {};
			if (values.name) body.name = values.name;
			if (values["is-active"]) {
				const v = values["is-active"] as string;
				if (v !== "true" && v !== "false") {
					error(`--is-active must be "true" or "false", got: ${v}`);
					process.exit(1);
				}
				body.isActive = v === "true";
			}
			if (values["threshold-profile-ids"])
				body.thresholdProfileIds = parseIds(
					values["threshold-profile-ids"] as string,
					"threshold-profile-ids",
				);
			else if (values["threshold-profile-id"])
				body.thresholdProfileId = values["threshold-profile-id"];
			if (values["channel-ids"])
				body.channelIds = parseIds(values["channel-ids"] as string, "channel-ids");
			if (values["fail-percentage"])
				body.failPercentage = parseNumber(values["fail-percentage"] as string, "fail-percentage");
			if (values["evaluation-days"])
				body.evaluationDays = parsePositiveInt(
					values["evaluation-days"] as string,
					"evaluation-days",
				);
			if (values["cooldown-minutes"])
				body.cooldownMinutes = parsePositiveInt(
					values["cooldown-minutes"] as string,
					"cooldown-minutes",
				);

			if (Object.keys(body).length === 0) {
				error("At least one field to update is required");
				process.exit(1);
			}

			const data = await client.patch(
				client.projectPath(`alerts/${encodeURIComponent(alertId)}`),
				body,
			);
			success("Alert rule updated");
			log(formatOutput(data, config.format));
		},
	);
}

async function alertsDelete(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash alerts delete <alert-id> [global options]\n\nDeactivates the alert rule (soft-delete: it stops firing and no longer counts\nagainst quota, but is retained and can be reactivated with\n'framedash alerts update <alert-id> --is-active true').",
			allowPositionals: true,
		},
		async ({ client, positionals }) => {
			const alertId = positionals[0];
			if (!alertId) {
				error("Alert ID is required: framedash alerts delete <alert-id>");
				process.exit(1);
			}

			await client.delete(client.projectPath(`alerts/${encodeURIComponent(alertId)}`));
			success(
				`Alert rule ${alertId} deactivated (reactivate with: framedash alerts update ${alertId} --is-active true)`,
			);
		},
	);
}

function parseIds(raw: string, flag: "channel-ids" | "threshold-profile-ids"): string[] {
	const ids = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (ids.length === 0) {
		error(`--${flag} must contain at least one ID`);
		process.exit(1);
	}
	return ids;
}
