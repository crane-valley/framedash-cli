import { type ParseArgsConfig, parseArgs } from "node:util";
import type { ApiClient } from "@framedash/api-client";
import {
	type CliConfig,
	GLOBAL_OPTIONS,
	resolveConfig,
	resolveConfigWithoutProject,
} from "./config.js";
import { createClient } from "./create-client.js";
import { error, log } from "./logger.js";

export type CommandOptions = {
	args: string[];
	help: string;
	options?: ParseArgsConfig["options"];
	allowPositionals?: boolean;
	noProject?: boolean;
};

export type CommandContext = {
	config: CliConfig;
	client: ApiClient;
	values: Record<string, string | boolean | undefined>;
	positionals: string[];
};

/**
 * Shared command runner that handles parseArgs, help, config resolution,
 * and client creation. Commands only need to supply their specific logic.
 */
export async function runCommand(
	opts: CommandOptions,
	handler: (ctx: CommandContext) => Promise<void>,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: opts.args,
		options: { ...GLOBAL_OPTIONS, ...opts.options },
		allowPositionals: opts.allowPositionals ?? false,
	});

	if (values.help) {
		log(opts.help);
		return;
	}

	const typedValues = values as Record<string, string | boolean | undefined>;

	if (opts.noProject) {
		const baseConfig = resolveConfigWithoutProject(typedValues);
		const config: CliConfig = { ...baseConfig, projectId: "" };
		const client = createClient(config.baseUrl, config.apiKey, "");
		await handler({ config, client, values: typedValues, positionals });
	} else {
		const config = resolveConfig(typedValues);
		const client = createClient(config.baseUrl, config.apiKey, config.projectId);
		await handler({ config, client, values: typedValues, positionals });
	}
}

export type SubcommandMap = Record<string, (args: string[]) => Promise<void>>;

/**
 * Create a subcommand dispatcher that handles help display and
 * routes to the correct handler based on the first positional arg.
 */
export function withSubcommands(
	name: string,
	help: string,
	subcommands: SubcommandMap,
): (args: string[]) => Promise<void> {
	return async (args: string[]): Promise<void> => {
		const subcommand = args[0];

		if (!subcommand || subcommand === "--help" || subcommand === "-h") {
			log(help);
			return;
		}

		if (!Object.hasOwn(subcommands, subcommand)) {
			error(`Unknown ${name} subcommand: ${subcommand}`);
			log(help);
			process.exit(1);
			return;
		}

		// biome-ignore lint/style/noNonNullAssertion: validated by Object.hasOwn above
		await subcommands[subcommand]!(args.slice(1));
	};
}
