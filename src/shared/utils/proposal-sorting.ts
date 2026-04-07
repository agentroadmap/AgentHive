/**
 * Parse a proposal ID into its numeric components for proper sorting.
 * Handles both simple IDs (proposal-5) and decimal IDs (proposal-5.2.1).
 * Works with any prefix pattern (proposal-, draft-, JIRA-, etc.)
 */
export function parseProposalId(proposalId: string): number[] {
	// Remove any prefix pattern (letters followed by dash) - handles proposal-, draft-, JIRA-, etc.
	const numericPart = proposalId.replace(/^[a-zA-Z]+-/i, "");

	// Try to extract numeric parts from the ID
	// First check if it's a standard numeric ID (e.g., "1", "1.2", etc.)
	const dotParts = numericPart.split(".");
	const numericParts = dotParts.map((part) => {
		const num = Number.parseInt(part, 10);
		return Number.isNaN(num) ? null : num;
	});

	// If all parts are numeric, return them
	if (numericParts.every((n) => n !== null)) {
		return numericParts as number[];
	}

	// Otherwise, try to extract trailing number (e.g., "draft2" -> 2)
	const trailingNumberMatch = numericPart.match(/(\d+)$/);
	if (trailingNumberMatch) {
		const [, num] = trailingNumberMatch;
		return [Number.parseInt(num ?? "0", 10)];
	}

	// No numeric parts found, return 0 for consistent sorting
	return [0];
}

/**
 * Compare two proposal IDs numerically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 *
 * Examples:
 * - proposal-2 comes before proposal-10
 * - proposal-2 comes before proposal-2.1
 * - proposal-2.1 comes before proposal-2.2
 * - proposal-2.2 comes before proposal-2.10
 */
export function compareProposalIds(a: string, b: string): number {
	const aParts = parseProposalId(a);
	const bParts = parseProposalId(b);

	// Compare each numeric part
	const maxLength = Math.max(aParts.length, bParts.length);

	for (let i = 0; i < maxLength; i++) {
		const aNum = aParts[i] ?? 0;
		const bNum = bParts[i] ?? 0;

		if (aNum !== bNum) {
			return aNum - bNum;
		}
	}

	// All parts are equal
	return 0;
}

/**
 * Sort an array of objects by their proposal ID property numerically.
 * Returns a new sorted array without mutating the original.
 */
export function sortByProposalId<T extends { id: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => compareProposalIds(a.id, b.id));
}

/**
 * Sort an array of proposals by their priority property.
 * Priority order: high > medium > low > undefined
 * Proposals with the same priority are sorted by proposal ID.
 */
export function sortByPriority<
	T extends { id: string; priority?: "high" | "medium" | "low" },
>(items: T[]): T[] {
	const priorityWeight = {
		high: 3,
		medium: 2,
		low: 1,
	};

	return [...items].sort((a, b) => {
		const aWeight = a.priority ? priorityWeight[a.priority] : 0;
		const bWeight = b.priority ? priorityWeight[b.priority] : 0;

		// First sort by priority (higher weight = higher priority)
		if (aWeight !== bWeight) {
			return bWeight - aWeight;
		}

		// If priorities are the same, sort by proposal ID
		return compareProposalIds(a.id, b.id);
	});
}

/**
 * Sort an array of proposals by their ordinal property, then by proposal ID.
 * Proposals with ordinal values come before proposals without.
 * Proposals with the same ordinal (or both undefined) are sorted by proposal ID.
 */
export function sortByOrdinal<T extends { id: string; ordinal?: number }>(
	items: T[],
): T[] {
	return [...items].sort((a, b) => {
		// Proposals with ordinal come before proposals without
		if (a.ordinal !== undefined && b.ordinal === undefined) {
			return -1;
		}
		if (a.ordinal === undefined && b.ordinal !== undefined) {
			return 1;
		}

		// Both have ordinals - sort by ordinal value
		if (a.ordinal !== undefined && b.ordinal !== undefined) {
			if (a.ordinal !== b.ordinal) {
				return a.ordinal - b.ordinal;
			}
		}

		// Same ordinal (or both undefined) - sort by proposal ID
		return compareProposalIds(a.id, b.id);
	});
}

/**
 * Sort an array of proposals considering ordinal first, then priority, then ID.
 * This is the default sorting for the board view.
 */
export function sortByOrdinalAndPriority<
	T extends {
		id: string;
		ordinal?: number;
		priority?: "high" | "medium" | "low";
	},
>(items: T[]): T[] {
	const priorityWeight = {
		high: 3,
		medium: 2,
		low: 1,
	};

	return [...items].sort((a, b) => {
		// Proposals with ordinal come before proposals without
		if (a.ordinal !== undefined && b.ordinal === undefined) {
			return -1;
		}
		if (a.ordinal === undefined && b.ordinal !== undefined) {
			return 1;
		}

		// Both have ordinals - sort by ordinal value
		if (a.ordinal !== undefined && b.ordinal !== undefined) {
			if (a.ordinal !== b.ordinal) {
				return a.ordinal - b.ordinal;
			}
		}

		// Same ordinal (or both undefined) - sort by priority
		const aWeight = a.priority ? priorityWeight[a.priority] : 0;
		const bWeight = b.priority ? priorityWeight[b.priority] : 0;

		if (aWeight !== bWeight) {
			return bWeight - aWeight;
		}

		// Same priority - sort by proposal ID
		return compareProposalIds(a.id, b.id);
	});
}

/**
 * Sort proposals by a specified field with fallback to proposal ID sorting.
 * Supported fields: 'priority', 'id', 'ordinal'
 */
export function sortProposals<
	T extends {
		id: string;
		priority?: "high" | "medium" | "low";
		ordinal?: number;
	},
>(items: T[], sortField: string): T[] {
	switch (sortField?.toLowerCase()) {
		case "priority":
			return sortByPriority(items);
		case "id":
			return sortByProposalId(items);
		case "ordinal":
			return sortByOrdinal(items);
		default:
			// Default to ordinal + priority sorting for board view
			return sortByOrdinalAndPriority(items);
	}
}
