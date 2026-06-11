/**
 * Parse tags from various input formats.
 *
 * Handles:
 * - null/undefined input: returns {}
 * - object input: returns as-is
 * - JSON string input: parses and returns
 * - invalid JSON: returns {}
 *
 * @param tags - Raw tags in string or object form, or null
 * @returns Parsed tags as Record<string, unknown>
 */
export default function parseTags(
	tags: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
	if (!tags) {
		return {};
	}

	if (typeof tags === "object") {
		return tags;
	}

	if (typeof tags === "string") {
		try {
			const parsed = JSON.parse(tags);
			if (typeof parsed === "object" && parsed !== null) {
				return parsed;
			}
		} catch {
			// Silently return empty object on parse failure
		}
		return {};
	}

	return {};
}
