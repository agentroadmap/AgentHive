import { basename, join } from "node:path";
import {
	type Directive,
	isLocalEditableProposal,
	type Proposal,
	type ProposalListFilter,
	type SearchPriorityFilter,
} from "../../../../shared/types/index.ts";
import type {
	ProposalEditArgs,
	ProposalEditRequest,
} from "../../../../shared/types/proposal-edit-args.ts";
import {
	createDirectiveFilterValueResolver,
	normalizeDirectiveFilterValue,
	resolveClosestDirectiveFilterValue,
} from "../../../../shared/utils/milestone-filter.ts";
import { buildProposalUpdateInput } from "../../../../shared/utils/proposal-edit-builder.ts";
import { normalizeProposalId } from "../../../../shared/utils/proposal-path.ts";
import { createProposalSearchIndex } from "../../../../shared/utils/proposal-search.ts";
import { sortProposals } from "../../../../shared/utils/proposal-sorting.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { directiveKey } from "../../utils/milestone-resolution.ts";
import { formatProposalCallResult } from "../../utils/proposal-response.ts";

export type ProposalCreateArgs = {
	title: string;
	description?: string;
	rationale?: string;
	labels?: string[];
	assignee?: string[];
	priority?: "high" | "medium" | "low";
	status?: string;
	directive?: string;
	parentProposalId?: string;
	acceptanceCriteria?: string[];
	dependencies?: string[];
	references?: string[];
	documentation?: string[];
	finalSummary?: string;
};

export type ProposalListArgs = {
	status?: string;
	assignee?: string;
	directive?: string;
	labels?: string[];
	ready?: boolean;
	search?: string;
	limit?: number;
};

export type ProposalSearchArgs = {
	query: string;
	status?: string;
	priority?: SearchPriorityFilter;
	ready?: boolean;
	limit?: number;
};

export class ProposalHandlers {
	private readonly core: McpServer;

	constructor(core: McpServer) {
		this.core = core;
	}

