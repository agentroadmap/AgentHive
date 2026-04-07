/**
 * Lane system for Board — v2.5 proposal-based model
 *
 * Supports lane grouping by: none, type, domain
 */

import type { Proposal } from "../hooks/useWebSocket";

export type LaneMode = "none" | "type" | "domain";

export interface LaneDefinition {
	key: string;
	label: string;
}

export const DEFAULT_LANE_KEY = "lane:none";

export const laneKeyFromType = (proposalType?: string | null): string => {
	if (!proposalType) return "lane:type:__none";
	return `lane:type:${proposalType}`;
};

export const laneKeyFromDomain = (domainId?: string | null): string => {
	if (!domainId) return "lane:domain:__none";
	return `lane:domain:${domainId}`;
};

/**
 * Build lane definitions based on mode and available proposals
 */
export function buildLanes(
	mode: LaneMode,
	proposals: Proposal[],
	_proposalTypes: string[] = [],
	_domains: string[] = [],
): LaneDefinition[] {
	if (mode === "none") {
		return [{ key: DEFAULT_LANE_KEY, label: "All Proposals" }];
	}

	if (mode === "type") {
		const seen = new Set<string>();
		const lanes: LaneDefinition[] = [];
		for (const p of proposals) {
			if (!seen.has(p.proposalType)) {
				seen.add(p.proposalType);
				lanes.push({
					key: laneKeyFromType(p.proposalType),
					label: p.proposalType,
				});
			}
		}
		return lanes.sort((a, b) => a.label.localeCompare(b.label));
	}

	if (mode === "domain") {
		const seen = new Set<string>();
		const lanes: LaneDefinition[] = [];
		for (const p of proposals) {
			if (!seen.has(p.domainId)) {
				seen.add(p.domainId);
				lanes.push({ key: laneKeyFromDomain(p.domainId), label: p.domainId });
			}
		}
		return lanes.sort((a, b) => a.label.localeCompare(b.label));
	}

	return [{ key: DEFAULT_LANE_KEY, label: "All Proposals" }];
}

/**
 * Get the lane key for a proposal based on mode
 */
export function laneKeyForProposal(mode: LaneMode, proposal: Proposal): string {
	if (mode === "type") return laneKeyFromType(proposal.proposalType);
	if (mode === "domain") return laneKeyFromDomain(proposal.domainId);
	return DEFAULT_LANE_KEY;
}

/**
 * Sort proposals by priority and updated date
 */
export function sortProposals(proposals: Proposal[]): Proposal[] {
	const priorityOrder: Record<string, number> = {
		Strategic: 0,
		High: 1,
		Medium: 2,
		Low: 3,
	};

	return proposals.slice().sort((a, b) => {
		const pa = priorityOrder[a.priority] ?? 4;
		const pb = priorityOrder[b.priority] ?? 4;
		if (pa !== pb) return pa - pb;
		return b.updatedAt.localeCompare(a.updatedAt);
	});
}

/**
 * Group proposals by lane and status for the board layout.
 * Returns a nested Map: laneKey -> status -> Proposal[]
 */
export function groupProposalsByLaneAndStatus(
	mode: LaneMode,
	lanes: LaneDefinition[],
	_statuses: string[],
	proposals: Proposal[],
): Map<string, Map<string, Proposal[]>> {
	const map = new Map<string, Map<string, Proposal[]>>();

	for (const lane of lanes) {
		map.set(lane.key, new Map());
	}

	for (const proposal of proposals) {
		const key = laneKeyForProposal(mode, proposal);
		let statusMap = map.get(key);
		if (!statusMap) {
			statusMap = new Map();
			map.set(key, statusMap);
		}
		const status = proposal.status || "New";
		let list = statusMap.get(status);
		if (!list) {
			list = [];
			statusMap.set(status, list);
		}
		list.push(proposal);
	}

	// Sort within each status
	for (const [, statusMap] of map) {
		for (const [status, list] of statusMap) {
			statusMap.set(status, sortProposals(list));
		}
	}

	return map;
}
