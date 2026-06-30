/**
 * Simple logging helpers for CLI output.
 * Data goes to stdout (log), status messages go to stderr (success/error).
 * This lets users pipe structured output to jq/csvtool while still seeing messages.
 */

export function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
	process.stderr.write(`  \u2713 ${message}\n`);
}

/** Non-fatal warning (the run still exits 0). */
export function warn(message: string): void {
	process.stderr.write(`  ! ${message}\n`);
}

export function error(message: string): void {
	process.stderr.write(`  \u2717 ${message}\n`);
}
