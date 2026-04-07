import Fuse from "fuse.js";
import type { Directive } from "../types/index.ts";

interface DirectiveCandidate {
	value: string;
	compact: string;
}

export function createDirectiveFilterValueResolver(
	directives: Directive[],
): (directiveValue: string) => string {
	const directiveLabelsByKey = new Map<string, string>();
	for (const directive of directives) {
		const normalizedId = directive.id.trim();
		const normalizedTitle = directive.title.trim();
		if (!normalizedId || !normalizedTitle) continue;
		directiveLabelsByKey.set(normalizedId.toLowerCase(), normalizedTitle);
		const idMatch = normalizedId.match(/^m-(\d+)$/i);
		if (idMatch?.[1]) {
			const numericAlias = String(Number.parseInt(idMatch[1], 10));
			directiveLabelsByKey.set(`m-${numericAlias}`, normalizedTitle);
			directiveLabelsByKey.set(numericAlias, normalizedTitle);
		}
		directiveLabelsByKey.set(normalizedTitle.toLowerCase(), normalizedTitle);
	}

	return (directiveValue: string) => {
		const normalized = directiveValue.trim();
		if (!normalized) return directiveValue;
		return directiveLabelsByKey.get(normalized.toLowerCase()) ?? directiveValue;
	};
}

export function normalizeDirectiveFilterValue(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function compactDirectiveFilterValue(value: string): string {
	return value.replace(/\s+/g, "");
}

export function resolveClosestDirectiveFilterValue(
	query: string,
	directiveValues: string[],
): string {
	const normalizedQuery = normalizeDirectiveFilterValue(query);
	if (!normalizedQuery) {
		return normalizedQuery;
	}

	const normalizedCandidates = Array.from(
		new Set(
			directiveValues
				.map((value) => normalizeDirectiveFilterValue(value))
				.filter(Boolean),
		),
	).sort((left, right) => left.localeCompare(right));

	if (normalizedCandidates.length === 0) {
		return normalizedQuery;
	}

	if (normalizedCandidates.includes(normalizedQuery)) {
		return normalizedQuery;
	}

	const candidates: DirectiveCandidate[] = normalizedCandidates.map(
		(value) => ({
			value,
			compact: compactDirectiveFilterValue(value),
		}),
	);

	const fuse = new Fuse(candidates, {
		includeScore: true,
		threshold: 0.45,
		ignoreLocation: true,
		minMatchCharLength: 2,
		keys: [
			{ name: "value", weight: 0.7 },
			{ name: "compact", weight: 0.3 },
		],
	});

	const compactQuery = compactDirectiveFilterValue(normalizedQuery);
	const best =
		fuse.search(normalizedQuery)[0]?.item.value ??
		(compactQuery ? fuse.search(compactQuery)[0]?.item.value : undefined);

	return best ?? normalizedQuery;
}
