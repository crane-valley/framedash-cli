// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

export function escapeControlChars(value: string, options?: { keepTab?: boolean }): string {
	return value.replace(CONTROL_CHARS, (char) =>
		options?.keepTab && char === "\t"
			? char
			: `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
