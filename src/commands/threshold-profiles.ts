import { formatOutput } from "../lib/formatters.js";
import { error, log, success } from "../lib/logger.js";
import { runCommand, withSubcommands } from "../lib/run-command.js";

const HELP = `Usage: framedash threshold-profiles <subcommand> [options]

List or create threshold profiles (performance budgets used by alert rules).

Subcommands:
  list                   List threshold profiles
  create                 Create a new threshold profile

Run 'framedash threshold-profiles <subcommand> --help' for more info.`;

const CREATE_HELP = `Usage: framedash threshold-profiles create [options]

Create a new threshold profile.

Required:
  --name <name>                    Threshold profile name

Optional:
  --fps-good <n>                   Good FPS threshold
  --fps-warn <n>                   Warning FPS threshold
  --frame-time-good <n>            Good frame-time threshold
  --frame-time-warn <n>            Warning frame-time threshold
  --memory-good <n>                Good memory threshold
  --memory-warn <n>                Warning memory threshold
  --gpu-time-good <n>              Good GPU-time threshold
  --gpu-time-warn <n>              Warning GPU-time threshold
  --platform <value>               Platform filter
  --resolution <value>             Resolution filter
  --build-config <value>           Build configuration filter
  --gpu <value>                    GPU filter
  --storage <value>                Storage filter`;

export const thresholdProfiles = withSubcommands("threshold-profiles", HELP, {
	list: thresholdProfilesList,
	create: thresholdProfilesCreate,
});

async function thresholdProfilesList(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: "Usage: framedash threshold-profiles list [--format json|table|csv] [global options]",
		},
		async ({ client, config }) => {
			const data = await client.get(client.projectPath("threshold-profiles"));
			log(formatOutput(data, config.format));
		},
	);
}

async function thresholdProfilesCreate(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: CREATE_HELP,
			options: {
				name: { type: "string" },
				"fps-good": { type: "string" },
				"fps-warn": { type: "string" },
				"frame-time-good": { type: "string" },
				"frame-time-warn": { type: "string" },
				"memory-good": { type: "string" },
				"memory-warn": { type: "string" },
				"gpu-time-good": { type: "string" },
				"gpu-time-warn": { type: "string" },
				platform: { type: "string" },
				resolution: { type: "string" },
				"build-config": { type: "string" },
				gpu: { type: "string" },
				storage: { type: "string" },
			},
		},
		async ({ client, config, values }) => {
			if (!values.name) {
				error("--name is required");
				process.exit(1);
			}

			const body: Record<string, unknown> = { name: values.name };
			const optionalFields = {
				"fps-good": "fpsGood",
				"fps-warn": "fpsWarn",
				"frame-time-good": "frameTimeGood",
				"frame-time-warn": "frameTimeWarn",
				"memory-good": "memoryGood",
				"memory-warn": "memoryWarn",
				"gpu-time-good": "gpuTimeGood",
				"gpu-time-warn": "gpuTimeWarn",
				platform: "platform",
				resolution: "resolution",
				"build-config": "buildConfig",
				gpu: "gpu",
				storage: "storage",
			} as const;
			for (const [flag, field] of Object.entries(optionalFields)) {
				const value = values[flag as keyof typeof optionalFields];
				if (value !== undefined) body[field] = value;
			}

			const data = await client.post(client.projectPath("threshold-profiles"), body);
			success("Threshold profile created");
			log(formatOutput(data, config.format));
		},
	);
}
