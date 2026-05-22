// P301: directive utilities relocated out of src/core into the dashboard
// bundle. Pure functions — no filesystem access, no Core imports. Mirrors
// the src/core/proposal/directives.ts surface so consumers can swap the
// import path without behaviour change. Source of truth for shared types
// remains src/shared/types; status predicates come from src/shared/utils/status.

import type {
	Directive,
	DirectiveBucket,
	DirectiveSummary,
	Proposal,
} from "../../../shared/types";
import {
	isCompleteStatus,
	isReady,
	isTerminalStatus,
} from "../../../shared/utils/status.ts";

const NO_DIRECTIVE_KEY = "__none";
const NUMERIC_DIRECTIVE_ID_PATTERN = /^([a-z]+)-(\d+)$/i;

/** Normalize a directive name/ID by trimming whitespace */
export function normalizeDirectiveName(name: string): string {
	return name.trim();
}

/** Get a lowercase key for directive comparison */
export function directiveKey(name?: string | null): string {
	return normalizeDirectiveName(name ?? "").toLowerCase();
}

/**
 * Collect archived directive keys, excluding archived titles that are reused
 * by active directives.
 */
export function collectArchivedDirectiveKeys(
	archivedDirectives: Directive[],
	activeDirectives: Directive[],
): string[] {
	const keys = new Set<string>();
	const activeTitleKeys = new Set(
		activeDirectives
			.map((directive) => directiveKey(directive.title))
			.filter(Boolean),
	);

	for (const directive of archivedDirectives) {
		const idKey = directiveKey(directive.id);
		if (idKey) keys.add(idKey);
		const titleKey = directiveKey(directive.title);
		if (titleKey && !activeTitleKeys.has(titleKey)) keys.add(titleKey);
	}

	return Array.from(keys);
}

/** Validate a directive name for creation */
export function validateDirectiveName(
	name: string,
	existingDirectives: string[],
): string | null {
	const normalizedName = normalizeDirectiveName(name);
	if (!normalizedName) return "Directive name cannot be empty.";

	const normalizedExisting = existingDirectives
		.map((directive) => directiveKey(directive))
		.filter(Boolean);

	if (normalizedExisting.includes(directiveKey(normalizedName))) {
		return "Directive already exists.";
	}

	return null;
}

function buildDirectiveAliasMap(
	directiveEntities: Directive[],
	archivedDirectives: Directive[] = [],
): Map<string, string> {
	const aliasMap = new Map<string, string>();
	const collectIdAliasKeys = (value: string): string[] => {
		const idKey = directiveKey(value);
		if (!idKey) return [];
		const keys = new Set<string>([idKey]);
		if (/^\d+$/.test(value.trim())) {
			const numericAlias = String(Number.parseInt(value.trim(), 10));
			keys.add(numericAlias);
			keys.add(`d-${numericAlias}`);
			return Array.from(keys);
		}
		const idMatch = value.trim().match(NUMERIC_DIRECTIVE_ID_PATTERN);
		if (idMatch?.[1]) {
			const prefix = idMatch[1].toLowerCase();
			const numericAlias = String(Number.parseInt(idMatch[2], 10));
			keys.add(`${prefix}-${numericAlias}`);
			keys.add(numericAlias);
		}
		return Array.from(keys);
	};
	const reservedIdKeys = new Set<string>();
	for (const directive of [...directiveEntities, ...archivedDirectives]) {
		for (const key of collectIdAliasKeys(directive.id)) {
			reservedIdKeys.add(key);
		}
	}
	const setAlias = (
		aliasKey: string,
		normalizedId: string,
		allowOverwrite: boolean,
	): void => {
		const existing = aliasMap.get(aliasKey);
		if (!existing) {
			aliasMap.set(aliasKey, normalizedId);
			return;
		}
		if (!allowOverwrite) return;
		const existingKey = existing.toLowerCase();
		const nextKey = normalizedId.toLowerCase();
		const preferredRawId = /^\d+$/.test(aliasKey)
			? `d-${aliasKey}`
			: /^d-\d+$/.test(aliasKey)
				? aliasKey
				: null;
		if (preferredRawId) {
			const existingIsPreferred = existingKey === preferredRawId;
			const nextIsPreferred = nextKey === preferredRawId;
			if (existingIsPreferred && !nextIsPreferred) return;
			if (nextIsPreferred && !existingIsPreferred) {
				aliasMap.set(aliasKey, normalizedId);
			}
			return;
		}
		aliasMap.set(aliasKey, normalizedId);
	};
	const addIdAliases = (
		normalizedId: string,
		options?: { allowOverwrite?: boolean },
	) => {
		const allowOverwrite = options?.allowOverwrite ?? true;
		const idKey = directiveKey(normalizedId);
		if (idKey) setAlias(idKey, normalizedId, allowOverwrite);
		const idMatch = normalizedId.match(NUMERIC_DIRECTIVE_ID_PATTERN);
		if (!idMatch?.[1] || !idMatch[2]) return;
		const prefix = idMatch[1].toLowerCase();
		const numericAlias = String(Number.parseInt(idMatch[2], 10));
		const canonicalId = `${prefix}-${numericAlias}`;
		setAlias(canonicalId, normalizedId, allowOverwrite);
		if (numericAlias) setAlias(numericAlias, normalizedId, allowOverwrite);
	};
	const activeTitleCounts = new Map<string, number>();
	for (const directive of directiveEntities) {
		const titleKey = directiveKey(directive.title);
		if (!titleKey) continue;
		activeTitleCounts.set(titleKey, (activeTitleCounts.get(titleKey) ?? 0) + 1);
	}
	const activeTitleKeys = new Set(activeTitleCounts.keys());

	for (const directive of directiveEntities) {
		const normalizedId = normalizeDirectiveName(directive.id);
		const normalizedTitle = normalizeDirectiveName(directive.title);
		if (!normalizedId) continue;
		addIdAliases(normalizedId);
		const titleKey = directiveKey(normalizedTitle);
		if (
			titleKey &&
			!reservedIdKeys.has(titleKey) &&
			activeTitleCounts.get(titleKey) === 1
		) {
			if (!aliasMap.has(titleKey)) aliasMap.set(titleKey, normalizedId);
		}
	}

	const archivedTitleCounts = new Map<string, number>();
	for (const directive of archivedDirectives) {
		const titleKey = directiveKey(directive.title);
		if (!titleKey || activeTitleKeys.has(titleKey)) continue;
		archivedTitleCounts.set(
			titleKey,
			(archivedTitleCounts.get(titleKey) ?? 0) + 1,
		);
	}

	for (const directive of archivedDirectives) {
		const normalizedId = normalizeDirectiveName(directive.id);
		const normalizedTitle = normalizeDirectiveName(directive.title);
		if (!normalizedId) continue;
		addIdAliases(normalizedId, { allowOverwrite: false });
		const titleKey = directiveKey(normalizedTitle);
		if (
			!titleKey ||
			activeTitleKeys.has(titleKey) ||
			reservedIdKeys.has(titleKey)
		)
			continue;
		if (archivedTitleCounts.get(titleKey) === 1) {
			if (!aliasMap.has(titleKey)) aliasMap.set(titleKey, normalizedId);
		}
	}

	return aliasMap;
}

