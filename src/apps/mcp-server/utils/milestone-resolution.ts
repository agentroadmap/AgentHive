import type { Directive } from "../../../shared/types/index.ts";

export function normalizeDirectiveName(name: string): string {
	return name.trim();
}

export function directiveKey(name: string): string {
	return normalizeDirectiveName(name).toLowerCase();
}

function buildDirectiveLookupKeys(name: string): string[] {
	const normalized = normalizeDirectiveName(name);
	const baseKey = directiveKey(normalized);
	if (!baseKey) {
		return [];
	}

	const keys: string[] = [baseKey];
	const addKey = (key: string) => {
		if (!keys.includes(key)) {
			keys.push(key);
		}
	};

	if (/^\d+$/.test(normalized)) {
		const numeric = String(Number.parseInt(normalized, 10));
		addKey(numeric);
		addKey(`m-${numeric}`);
		return keys;
	}

	const directiveIdMatch = normalized.match(/^m-(\d+)$/i);
	if (directiveIdMatch?.[1]) {
		const numeric = String(Number.parseInt(directiveIdMatch[1], 10));
		addKey(`m-${numeric}`);
		addKey(numeric);
	}

	return keys;
}

function directiveIdMatchesLookupKeys(
	directiveId: string,
	lookupKeys: Set<string>,
): boolean {
	for (const key of buildDirectiveLookupKeys(directiveId)) {
		if (lookupKeys.has(key)) {
			return true;
		}
	}
	return false;
}

function canonicalDirectiveId(value: string): string | null {
	const normalized = normalizeDirectiveName(value);
	if (!normalized) {
		return null;
	}
	if (/^\d+$/.test(normalized)) {
		const numeric = String(Number.parseInt(normalized, 10));
		return `m-${numeric}`;
	}
	const directiveIdMatch = normalized.match(/^m-(\d+)$/i);
	if (directiveIdMatch?.[1]) {
		const numeric = String(Number.parseInt(directiveIdMatch[1], 10));
		return `m-${numeric}`;
	}
	return null;
}

function findMatchingDirectiveId(
	name: string,
	directives: Directive[],
): Directive | undefined {
	const normalized = normalizeDirectiveName(name);
	const inputKey = directiveKey(normalized);
	const rawExactMatch = directives.find(
		(directive) => directiveKey(directive.id) === inputKey,
	);
	if (rawExactMatch) {
		return rawExactMatch;
	}
	const canonicalInputId = canonicalDirectiveId(normalized);
	if (canonicalInputId) {
		const canonicalRawMatch = directives.find(
			(directive) => directiveKey(directive.id) === canonicalInputId,
		);
		if (canonicalRawMatch) {
			return canonicalRawMatch;
		}
	}
	const lookupKeys = new Set(buildDirectiveLookupKeys(normalized));
	return directives.find((directive) =>
		directiveIdMatchesLookupKeys(directive.id, lookupKeys),
	);
}

function findMatchingDirective(
	name: string,
	directives: Directive[],
): Directive | undefined {
	const normalized = normalizeDirectiveName(name);
	const lookupKeys = buildDirectiveLookupKeys(normalized);
	if (lookupKeys.length === 0) {
		return undefined;
	}
	const inputKey = lookupKeys[0];
	if (!inputKey) {
		return undefined;
	}
	const looksLikeDirectiveId =
		/^m-\d+$/i.test(normalized) || /^\d+$/.test(normalized);
	const idMatch = findMatchingDirectiveId(normalized, directives);
	const titleMatches = directives.filter(
		(directive) => directiveKey(directive.title) === inputKey,
	);
	const uniqueTitleMatch =
		titleMatches.length === 1 ? titleMatches[0] : undefined;
	if (looksLikeDirectiveId) {
		return idMatch ?? uniqueTitleMatch;
	}
	return uniqueTitleMatch ?? idMatch;
}

export function resolveDirectiveStorageValue(
	name: string,
	directives: Directive[],
): string {
	const normalized = normalizeDirectiveName(name);
	if (!normalized) {
		return normalized;
	}
	return findMatchingDirective(normalized, directives)?.id ?? normalized;
}

export function buildDirectiveMatchKeys(
	name: string,
	directives: Directive[],
): Set<string> {
	const normalized = normalizeDirectiveName(name);
	const keys = new Set<string>();
	const lookupKeys = buildDirectiveLookupKeys(normalized);
	for (const key of lookupKeys) {
		keys.add(key);
	}
	const inputKey = lookupKeys[0] ?? "";

	if (!inputKey) {
		return keys;
	}

	const idMatch = findMatchingDirectiveId(normalized, directives);
	if (idMatch) {
		return keys;
	}

	const titleMatches = directives.filter(
		(directive) => directiveKey(directive.title) === inputKey,
	);
	const titleMatch = titleMatches.length === 1 ? titleMatches[0] : undefined;
	if (titleMatch) {
		for (const key of buildDirectiveLookupKeys(titleMatch.id)) {
			keys.add(key);
		}
	}

	return keys;
}

export function keySetsIntersect(
	left: Set<string>,
	right: Set<string>,
): boolean {
	for (const key of left) {
		if (right.has(key)) {
			return true;
		}
	}
	return false;
}
