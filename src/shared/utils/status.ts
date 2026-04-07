import { DEFAULT_STATUSES } from "../../constants/index.ts";
import type { Core } from "../../core/roadmap.ts";
import type { ProposalClaim } from "../types/index.ts";

/**
 * Check if a status represents a "done" (successful completion) proposal.
 * Matches "done", "complete", or "completed" (case-insensitive).
 */
export function isCompleteStatus(status?: string | null): boolean {
	if (!status) return false;
	const normalized = String(status).trim().toLowerCase();
	return (
		normalized === "done" ||
		normalized === "complete" ||
		normalized === "completed" ||
		normalized.includes("done") ||
		normalized.includes("complete")
	);
}

/**
 * Check if a status represents a terminal proposal (either successful or abandoned/archived).
 */
export function isTerminalStatus(status?: string | null): boolean {
	if (isCompleteStatus(status)) return true;
	const normalized = (status ?? "").toLowerCase();
	return (
		normalized.includes("abandoned") ||
		normalized.includes("archived") ||
		normalized.includes("rejected") ||
		normalized.includes("replaced")
	);
}

/**
 * Check if a status represents a "to do" (not started) proposal.
 * Matches "todo", "new", or "draft" (case-insensitive).
 */
export function isTodoStatus(status?: string | null): boolean {
	if (!status) return false;
	const normalized = status.toLowerCase();
	return (
		normalized === "todo" ||
		normalized === "new" ||
		normalized === "draft" ||
		normalized.includes("todo") ||
		normalized.includes("new") ||
		normalized.includes("draft")
	);
}

/**
 * Check if a status represents an "in progress" proposal.
 * Matches "active", "building", "developing", or "review" (case-insensitive).
 */
export function isInProgressStatus(status?: string | null): boolean {
	if (!status) return false;
	const normalized = status.toLowerCase();
	return (
		normalized === "active" ||
		normalized === "building" ||
		normalized === "developing" ||
		normalized === "review" ||
		normalized.includes("active") ||
		normalized.includes("building") ||
		normalized.includes("review")
	);
}

/**
 * Check if a proposal is ready for autonomous pickup (not terminal, unassigned, and unblocked).
 * @param proposal - The proposal to check
 * @param doneIds - A set of IDs for proposals that are already completed/done
 * @returns true if the proposal is ready for pickup
 */
export function isReady(
	proposal: {
		status: string;
		type?: string;
		assignee?: string[];
		dependencies?: string[];
		claim?: ProposalClaim;
		external_injections?: string[];
	},
	doneIds: Set<string>,
	allProposals?: Array<{ status: string; type?: string }>,
): boolean {
	// 1. Must not be terminal (complete, abandoned, etc.)
	if (isTerminalStatus(proposal.status)) return false;

	// 2. High-priority interrupt: if there are any active INCIDENTS, everything else is blocked
	// unless the current proposal is also an incident.
	if (allProposals && proposal.type !== "incident") {
		const activeIncidents = allProposals.filter(
			(s) => s.type === "incident" && !isTerminalStatus(s.status),
		);
		if (activeIncidents.length > 0) return false;
	}

	// 3. Must be unassigned (no ownership/claim proposal)
	if (proposal.assignee && proposal.assignee.length > 0) return false;

	// 2.1. Must not have an active claim
	if (proposal.claim?.expires) {
		const expires = new Date(proposal.claim.expires.replace(" ", "T"));
		if (expires > new Date()) {
			return false;
		}
	}

	// 3. Must be unblocked: all dependencies must be done/complete
	// 3. Must not have external injections (3rd party blockers)
	if (proposal.external_injections && proposal.external_injections.length > 0)
		return false;

	const deps = proposal.dependencies || [];
	if (deps.length > 0) {
		const hasBlockingDependency = deps.some((depId) => !doneIds.has(depId));
		if (hasBlockingDependency) return false;
	}

	return true;
}

/**
 * Load valid statuses from project configuration.
 */
export async function getValidStatuses(core?: Core): Promise<string[]> {
	const config = await core?.filesystem.loadConfig();
	return config?.statuses || [...DEFAULT_STATUSES];
}

/**
 * Find the canonical status (matching config casing) for a given input.
 * Loads configured statuses and matches case-insensitively and space-insensitively.
 * Returns the canonical value or null if no match is found.
 *
 * Examples:
 * - "todo" matches "Draft"
 * - "in progress" matches "Building"
 * - "DONE" matches "Complete"
 */
export async function getCanonicalStatus(
	input: string | undefined,
	core?: Core,
): Promise<string | null> {
	if (!input) return null;
	const statuses = await getValidStatuses(core);
	const normalizedInput = String(input)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "");
	if (!normalizedInput) return null;

	// Direct match
	for (const s of statuses) {
		if (s.toLowerCase().replace(/\s+/g, "") === normalizedInput) return s;
	}

	// Semantic aliases
	if (normalizedInput === "todo" || normalizedInput === "new") {
		const found = statuses.find((s) => s.toLowerCase() === "draft");
		if (found) return found;
	}

	if (
		normalizedInput === "inprogress" ||
		normalizedInput === "active" ||
		normalizedInput === "developing"
	) {
		const found = statuses.find((s) => {
			const ns = s.toLowerCase();
			return ns === "building" || ns === "active";
		});
		if (found) return found;
	}

	if (normalizedInput === "done" || normalizedInput === "complete") {
		const found = statuses.find((s) => {
			const ns = s.toLowerCase();
			return ns === "complete";
		});
		if (found) return found;
	}

	return null;
}

/**
 * Format a list of valid statuses for display.
 */
export function formatValidStatuses(configuredStatuses: string[]): string {
	return configuredStatuses.join(", ");
}
