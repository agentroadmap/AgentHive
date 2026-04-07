import { FALLBACK_STATUS } from "../../constants/index.ts";
import type { FileSystem } from "../../file-system/operations.ts";
import type { GitOperations } from "../../git/operations.ts";
import {
	EntityType,
	isLocalEditableProposal,
	type Proposal,
	type ProposalCreateInput,
	type ProposalListFilter,
} from "../../types/index.ts";
import {
	normalizeDependencies,
	normalizeStringList,
} from "../../utils/proposal-builders.ts";
import { proposalIdsEqual } from "../../utils/proposal-path.ts";
import { attachSubproposalSummaries } from "../../utils/proposal-subproposals.ts";
import type { IdRegistry } from "../identity/id-registry.ts";
import type { DaemonClient } from "../infrastructure/daemon-client.ts";
import type { ContentStore } from "../storage/content-store.ts";
import { isReachedStatus, isReady } from "./directives.ts";

export interface ProposalQueryOptions {
	filters?: ProposalListFilter;
	query?: string;
	limit?: number;
	includeCrossBranch?: boolean;
}

export class ProposalManager {
	constructor(
		private fs: FileSystem,
		private git: GitOperations,
		private idRegistry: IdRegistry,
		private getContentStore: () => Promise<ContentStore>,
		private getDaemonClient: () => Promise<DaemonClient | null>,
		private recordPulse: (event: any) => Promise<void>,
	) {}

	async queryProposals(
		options: ProposalQueryOptions = {},
	): Promise<Proposal[]> {
		const { filters, query, limit } = options;
		const trimmedQuery = query?.trim();
		const includeCrossBranch = options.includeCrossBranch ?? true;

		// Simple list queries via daemon if possible
		const daemon = await this.getDaemonClient();
		if (daemon && !trimmedQuery && !includeCrossBranch) {
			try {
				const daemonFilters: any = {};
				if (filters?.status) daemonFilters.status = filters.status;
				if (filters?.assignee) daemonFilters.assignee = filters.assignee;
				if (filters?.priority) daemonFilters.priority = filters.priority;
				if (filters?.labels) daemonFilters.labels = filters.labels;

				const proposals = await daemon.listProposals(
					Object.keys(daemonFilters).length > 0 ? daemonFilters : undefined,
				);

				const filtered = await this.applyProposalFilters(
					proposals,
					{
						...filters,
						directive: undefined,
						parentProposalId: undefined,
						ready: undefined,
					},
					proposals,
				);

				if (
					!filters?.directive &&
					!filters?.parentProposalId &&
					!filters?.ready
				) {
					return typeof limit === "number" && limit >= 0
						? filtered.slice(0, limit)
						: filtered;
				}
			} catch (error) {
				console.warn(`Daemon query failed, falling back to local: ${error}`);
			}
		}

		const store = await this.getContentStore();
		let proposals = store.getProposals();
		if (proposals.length === 0) {
			proposals = await this.fs.listProposals();
		}

		let filtered = await this.applyProposalFilters(
			proposals,
			filters,
			proposals,
		);
		if (!includeCrossBranch) {
			filtered = filtered.filter(isLocalEditableProposal);
		}

		if (trimmedQuery) {
			// Search logic would go here, simplified for now to use local filter
			filtered = filtered.filter(
				(s) =>
					s.title.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
					s.description?.toLowerCase().includes(trimmedQuery.toLowerCase()),
			);
		}

		return typeof limit === "number" && limit >= 0
			? filtered.slice(0, limit)
			: filtered;
	}

	private async applyProposalFilters(
		proposals: Proposal[],
		filters?: ProposalListFilter,
		allProposals?: Proposal[],
	): Promise<Proposal[]> {
		const referenceProposals =
			allProposals && allProposals.length > 0 ? allProposals : proposals;
		let result = proposals.map((proposal) =>
			attachSubproposalSummaries(proposal, referenceProposals),
		);

		if (filters) {
			if (filters.status) {
				const statusLower = filters.status.toLowerCase();
				result = result.filter(
					(proposal) => (proposal.status ?? "").toLowerCase() === statusLower,
				);
			}
			if (filters.assignee) {
				const assigneeLower = filters.assignee.toLowerCase();
				result = result.filter((proposal) =>
					(proposal.assignee ?? []).some(
						(value) => value.toLowerCase() === assigneeLower,
					),
				);
			}
			if (filters.priority) {
				const priorityLower = String(filters.priority).toLowerCase();
				result = result.filter(
					(proposal) =>
						(proposal.priority ?? "").toLowerCase() === priorityLower,
				);
			}
			if (filters.parentProposalId) {
				const parentFilter = filters.parentProposalId;
				result = result.filter(
					(proposal) =>
						proposal.parentProposalId &&
						proposalIdsEqual(parentFilter, proposal.parentProposalId),
				);
			}
			if (filters.labels && filters.labels.length > 0) {
				const requiredLabels = filters.labels
					.map((label) => label.toLowerCase())
					.filter(Boolean);
				result = result.filter((proposal) => {
					const proposalLabels =
						proposal.labels?.map((label) => label.toLowerCase()) || [];
					return requiredLabels.some((label) => proposalLabels.includes(label));
				});
			}
		}

		if (filters?.ready) {
			const doneIds = new Set(
				referenceProposals
					.filter((t) => isReachedStatus(t.status))
					.map((t) => t.id),
			);
			result = result.filter((proposal) =>
				isReady(proposal, doneIds, referenceProposals),
			);
		}

		return result;
	}

	async getProposal(proposalId: string): Promise<Proposal | null> {
		const daemon = await this.getDaemonClient();
		if (daemon) {
			try {
				const proposal = await daemon.getProposal(proposalId);
				if (proposal) return proposal;
			} catch {}
		}

		const store = await this.getContentStore();
		const match = store
			.getProposals()
			.find((proposal) => proposalIdsEqual(proposalId, proposal.id));
		if (match) return match;

		return await this.fs.loadProposal(proposalId);
	}

	async createProposal(
		input: ProposalCreateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		const isDraft = input.status?.toLowerCase() === "draft";
		const entityType = isDraft ? EntityType.Draft : EntityType.Proposal;

		const allocatedId = await this.idRegistry.allocateId({
			sessionId: entityType,
		});
		const id = allocatedId.ids[0];

		const proposal: Proposal = {
			id,
			title: input.title.trim(),
			status: isDraft ? "Draft" : input.status || FALLBACK_STATUS,
			assignee: normalizeStringList(input.assignee) ?? [],
			labels: normalizeStringList(input.labels) ?? [],
			dependencies: normalizeDependencies(input.dependencies),
			rawContent: input.rawContent ?? "",
			createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
			description: input.description,
			parentProposalId: input.parentProposalId,
			priority: input.priority as any,
			directive: input.directive,
		};

		const filepath = isDraft
			? await this.fs.saveDraft(proposal)
			: await this.fs.saveProposal(proposal);

		if (autoCommit) {
			await this.git.addAndCommitProposalFile(proposal.id, filepath, "create");
		}

		await this.recordPulse({
			type: "proposal_created",
			id: proposal.id,
			title: proposal.title,
		});

		return proposal;
	}
}