	private async resolveDirectiveInput(directive: string): Promise<string> {
		const [activeDirectives, archivedDirectives] = await Promise.all([
			this.core.filesystem.listDirectives(),
			this.core.filesystem.listArchivedDirectives(),
		]);
		const normalized = directive.trim();
		const inputKey = directiveKey(normalized);
		const aliasKeys = new Set<string>([inputKey]);
		const looksLikeDirectiveId =
			/^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized);
		const canonicalInputId =
			/^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized)
				? `m-${String(Number.parseInt(normalized.replace(/^m-/i, ""), 10))}`
				: null;
		if (/^\d+$/.test(normalized)) {
			const numericAlias = String(Number.parseInt(normalized, 10));
			aliasKeys.add(numericAlias);
			aliasKeys.add(`m-${numericAlias}`);
		} else {
			const idMatch = normalized.match(/^m-(\d+)$/i);
			if (idMatch?.[1]) {
				const numericAlias = String(Number.parseInt(idMatch[1], 10));
				aliasKeys.add(numericAlias);
				aliasKeys.add(`m-${numericAlias}`);
			}
		}
		const idMatchesAlias = (directiveId: string): boolean => {
			const idKey = directiveKey(directiveId);
			if (aliasKeys.has(idKey)) {
				return true;
			}
			if (/^\d+$/.test(directiveId.trim())) {
				const numericAlias = String(Number.parseInt(directiveId.trim(), 10));
				return (
					aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`)
				);
			}
			const idMatch = directiveId.trim().match(/^m-(\d+)$/i);
			if (!idMatch?.[1]) {
				return false;
			}
			const numericAlias = String(Number.parseInt(idMatch[1], 10));
			return aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`);
		};
		const findIdMatch = (directives: Directive[]): Directive | undefined => {
			const rawExactMatch = directives.find(
				(item) => directiveKey(item.id) === inputKey,
			);
			if (rawExactMatch) {
				return rawExactMatch;
			}
			if (canonicalInputId) {
				const canonicalRawMatch = directives.find(
					(item) => directiveKey(item.id) === canonicalInputId,
				);
				if (canonicalRawMatch) {
					return canonicalRawMatch;
				}
			}
			return directives.find((item) => idMatchesAlias(item.id));
		};
		const findUniqueTitleMatch = (
			directives: Directive[],
		): Directive | null => {
			const titleMatches = directives.filter(
				(item) => directiveKey(item.title) === inputKey,
			);
			if (titleMatches.length === 1) {
				return titleMatches[0] ?? null;
			}
			return null;
		};
		const resolveByAlias = (directives: Directive[]): string | null => {
			const idMatch = findIdMatch(directives);
			const titleMatch = findUniqueTitleMatch(directives);
			if (looksLikeDirectiveId) {
				return idMatch?.id ?? null;
			}
			if (titleMatch) {
				return titleMatch.id;
			}
			if (idMatch) {
				return idMatch.id;
			}
			return null;
		};

		const activeTitleMatches = activeDirectives.filter(
			(item) => directiveKey(item.title) === inputKey,
		);
		const hasAmbiguousActiveTitle = activeTitleMatches.length > 1;
		if (looksLikeDirectiveId) {
			const activeIdMatch = findIdMatch(activeDirectives);
			if (activeIdMatch) {
				return activeIdMatch.id;
			}
			const archivedIdMatch = findIdMatch(archivedDirectives);
			if (archivedIdMatch) {
				return archivedIdMatch.id;
			}
			if (activeTitleMatches.length === 1) {
				return activeTitleMatches[0]?.id ?? normalized;
			}
			if (hasAmbiguousActiveTitle) {
				return normalized;
			}
			const archivedTitleMatch = findUniqueTitleMatch(archivedDirectives);
			return archivedTitleMatch?.id ?? normalized;
		}

		const activeMatch = resolveByAlias(activeDirectives);
		if (activeMatch) {
			return activeMatch;
		}
		if (hasAmbiguousActiveTitle) {
			return normalized;
		}
		return resolveByAlias(archivedDirectives) ?? normalized;
	}

	private isCompleteStatus(status?: string | null): boolean {
		const normalized = (status ?? "").trim().toLowerCase();
		return normalized.includes("done") || normalized.includes("complete");
	}

	private isDraftStatus(status?: string | null): boolean {
		return (status ?? "").trim().toLowerCase() === "draft";
	}

	private formatProposalSummaryLine(
		proposal: Proposal,
		options: { includeStatus?: boolean } = {},
	): string {
		const priorityIndicator = proposal.priority
			? `[${proposal.priority.toUpperCase()}] `
			: "";
		const readyIndicator = proposal.ready ? " [READY]" : "";
		const status =
			proposal.status || (proposal.origin === "completed" ? "Complete" : "");
		const statusText = options.includeStatus && status ? ` (${status})` : "";
		return `  ${priorityIndicator}${proposal.id} - ${proposal.title}${readyIndicator}${statusText}`;
	}

	private async loadProposalOrThrow(id: string): Promise<Proposal> {
		const proposal = await this.core.getProposal(id);
		if (!proposal) {
			throw new McpError(`Proposal not found: ${id}`, "STATE_NOT_FOUND");
		}
		return proposal;
	}

	async createProposal(args: ProposalCreateArgs): Promise<CallToolResult> {
		try {
			const acceptanceCriteria =
				args.acceptanceCriteria
					?.map((text) => String(text).trim())
					.filter((text) => text.length > 0)
					.map((text) => ({ text, checked: false })) ?? undefined;

			const directive =
				typeof args.directive === "string"
					? await this.resolveDirectiveInput(args.directive)
					: undefined;

			const { proposal: createdProposal } =
				await this.core.createProposalFromInput({
					title: args.title,
					description: args.description,
					status: args.status,
					priority: args.priority,
					directive,
					labels: args.labels,
					assignee: args.assignee,
					dependencies: args.dependencies,
					references: args.references,
					documentation: args.documentation,
					parentProposalId: args.parentProposalId,
					finalSummary: args.finalSummary,
					acceptanceCriteria,
					rationale: args.rationale,
				});

			return await formatProposalCallResult(createdProposal);
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "VALIDATION_ERROR");
			}
			throw new McpError(String(error), "VALIDATION_ERROR");
		}
	}

	async listProposals(args: ProposalListArgs = {}): Promise<CallToolResult> {
		return this.executeListProposals(args, false);
	}

	async listProposalsMetadata(
		args: ProposalListArgs = {},
	): Promise<CallToolResult> {
		return this.executeListProposals(args, true);
	}

	private async executeListProposals(
		args: ProposalListArgs,
		metadataOnly: boolean,
	): Promise<CallToolResult> {
		if (this.isDraftStatus(args.status)) {
			let drafts = await this.core.filesystem.listDrafts();
			if (args.search) {
				const draftSearch = createProposalSearchIndex(drafts);
				drafts = draftSearch.search({ query: args.search, status: "Draft" });
			}

			if (args.assignee) {
				drafts = drafts.filter((draft) =>
					(draft.assignee ?? []).includes(args.assignee ?? ""),
				);
			}
			if (args.directive) {
				const [activeDirectives, archivedDirectives] = await Promise.all([
					this.core.filesystem.listDirectives(),
					this.core.filesystem.listArchivedDirectives(),
				]);
				const resolveDirectiveFilterValue = createDirectiveFilterValueResolver([
					...activeDirectives,
					...archivedDirectives,
				]);
				const directiveFilter = resolveClosestDirectiveFilterValue(
					args.directive,
					drafts.map((draft) =>
						resolveDirectiveFilterValue(draft.directive ?? ""),
					),
				);
				drafts = drafts.filter(
					(draft) =>
						normalizeDirectiveFilterValue(
							resolveDirectiveFilterValue(draft.directive ?? ""),
						) === directiveFilter,
				);
			}

			const labelFilters = args.labels ?? [];
			if (labelFilters.length > 0) {
				drafts = drafts.filter((draft) => {
					const draftLabels = draft.labels ?? [];
					return labelFilters.every((label) => draftLabels.includes(label));
				});
			}

			if (drafts.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No proposals found.",
						},
					],
				};
			}

			let sortedDrafts = sortProposals(drafts, "priority");
			if (typeof args.limit === "number" && args.limit >= 0) {
				sortedDrafts = sortedDrafts.slice(0, args.limit);
			}
			const lines = ["Draft:"];
			for (const draft of sortedDrafts) {
				lines.push(this.formatProposalSummaryLine(draft));
			}

			return {
				content: [
					{
						type: "text",
						text: lines.join("\n"),
					},
				],
			};
		}

		const filters: ProposalListFilter = {};
		if (args.status) {
			filters.status = args.status;
		}
		if (args.assignee) {
			filters.assignee = args.assignee;
		}
		if (args.directive) {
			filters.directive = args.directive;
		}
		if (args.ready) {
			filters.ready = args.ready;
		}
		if (args.labels && args.labels.length > 0) {
			filters.labels = args.labels;
		}

		const proposals = await this.core.queryProposals({
			query: args.search,
			limit: args.limit,
			filters: Object.keys(filters).length > 0 ? filters : undefined,
			includeCrossBranch: false,
		});

		let filteredByLabels = proposals.filter((proposal) =>
			isLocalEditableProposal(proposal),
		);
		const labelFilters = args.labels ?? [];
		if (labelFilters.length > 0) {
			filteredByLabels = filteredByLabels.filter((proposal) => {
				const proposalLabels = proposal.labels ?? [];
				return labelFilters.every((label) => proposalLabels.includes(label));
			});
		}

		if (filteredByLabels.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No proposals found.",
					},
				],
			};
		}

		if (metadataOnly) {
			const lines = filteredByLabels.map((s) =>
				this.formatProposalSummaryLine(s, { includeStatus: true }),
			);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		}

		const config = await this.core.filesystem.loadConfig();
		const statuses = config?.statuses ?? [];

		const canonicalByLower = new Map<string, string>();
		for (const status of statuses) {
			canonicalByLower.set(status.toLowerCase(), status);
		}

		const grouped = new Map<string, Proposal[]>();
		for (const proposal of filteredByLabels) {
			const rawStatus = (proposal.status ?? "").trim();
			const canonicalStatus =
				canonicalByLower.get(rawStatus.toLowerCase()) ?? rawStatus;
			const bucketKey = canonicalStatus || "";
			const existing = grouped.get(bucketKey) ?? [];
			existing.push(proposal);
			grouped.set(bucketKey, existing);
		}

		const orderedStatuses = [
			...statuses.filter((status) => grouped.has(status)),
			...Array.from(grouped.keys()).filter(
				(status) => !statuses.includes(status),
			),
		];

		const contentItems: Array<{ type: "text"; text: string }> = [];
		for (const status of orderedStatuses) {
			const bucket = grouped.get(status) ?? [];
			const sortedBucket = sortProposals(bucket, "priority");
			const sectionLines: string[] = [`${status || "No Status"}:`];
			for (const proposal of sortedBucket) {
				sectionLines.push(this.formatProposalSummaryLine(proposal));
			}
			contentItems.push({
				type: "text",
				text: sectionLines.join("\n"),
			});
		}

		if (contentItems.length === 0) {
			contentItems.push({
				type: "text",
				text: "No proposals found.",
			});
		}

		return {
			content: contentItems,
		};
	}

	async searchProposals(args: ProposalSearchArgs): Promise<CallToolResult> {
		const query = args.query.trim();
		if (!query) {
			throw new McpError("Search query cannot be empty", "VALIDATION_ERROR");
		}

		if (this.isDraftStatus(args.status)) {
			const drafts = await this.core.filesystem.listDrafts();
			const searchIndex = createProposalSearchIndex(drafts);
			let draftMatches = searchIndex.search({
				query,
				status: "Draft",
				priority: args.priority,
			});
			if (typeof args.limit === "number" && args.limit >= 0) {
				draftMatches = draftMatches.slice(0, args.limit);
			}

			if (draftMatches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No proposals found for "${query}".`,
						},
					],
				};
			}

			const lines: string[] = ["Proposals:"];
			for (const draft of draftMatches) {
				lines.push(
					this.formatProposalSummaryLine(draft, { includeStatus: true }),
				);
			}

			return {
				content: [
					{
						type: "text",
						text: lines.join("\n"),
					},
				],
			};
		}

		const proposals = await this.core.loadProposals(undefined, undefined, {
			includeCompleted: true,
		});
		const searchIndex = createProposalSearchIndex(proposals);
		let proposalMatches = searchIndex.search({
			query,
			status: args.status,
			priority: args.priority,
			ready: args.ready,
		});
		if (typeof args.limit === "number" && args.limit >= 0) {
			proposalMatches = proposalMatches.slice(0, args.limit);
		}

		const proposalResults = proposalMatches.filter((proposal) =>
			isLocalEditableProposal(proposal),
		);
		if (proposalResults.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No proposals found for "${query}".`,
					},
				],
			};
		}

		const lines: string[] = ["Proposals:"];
		for (const proposal of proposalResults) {
			lines.push(
				this.formatProposalSummaryLine(proposal, { includeStatus: true }),
			);
		}

		return {
			content: [
				{
					type: "text",
					text: lines.join("\n"),
				},
			],
		};
	}

	async viewProposal(args: { id: string }): Promise<CallToolResult> {
		const draft = await this.core.filesystem.loadDraft(args.id);
		if (draft) {
			return await formatProposalCallResult(draft);
		}

		const proposal = await this.core.getProposalWithSubproposals(args.id);
		if (!proposal) {
			throw new McpError(`Proposal not found: ${args.id}`, "STATE_NOT_FOUND");
		}
		return await formatProposalCallResult(proposal);
	}

	async archiveProposal(args: { id: string }): Promise<CallToolResult> {
		const draft = await this.core.filesystem.loadDraft(args.id);
		if (draft) {
			const success = await this.core.archiveDraft(draft.id);
			if (!success) {
				throw new McpError(
					`Failed to archive proposal: ${args.id}`,
					"OPERATION_FAILED",
				);
			}

			return await formatProposalCallResult(draft, [
				`Archived draft ${draft.id}.`,
			]);
		}

		const proposal = await this.loadProposalOrThrow(args.id);

		if (!isLocalEditableProposal(proposal)) {
			throw new McpError(
				`Cannot archive proposal from another branch: ${proposal.id}`,
				"VALIDATION_ERROR",
			);
		}

		if (this.isCompleteStatus(proposal.status)) {
			throw new McpError(
				`Proposal ${proposal.id} is already Complete. Complete proposals should be archived only if they were errors. Use proposal_complete instead for successful delivery.`,
				"VALIDATION_ERROR",
			);
		}

		const success = await this.core.archiveProposal(proposal.id);
		if (!success) {
			throw new McpError(
				`Failed to archive proposal: ${args.id}`,
				"OPERATION_FAILED",
			);
		}

		const refreshed = (await this.core.getProposal(proposal.id)) ?? proposal;
		return await formatProposalCallResult(refreshed);
	}

	async completeProposal(args: { id: string }): Promise<CallToolResult> {
		const proposal = await this.loadProposalOrThrow(args.id);

		if (!isLocalEditableProposal(proposal)) {
			throw new McpError(
				`Cannot complete proposal from another branch: ${proposal.id}`,
				"VALIDATION_ERROR",
			);
		}

		if (!this.isCompleteStatus(proposal.status)) {
			throw new McpError(
				`Proposal ${proposal.id} is not Complete. Set status to "Complete" with proposal_edit before completing it.`,
				"VALIDATION_ERROR",
			);
		}

		const filePath = proposal.filePath ?? null;
		const completedFilePath = filePath
			? join(this.core.filesystem.completedDir, basename(filePath))
			: undefined;

		const success = await this.core.completeProposal(proposal.id);
		if (!success) {
			throw new McpError(
				`Failed to complete proposal: ${args.id}`,
				"OPERATION_FAILED",
			);
		}

		return await formatProposalCallResult(
			proposal,
			[`Completed proposal ${proposal.id}.`],
			{
				filePathOverride: completedFilePath,
			},
		);
	}

	async demoteProposalSimple(args: { id: string }): Promise<CallToolResult> {
		const proposal = await this.loadProposalOrThrow(args.id);
		const success = await this.core.demoteProposal(proposal.id, false);
		if (!success) {
			throw new McpError(
				`Failed to demote proposal: ${args.id}`,
				"OPERATION_FAILED",
			);
		}

		const refreshed = (await this.core.getProposal(proposal.id)) ?? proposal;
		return await formatProposalCallResult(refreshed);
	}

	async editProposal(args: ProposalEditRequest): Promise<CallToolResult> {
		try {
			const updateInput = buildProposalUpdateInput(args);
			if (typeof updateInput.directive === "string") {
				updateInput.directive = await this.resolveDirectiveInput(
					updateInput.directive,
				);
			}
			const updatedProposal = await this.core.editProposalOrDraft(
				args.id,
				updateInput,
			);

			return await formatProposalCallResult(updatedProposal);
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "VALIDATION_ERROR");
			}
			throw new McpError(String(error), "VALIDATION_ERROR");
		}
	}

	async claimProposal(args: {
		id: string;
		agent: string;
		durationMinutes?: number;
		message?: string;
		force?: boolean;
	}): Promise<CallToolResult> {
		try {
			const proposal = await this.core.claimProposal(args.id, args.agent, {
				durationMinutes: args.durationMinutes,
				message: args.message,
				force: args.force,
				autoCommit: true,
			});
			return await formatProposalCallResult(proposal, [
				`Claimed proposal ${args.id} for ${args.agent}.`,
			]);
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async releaseProposal(args: {
		id: string;
		agent: string;
		force?: boolean;
	}): Promise<CallToolResult> {
		try {
			const proposal = await this.core.releaseClaim(args.id, args.agent, {
				force: args.force,
				autoCommit: true,
			});
			return await formatProposalCallResult(proposal, [
				`Released claim on proposal ${args.id}.`,
			]);
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async renewProposal(args: {
		id: string;
		agent: string;
		durationMinutes?: number;
	}): Promise<CallToolResult> {
		try {
			const proposal = await this.core.renewClaim(args.id, args.agent, {
				durationMinutes: args.durationMinutes,
				autoCommit: true,
			});
			return await formatProposalCallResult(proposal, [
				`Renewed claim on proposal ${args.id} for ${args.agent}.`,
			]);
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async heartbeatProposal(args: {
		id: string;
		agent: string;
	}): Promise<CallToolResult> {
		try {
			const proposal = await this.core.heartbeat(args.id, args.agent, true);
			return await formatProposalCallResult(proposal, [
				`Heartbeat recorded for proposal ${args.id} (Claim valid until ${proposal.claim?.expires}).`,
			]);
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async pruneClaims(args: {
		timeoutMinutes?: number;
	}): Promise<CallToolResult> {
		try {
			const recoveredIds = await this.core.pruneClaims({
				timeoutMinutes: args.timeoutMinutes,
				autoCommit: true,
			});
			const message =
				recoveredIds.length > 0
					? `Recovered ${recoveredIds.length} stale leases: ${recoveredIds.join(", ")}.`
					: "No stale leases found.";
			return {
				content: [{ type: "text", text: message }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async pickupProposal(args: {
		agent: string;
		dryRun?: boolean;
		durationMinutes?: number;
	}): Promise<CallToolResult> {
		try {
			const result = await this.core.pickupProposal({
				agent: args.agent,
				dryRun: args.dryRun,
				durationMinutes: args.durationMinutes,
			});

			if (!result) {
				return {
					content: [
						{ type: "text", text: "No ready proposals found for pickup." },
					],
				};
			}

			const { proposal, explanation } = result;
			const message = args.dryRun
				? explanation
				: `${explanation}\nSuccessfully claimed ${proposal.id} for ${args.agent} until ${proposal.claim?.expires}`;

			return await formatProposalCallResult(proposal, [message]);
		} catch (error) {
			if (error instanceof Error) {
				if (error.message.includes("not found")) {
					return {
						content: [{ type: "text", text: error.message }],
					};
				}
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async impactProposal(args: { id: string }): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const impact = await this.core.getImpact(proposalId);
			if (impact.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No downstream proposals are affected by this change.",
						},
					],
				};
			}

			const lines = [
				`Forward Impact Analysis for ${proposalId}:`,
				`The following ${impact.length} proposals depend on this path:`,
			];
			for (const proposal of impact) {
				lines.push(`- ${proposal.id} - ${proposal.title} [${proposal.status}]`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async promoteProposal(args: {
		id: string;
		agent?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const proposal = await this.core.promoteProposal(
				proposalId,
				args.agent || "agent",
				true,
			);
			return await formatProposalCallResult(proposal, [
				`Promoted proposal ${proposalId} to ${proposal.status}`,
			]);
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async demoteProposal(args: {
		id: string;
		agent?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const proposal = await this.core.demoteProposalProper(
				proposalId,
				args.agent || "agent",
				true,
			);
			return await formatProposalCallResult(proposal, [
				`Demoted proposal ${proposalId} to ${proposal.status}`,
			]);
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async priorityUp(args: {
		id: string;
		agent?: string;
		rationale?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const proposal = await this.core.getProposal(proposalId);
			if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

			const priorities: Array<"none" | "low" | "medium" | "high" | "critical"> =
				["none", "low", "medium", "high", "critical"];
			const currentIdx = priorities.indexOf(
				(proposal.priority as any) || "none",
			);
			const nextIdx = Math.min(priorities.length - 1, currentIdx + 1);

			const updated = await this.core.updatePriority(
				proposalId,
				priorities[nextIdx] as any,
				args.agent || "agent",
				true,
			);
			if (args.rationale) {
				await this.core.editProposal(
					proposalId,
					{
						implementationNotes: `Priority increased to ${priorities[nextIdx]}. Rationale: ${args.rationale}`,
					},
					true,
				);
			}
			return await formatProposalCallResult(updated, [
				`Increased priority of ${proposalId} to ${updated.priority}`,
			]);
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async priorityDown(args: {
		id: string;
		agent?: string;
		rationale?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const proposal = await this.core.getProposal(proposalId);
			if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

			const priorities: Array<"none" | "low" | "medium" | "high" | "critical"> =
				["none", "low", "medium", "high", "critical"];
			const currentIdx = priorities.indexOf(
				(proposal.priority as any) || "none",
			);
			const nextIdx = Math.max(0, currentIdx - 1);

			const updated = await this.core.updatePriority(
				proposalId,
				priorities[nextIdx] as any,
				args.agent || "agent",
				true,
			);
			if (args.rationale) {
				await this.core.editProposal(
					proposalId,
					{
						implementationNotes: `Priority decreased to ${priorities[nextIdx]}. Rationale: ${args.rationale}`,
					},
					true,
				);
			}
			return await formatProposalCallResult(updated, [
				`Decreased priority of ${proposalId} to ${updated.priority}`,
			]);
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async mergeProposals(args: {
		sourceId: string;
		targetId: string;
		agent?: string;
	}): Promise<CallToolResult> {
		try {
			const sourceId = normalizeProposalId(args.sourceId);
			const targetId = normalizeProposalId(args.targetId);
			const proposal = await this.core.mergeProposals(
				sourceId,
				targetId,
				args.agent || "agent",
				true,
			);
			return await formatProposalCallResult(proposal, [
				`Merged ${sourceId} into ${targetId}`,
			]);
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async moveProposal(args: {
		id: string;
		targetStatus: string;
		targetIndex: number;
		agent?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const proposal = await this.core.moveProposal(
				proposalId,
				args.targetStatus,
				args.targetIndex,
				args.agent || "agent",
				true,
			);
			return await formatProposalCallResult(proposal, [
				`Moved proposal ${proposalId} to ${args.targetStatus} at index ${args.targetIndex}`,
			]);
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async requestEnrichment(args: {
		id: string;
		topic: string;
		agent?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			await this.core.emitPulse({
				type: "scope_aggregated",
				id: proposalId,
				title: `Enrichment requested: ${args.topic}`,
				agent: args.agent || "agent",
				timestamp: new Date().toISOString(),
			});
			return {
				content: [
					{
						type: "text",
						text: `✅ Enrichment request for ${proposalId} on topic "${args.topic}" has been logged.`,
					},
				],
			};
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async proposalExport(args: {
		id: string;
		format: "markdown" | "json";
	}): Promise<CallToolResult> {
		try {
			const proposalId = normalizeProposalId(args.id);
			const proposal = await this.core.getProposal(proposalId);
			if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

			let output = "";
			if (args.format === "json") {
				output = JSON.stringify(proposal, null, 2);
			} else {
				const { generateProposalMarkdown } = await import(
					"../../../../shared/utils/proposal-markdown-generator.ts"
				);
				output = generateProposalMarkdown(proposal);
			}

			return {
				content: [{ type: "text", text: output }],
			};
		} catch (error) {
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}
}

export type { ProposalEditArgs, ProposalEditRequest };
