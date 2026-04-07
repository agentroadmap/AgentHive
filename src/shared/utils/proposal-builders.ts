import type { Core } from "../../core/roadmap.ts";
import { normalizeProposalId, proposalIdsEqual } from "./proposal-path.ts";

/**
 * Shared utilities for building proposals and validating dependencies
 * Used by both CLI and MCP to ensure consistent behavior
 */

/**
 * Normalize dependencies to proper proposal-X format
 * Handles both array and comma-separated string inputs
 */
export function normalizeDependencies(dependencies: unknown): string[] {
	if (!dependencies) return [];
	const normalizeList = (values: string[]): string[] =>
		values
			.map((value) => value.trim())
			.filter((value): value is string => value.length > 0)
			.map((value) => normalizeProposalId(value));

	if (Array.isArray(dependencies)) {
		return normalizeList(
			dependencies.flatMap((dep) =>
				String(dep)
					.split(",")
					.map((d) => d.trim()),
			),
		);
	}

	return normalizeList(String(dependencies).split(","));
}

/**
 * Validate that all dependencies exist in the current project
 * Returns arrays of valid and invalid dependency IDs
 */
export async function validateDependencies(
	dependencies: string[],
	core: Core,
): Promise<{ valid: string[]; invalid: string[] }> {
	const valid: string[] = [];
	const invalid: string[] = [];
	if (dependencies.length === 0) {
		return { valid, invalid };
	}
	// Load live proposals from the active backend and local drafts for compatibility.
	const [proposals, drafts] = await Promise.all([
		core.queryProposals({ includeCrossBranch: false }),
		core.filesystem.listDrafts(),
	]);
	const knownIds = [...proposals.map((t) => t.id), ...drafts.map((d) => d.id)];
	for (const dep of dependencies) {
		const match = knownIds.find((id) => proposalIdsEqual(dep, id));
		if (match) {
			valid.push(match);
		} else {
			invalid.push(dep);
		}
	}
	return { valid, invalid };
}

/**
 * Process acceptance criteria options from CLI/MCP arguments
 * Handles both --ac and --acceptance-criteria options
 */
export function processAcceptanceCriteriaOptions(options: {
	ac?: string | string[];
	acceptanceCriteria?: string | string[];
}): string[] {
	const criteria: string[] = [];
	// Process --ac options
	if (options.ac) {
		const acCriteria = Array.isArray(options.ac) ? options.ac : [options.ac];
		criteria.push(...acCriteria.map((c) => String(c).trim()).filter(Boolean));
	}
	// Process --acceptance-criteria options
	if (options.acceptanceCriteria) {
		const accCriteria = Array.isArray(options.acceptanceCriteria)
			? options.acceptanceCriteria
			: [options.acceptanceCriteria];
		criteria.push(...accCriteria.map((c) => String(c).trim()).filter(Boolean));
	}
	return criteria;
}

/**
 * Process verification proposalment options from CLI/MCP arguments
 * Formats them as [role] text (evidence: type) if flags are provided.
 */
export function processVerificationOptions(options: {
	verify?: string | string[];
	addVerify?: string | string[];
	verifyRole?: string;
	verifyEvidence?: string;
}): string[] {
	const raw = toStringArray(options.verify).concat(
		toStringArray(options.addVerify),
	);
	if (raw.length === 0) return [];

	return raw.map((text) => {
		let formatted = text;
		if (options.verifyRole) {
			formatted = `[${options.verifyRole}] ${formatted}`;
		}
		if (options.verifyEvidence) {
			formatted = `${formatted} (evidence: ${options.verifyEvidence})`;
		}
		return formatted;
	});
}

/**
 * Normalize a list of string values by trimming whitespace, dropping empties, and deduplicating.
 * Returns `undefined` when the resulting list is empty so callers can skip optional updates.
 */
export function normalizeStringList(
	values: string[] | undefined,
): string[] | undefined {
	if (!values) return undefined;
	const unique = Array.from(
		new Set(
			values
				.map((value) => String(value).trim())
				.filter((value) => value.length > 0),
		),
	);
	return unique.length > 0 ? unique : undefined;
}

/**
 * Convert Commander-style option values into a string array.
 * Handles single values, repeated flags, and undefined/null inputs.
 */
export function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item));
	}
	if (value === undefined || value === null) {
		return [];
	}
	return [String(value)];
}

/**
 * Parse a Commander option (single value or array) into a strictly positive integer list.
 * Throws an Error when any value is invalid so callers can surface CLI-friendly messaging.
 */
export function parsePositiveIndexList(value: unknown): number[] {
	const entries = Array.isArray(value)
		? value
		: value !== undefined && value !== null
			? [value]
			: [];
	return entries.map((entry) => {
		const parsed = Number.parseInt(String(entry), 10);
		if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 1) {
			throw new Error(
				`Invalid index: ${String(entry)}. Index must be a positive number (1-based).`,
			);
		}
		return parsed;
	});
}

export function stringArraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}
