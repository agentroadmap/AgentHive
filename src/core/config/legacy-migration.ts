/**
 * Legacy config migration helpers.
 *
 * Pure YAML/text-processing utilities (plus thin filesystem-backed wrappers)
 * extracted from the `Core` class (P3796 monolith decomposition, Phase 1).
 *
 * These functions have no Postgres dependencies. The filesystem-backed helpers
 * accept a `FileSystem` instance so they can be called from `Core` without
 * relying on `this`, avoiding circular imports with `roadmap.ts`.
 */
import { readFile } from "node:fs/promises";
import type { FileSystem } from "../../file-system/operations.ts";

/** Parse a comma-separated, optionally-quoted inline YAML array body. */
export function parseLegacyInlineArray(value: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	const pushCurrent = () => {
		const normalized = current.trim().replace(/\\(['"])/g, "$1");
		if (normalized) {
			items.push(normalized);
		}
		current = "";
	};

	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		const prev = i > 0 ? value[i - 1] : "";
		if (quote) {
			if (ch === quote && prev !== "\\") {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ",") {
			pushCurrent();
			continue;
		}
		current += ch;
	}
	pushCurrent();
	return items;
}

/** Strip a trailing `# comment` from a YAML scalar, respecting quotes. */
export function stripYamlComment(value: string): string {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		const prev = i > 0 ? value[i - 1] : "";
		if (quote) {
			if (ch === quote && prev !== "\\") {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#") {
			return value.slice(0, i).trimEnd();
		}
	}
	return value;
}

/** Unquote a YAML scalar value (single or double quoted), stripping comments. */
export function parseLegacyYamlValue(value: string): string {
	const trimmed = stripYamlComment(value).trim();
	const singleQuoted = trimmed.match(/^'(.*)'$/);
	if (singleQuoted?.[1] !== undefined) {
		return singleQuoted[1].replace(/''/g, "'");
	}
	const doubleQuoted = trimmed.match(/^"(.*)"$/);
	if (doubleQuoted?.[1] !== undefined) {
		return doubleQuoted[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
	}
	return trimmed;
}

/**
 * Extract a legacy `directives:` list from the raw config YAML file.
 * Supports inline arrays, single scalars and block lists.
 */
export async function extractLegacyConfigDirectives(
	fs: FileSystem,
): Promise<string[]> {
	try {
		const configPath = fs.configFilePath;
		const content = await readFile(configPath, "utf-8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			const match = line.match(/^(\s*)directives\s*:\s*(.*)$/);
			if (!match) {
				continue;
			}

			const directiveIndent = (match[1] ?? "").length;
			const trailing = stripYamlComment(match[2] ?? "").trim();
			if (trailing.startsWith("[")) {
				let combined = trailing;
				let closed = trailing.endsWith("]");
				let j = i + 1;
				while (!closed && j < lines.length) {
					const segment = stripYamlComment(lines[j] ?? "").trim();
					combined += segment;
					if (segment.includes("]")) {
						closed = true;
						break;
					}
					j += 1;
				}
				if (closed) {
					const openIndex = combined.indexOf("[");
					const closeIndex = combined.lastIndexOf("]");
					if (openIndex !== -1 && closeIndex > openIndex) {
						const parsed = parseLegacyInlineArray(
							combined.slice(openIndex + 1, closeIndex),
						);
						return parsed
							.map((item) => parseLegacyYamlValue(item))
							.filter(Boolean);
					}
				}
			}
			if (trailing.length > 0) {
				const single = parseLegacyYamlValue(trailing);
				return single ? [single] : [];
			}

			const values: string[] = [];
			for (let j = i + 1; j < lines.length; j += 1) {
				const nextLine = lines[j] ?? "";
				if (!nextLine.trim()) {
					continue;
				}
				const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
				if (nextIndent <= directiveIndent) {
					break;
				}
				const trimmed = nextLine.trim();
				if (!trimmed.startsWith("-")) {
					continue;
				}
				const itemValue = parseLegacyYamlValue(trimmed.slice(1));
				if (itemValue) {
					values.push(itemValue);
				}
			}
			return values;
		}
		return [];
	} catch {
		return [];
	}
}

/**
 * Migrate legacy directive names (from the old inline config) into the
 * file-backed directive store, de-duplicating against existing entries.
 */
export async function migrateLegacyConfigDirectivesToFiles(
	fs: FileSystem,
	legacyDirectives: string[],
): Promise<void> {
	if (legacyDirectives.length === 0) {
		return;
	}
	const existingDirectives = await fs.listDirectives();
	const existingKeys = new Set<string>();
	for (const directive of existingDirectives) {
		const idKey = directive.id.trim().toLowerCase();
		const titleKey = directive.title.trim().toLowerCase();
		if (idKey) {
			existingKeys.add(idKey);
		}
		if (titleKey) {
			existingKeys.add(titleKey);
		}
	}
	for (const name of legacyDirectives) {
		const normalized = name.trim();
		const key = normalized.toLowerCase();
		if (!normalized || existingKeys.has(key)) {
			continue;
		}
		const created = await fs.createDirective(normalized);
		const createdIdKey = created.id.trim().toLowerCase();
		const createdTitleKey = created.title.trim().toLowerCase();
		if (createdIdKey) {
			existingKeys.add(createdIdKey);
		}
		if (createdTitleKey) {
			existingKeys.add(createdTitleKey);
		}
	}
}