function canonicalizeDirectiveValue(
	value: string | null | undefined,
	aliasMap: Map<string, string>,
): string {
	const normalized = normalizeDirectiveName(value ?? "");
	if (!normalized) return "";
	const normalizedKey = directiveKey(normalized);
	const direct = aliasMap.get(normalizedKey);
	if (direct) return direct;
	const idMatch = normalized.match(NUMERIC_DIRECTIVE_ID_PATTERN);
	if (idMatch?.[1] && idMatch[2]) {
		const prefix = idMatch[1].toLowerCase();
		const numericAlias = String(Number.parseInt(idMatch[2], 10));
		return (
			aliasMap.get(`${prefix}-${numericAlias}`) ??
			aliasMap.get(numericAlias) ??
			normalized
		);
	}
	if (/^\d+$/.test(normalized)) {
		const numericAlias = String(Number.parseInt(normalized, 10));
		return (
			aliasMap.get(`d-${numericAlias}`) ??
			aliasMap.get(numericAlias) ??
			normalized
		);
	}
	return normalized;
}

function canonicalizeProposalDirectives(
	proposals: Proposal[],
	directiveEntities: Directive[],
	archivedDirectives: Directive[] = [],
): Proposal[] {
	const aliasMap = buildDirectiveAliasMap(
		directiveEntities,
		archivedDirectives,
	);
	return proposals.map((proposal) => {
		const canonicalDirective = canonicalizeDirectiveValue(
			proposal.directive,
			aliasMap,
		);
		if (proposal.directive === canonicalDirective) return proposal;
		return { ...proposal, directive: canonicalDirective || undefined };
	});
}

/** Collect all unique directive IDs from proposals and directive entities */
export function collectDirectiveIds(
	proposals: Proposal[],
	directiveEntities: Directive[],
	archivedDirectives: Directive[] = [],
): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	const aliasMap = buildDirectiveAliasMap(
		directiveEntities,
		archivedDirectives,
	);

	const addDirective = (value: string) => {
		const normalized = normalizeDirectiveName(value);
		if (!normalized) return;
		const key = directiveKey(normalized);
		if (seen.has(key)) return;
		seen.add(key);
		merged.push(normalized);
	};

	for (const entity of directiveEntities) addDirective(entity.id);
	for (const proposal of proposals) {
		addDirective(canonicalizeDirectiveValue(proposal.directive, aliasMap));
	}

	return merged;
}

