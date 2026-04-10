import type { RoadmapConfig } from "../../types/index.ts";
import { DEFAULT_STATUSES } from "../../shared/constants/index.ts";
import { Core } from "../index.ts";

type CoreCallback<T> = (core: Core) => Promise<T>;

/**
 * Create a Core instance bound to the current working directory.
 */
function createCore(): Core {
	return new Core(process.cwd());
}

/**
 * Execute a callback with a Core instance, returning a fallback value if anything fails.
 */
async function withCore<T>(callback: CoreCallback<T>, fallback: T): Promise<T> {
	try {
		const core = createCore();
		return await callback(core);
	} catch {
		return fallback;
	}
}

function getDefaultStatuses(): string[] {
	return [...DEFAULT_STATUSES];
}

/**
 * Get all proposal IDs from the roadmap
 */
export async function getProposalIds(): Promise<string[]> {
	return await withCore(async (core) => {
		const proposals = await core.filesystem.listProposals();
		return proposals.map((proposal) => proposal.id).sort();
	}, []);
}

/**
 * Get configured status values
 */
export async function getStatuses(): Promise<string[]> {
	return await withCore(async (core) => {
		const config: RoadmapConfig | null = await core.filesystem.loadConfig();
		const statuses = config?.statuses;
		if (Array.isArray(statuses) && statuses.length > 0) {
			return statuses;
		}
		return getDefaultStatuses();
	}, getDefaultStatuses());
}

/**
 * Get priority values
 */
export function getPriorities(): string[] {
	return ["high", "medium", "low"];
}

/**
 * Get unique labels from all proposals
 */
export async function getLabels(): Promise<string[]> {
	return await withCore(async (core) => {
		const proposals = await core.filesystem.listProposals();
		const labels = new Set<string>();
		for (const proposal of proposals) {
			for (const label of proposal.labels) {
				labels.add(label);
			}
		}
		return Array.from(labels).sort();
	}, []);
}

/**
 * Get unique assignees from all proposals
 */
export async function getAssignees(): Promise<string[]> {
	return await withCore(async (core) => {
		const proposals = await core.filesystem.listProposals();
		const assignees = new Set<string>();
		for (const proposal of proposals) {
			for (const assignee of proposal.assignee) {
				assignees.add(assignee);
			}
		}
		return Array.from(assignees).sort();
	}, []);
}

/**
 * Get all document IDs from the roadmap
 */
export async function getDocumentIds(): Promise<string[]> {
	return await withCore(async (core) => {
		const docs = await core.filesystem.listDocuments();
		return docs.map((doc) => doc.id).sort();
	}, []);
}
