// Legacy config text parsers and migration helpers.
//
// Extracted from Core (src/core/roadmap.ts) during the Phase 1 monolith
// decomposition. These are pure functions used to migrate the historical
// YAML-style config directives into the current structured format.
//
// Standalone wrappers for LegacyConfigMigrator methods are exported here so
// roadmap.ts can import them without instantiating the class directly.

import type { FileSystem } from "../../file-system/operations.ts";
import { LegacyConfigMigrator } from "../config-migration.ts";

export async function extractLegacyConfigDirectives(
	fs: FileSystem,
): Promise<string[]> {
	return new LegacyConfigMigrator(fs).extractLegacyConfigDirectives();
}

export async function migrateLegacyConfigDirectivesToFiles(
	fs: FileSystem,
	legacyDirectives: string[],
): Promise<void> {
	return new LegacyConfigMigrator(fs).migrateLegacyConfigDirectivesToFiles(
		legacyDirectives,
	);
}

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
