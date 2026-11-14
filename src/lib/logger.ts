/**
 * Simple logging helpers for CLI output.
 * Data goes to stdout (log), status messages go to stderr (success/error).
 * This lets users pipe structured output to jq/csvtool while still seeing messages.
 */

import { escapeControlChars } from "./control-chars.js";

export function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

export function info(message: string): void {
	process.stderr.write(`  ${escapeControlChars(message)}\n`);
}

// Status lines interpolate API error details, build IDs and metric names; a raw newline there
// would let tenant data start a GitHub Actions workflow command at line start.
export function success(message: string): void {
	process.stderr.write(`  \u2713 ${escapeControlChars(message)}\n`);
}

export function warn(message: string): void {
	process.stderr.write(`  ! ${escapeControlChars(message)}\n`);
}

export function error(message: string): void {
	process.stderr.write(`  \u2717 ${escapeControlChars(message)}\n`);
}