/** Display label for a directive — uses entity title when available */
export function getDirectiveLabel(
	directiveId: string | undefined,
	directiveEntities: Directive[],
): string {
	if (!directiveId) return "Proposals without directive";
	const entity = directiveEntities.find(
		(m) => directiveKey(m.id) === directiveKey(directiveId),
	);
	return entity?.title || directiveId;
}

export {
	isCompleteStatus,
	isReady,
	isTerminalStatus,
	isTerminalStatus as isReachedStatus,
};

function createBucket(
	directiveId: string | undefined,
	proposals: Proposal[],
	statuses: string[],
	directiveEntities: Directive[],
	isNoDirective: boolean,
): DirectiveBucket {
	const bucketDirectiveKey = directiveKey(directiveId);
	const bucketProposals = proposals.filter((proposal) => {
		const proposalDirectiveKey = directiveKey(proposal.directive);
		return bucketDirectiveKey
			? proposalDirectiveKey === bucketDirectiveKey
			: !proposalDirectiveKey;
	});

	const counts: Record<string, number> = {};
	for (const status of statuses) counts[status] = 0;
	for (const proposal of bucketProposals) {
		const status = proposal.status ?? "";
		counts[status] = (counts[status] ?? 0) + 1;
	}

	const doneCount = bucketProposals.filter((t) =>
		isCompleteStatus(t.status),
	).length;
	const progress =
		bucketProposals.length > 0
			? Math.round((doneCount / bucketProposals.length) * 100)
			: 0;
	const isCompleted =
		bucketProposals.length > 0 && doneCount === bucketProposals.length;

	const key = bucketDirectiveKey ? bucketDirectiveKey : NO_DIRECTIVE_KEY;
	const label = getDirectiveLabel(directiveId, directiveEntities);

	return {
		key,
		label,
		directive: directiveId,
		isNoDirective,
		isCompleted,
		proposals: bucketProposals,
		statusCounts: counts,
		total: bucketProposals.length,
		doneCount,
		progress,
	};
}

/** Build directive buckets from proposals and directive entities */
export function buildDirectiveBuckets(
	proposals: Proposal[],
	directiveEntities: Directive[],
	statuses: string[],
	options?: {
		archivedDirectiveIds?: string[];
		archivedDirectives?: Directive[];
	},
): DirectiveBucket[] {
	const archivedKeys = new Set(
		(options?.archivedDirectiveIds ?? []).map((id) => directiveKey(id)),
	);
	const canonicalProposals = canonicalizeProposalDirectives(
		proposals,
		directiveEntities,
		options?.archivedDirectives ?? [],
	);
	const normalizedProposals =
		archivedKeys.size > 0
			? canonicalProposals.map((proposal) => {
					const key = directiveKey(proposal.directive);
					if (!key || !archivedKeys.has(key)) return proposal;
					return { ...proposal, directive: undefined };
				})
			: canonicalProposals;
	const filteredDirectives =
		archivedKeys.size > 0
			? directiveEntities.filter(
					(directive) => !archivedKeys.has(directiveKey(directive.id)),
				)
			: directiveEntities;

	const allDirectiveIds = collectDirectiveIds(
		normalizedProposals,
		filteredDirectives,
	);

	const buckets: DirectiveBucket[] = [
		createBucket(
			undefined,
			normalizedProposals,
			statuses,
			filteredDirectives,
			true,
		),
		...allDirectiveIds.map((m) =>
			createBucket(m, normalizedProposals, statuses, filteredDirectives, false),
		),
	];

	return buckets;
}

/** Build a complete directive summary */
export function buildDirectiveSummary(
	proposals: Proposal[],
	directiveEntities: Directive[],
	statuses: string[],
	options?: {
		archivedDirectiveIds?: string[];
		archivedDirectives?: Directive[];
	},
): DirectiveSummary {
	const archivedKeys = new Set(
		(options?.archivedDirectiveIds ?? []).map((id) => directiveKey(id)),
	);
	const canonicalProposals = canonicalizeProposalDirectives(
		proposals,
		directiveEntities,
		options?.archivedDirectives ?? [],
	);
	const normalizedProposals =
		archivedKeys.size > 0
			? canonicalProposals.map((proposal) => {
					const key = directiveKey(proposal.directive);
					if (!key || !archivedKeys.has(key)) return proposal;
					return { ...proposal, directive: undefined };
				})
			: canonicalProposals;
	const filteredDirectives =
		archivedKeys.size > 0
			? directiveEntities.filter(
					(directive) => !archivedKeys.has(directiveKey(directive.id)),
				)
			: directiveEntities;
	const directives = collectDirectiveIds(
		normalizedProposals,
		filteredDirectives,
		options?.archivedDirectives ?? [],
	);
	const buckets = buildDirectiveBuckets(
		normalizedProposals,
		filteredDirectives,
		statuses,
		options,
	);

	return { directives, buckets };
}
