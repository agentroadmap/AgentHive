const DANGEROUS_KEY_PATTERNS = [/_SECRET$/i, /_PASSWORD$/i];

export function sanitizeExtraEnv(extraEnv: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(extraEnv).filter(([key]) => !DANGEROUS_KEY_PATTERNS.some((p) => p.test(key))),
	);
}
