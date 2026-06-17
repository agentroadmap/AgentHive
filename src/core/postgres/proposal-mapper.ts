/**
 * Postgres proposal hydration layer.
 *
 * Pure row-mapping translation between Postgres `ProposalRow` records and the
 * domain `Proposal` shape. Extracted from the `Core` class (P3796 monolith
 * decomposition, Phase 1, AC-22).
 *
 * Only pure row-mapping lives here. The single hydration entry point
 * (`hydrate`) may resolve a proposal summary / parent display id from the
 * storage layer when the caller did not pre-fetch them — these are direct
 * row translations, not query orchestration. Activity loading, pool init and
 * proposal listing remain in `Core`.
 *
 * This module must not import from `roadmap.ts` (no circular imports). It
 * imports the storage layer (`proposal-storage-v2.ts`) which is a pure
 * data-access module.
 */
import { formatLocalDateTime } from "../../utils/date-time.ts";
import type {
	ProposalAcceptanceCriterionRow,
	ProposalActivity,
	ProposalDependency,
	ProposalRow,
	ProposalSummary,
} from "../../infra/postgres/proposal-storage-v2.ts";
import * as pg from "../../infra/postgres/proposal-storage-v2.ts";
import {
	type AcceptanceCriterion,
	type ActivityLogEntry,
	type Proposal,
} from "../../types/index.ts";

export interface HydratePgProposalOptions {
	summary?: ProposalSummary | null;
	dependencies?: ProposalDependency[];
	acceptanceCriteria?: ProposalAcceptanceCriterionRow[];
	parentProposalId?: string;
	activity?: ProposalActivity | null;
	activityLog?: ActivityLogEntry[];
}

export class PgProposalHydrator {
	getPgTagMetadata(
		tags: ProposalRow["tags"],
	): Record<string, unknown> | null {
		if (!tags || Array.isArray(tags) || typeof tags !== "object") {
			return null;
		}
		return tags as Record<string, unknown>;
	}

	getPgTagString(
		tags: ProposalRow["tags"],
		key: string,
	): string | undefined {
		const metadata = this.getPgTagMetadata(tags);
		const value = metadata?.[key];
		return typeof value === "string" && value.trim().length > 0
			? value
			: undefined;
	}

	getPgTagStringArray(
		tags: ProposalRow["tags"],
		key: string,
	): string[] | undefined {
		const metadata = this.getPgTagMetadata(tags);
		const value = metadata?.[key];
		if (!Array.isArray(value)) {
			return undefined;
		}
		const normalized = value
			.map((item) => String(item).trim())
			.filter(Boolean);
		return normalized.length > 0 ? normalized : undefined;
	}

	buildPgTags(proposal: Proposal): Record<string, unknown> | null {
		const tags: Record<string, unknown> = {};

		if (proposal.labels.length > 0) tags.labels = [...proposal.labels];
		if (proposal.directive?.trim()) tags.directive = proposal.directive.trim();
		if (proposal.domainId?.trim()) tags.domainId = proposal.domainId.trim();
		if (proposal.category?.trim()) tags.category = proposal.category.trim();
		if (proposal.references && proposal.references.length > 0)
			tags.references = [...proposal.references];
		if (proposal.documentation && proposal.documentation.length > 0)
			tags.documentation = [...proposal.documentation];
		if (proposal.proof && proposal.proof.length > 0)
			tags.proof = [...proposal.proof];
		if (proposal.needs_capabilities && proposal.needs_capabilities.length > 0) {
			tags.needs_capabilities = [...proposal.needs_capabilities];
		}
		if (
			proposal.required_capabilities &&
			proposal.required_capabilities.length > 0
		) {
			tags.required_capabilities = [...proposal.required_capabilities];
		}
		if (
			proposal.external_injections &&
			proposal.external_injections.length > 0
		) {
			tags.external_injections = [...proposal.external_injections];
		}
		if (proposal.unlocks && proposal.unlocks.length > 0)
			tags.unlocks = [...proposal.unlocks];
		if (proposal.rationale?.trim()) tags.rationale = proposal.rationale.trim();
		if (proposal.implementationNotes?.trim())
			tags.implementationNotes = proposal.implementationNotes.trim();
		if (proposal.auditNotes?.trim())
			tags.auditNotes = proposal.auditNotes.trim();
		if (proposal.finalSummary?.trim())
			tags.finalSummary = proposal.finalSummary.trim();
		if (proposal.scopeSummary?.trim())
			tags.scopeSummary = proposal.scopeSummary.trim();
		if (proposal.builder?.trim()) tags.builder = proposal.builder.trim();
		if (proposal.auditor?.trim()) tags.auditor = proposal.auditor.trim();
		if (proposal.rawContent?.trim())
			tags.rawContent = proposal.rawContent.trim();
		if (
			proposal.verificationProposalments &&
			proposal.verificationProposalments.length > 0
		) {
			tags.verificationProposalments = proposal.verificationProposalments.map(
				(item) => ({
					index: item.index,
					text: item.text,
					checked: item.checked,
					role: item.role,
					evidence: item.evidence,
				}),
			);
		}

		return Object.keys(tags).length > 0 ? tags : null;
	}

	mapPgAcceptanceCriteria(
		rows: ProposalAcceptanceCriterionRow[],
	): AcceptanceCriterion[] {
		return rows.map((row) => ({
			index: row.item_number,
			text: row.criterion_text,
			checked: row.status === "pass",
			evidence: row.verification_notes ?? undefined,
			role: row.verified_by ?? undefined,
		}));
	}

	async hydrate(
		row: ProposalRow,
		options?: HydratePgProposalOptions,
	): Promise<Proposal> {
		const summary = options?.summary ?? (await pg.getProposalSummary(row.id));
		const activity = options?.activity ?? null;
		const activityLog = options?.activityLog;
		const dependencies = (options?.dependencies ?? []).filter(
			(dependency) =>
				dependency.from_proposal_id === row.id &&
				dependency.dependency_type === "blocks" &&
				!dependency.resolved,
		);
		const acceptanceCriteria = options?.acceptanceCriteria ?? [];
		const metadata = this.getPgTagMetadata(row.tags);

		const id = row.display_id || `#${row.id}`;
		const labels = this.mapPgLabels(row.tags);
		const rawContent = this.buildPgRawContent(row);
		const maturity = this.mapPgMaturity(row);
		const priority = this.mapPgPriority(row.priority);
		const leaseActive =
			Boolean(summary?.leased_by) &&
			(summary?.lease_expires === null ||
				summary?.lease_expires === undefined ||
				new Date(summary.lease_expires) > new Date());
		// P270: prefer active lease holder, fall back to gate dispatch agent so
		// the board shows "who's on this" even during gate review when there's
		// no lease yet.
		const liveAssignee = leaseActive
			? (summary?.leased_by ?? activity?.lease_holder ?? null)
			: (activity?.gate_dispatch_agent ?? null);
		const assignee = liveAssignee ? [liveAssignee] : [];
		const claimCreated = summary?.leased_at
			? formatLocalDateTime(new Date(summary.leased_at))
			: undefined;
		const claimExpires = summary?.lease_expires
			? formatLocalDateTime(new Date(summary.lease_expires))
			: claimCreated;
		const parentProposalId =
			options?.parentProposalId ??
			(row.parent_id !== null
				? ((await pg.getProposal(row.parent_id))?.display_id ?? undefined)
				: undefined);

		return {
			id,
			title: row.title || "(no title)",
			status: row.status,
			assignee,
			labels,
			dependencies: dependencies.map((dependency) => dependency.to_display_id),
			rawContent,
			summary: row.summary || undefined,
			motivation: row.motivation || undefined,
			design: row.design || undefined,
			drawbacks: row.drawbacks || undefined,
			alternatives: row.alternatives || undefined,
			dependency_note: row.dependency_note || undefined,
			description: row.summary || undefined,
			implementationPlan: row.design || undefined,
			implementationNotes: this.getPgTagString(row.tags, "implementationNotes"),
			auditNotes: this.getPgTagString(row.tags, "auditNotes"),
			finalSummary: this.getPgTagString(row.tags, "finalSummary"),
			scopeSummary: this.getPgTagString(row.tags, "scopeSummary"),
			createdDate: row.created_at
				? new Date(row.created_at)
						.toISOString()
						.slice(0, 16)
						.replace("T", " ")
				: undefined,
			updatedDate: row.modified_at || row.created_at
				? new Date(row.modified_at || row.created_at)
						.toISOString()
						.slice(0, 16)
						.replace("T", " ")
				: undefined,
			proposalType: row.type,
			domainId: this.getPgTagString(row.tags, "domainId"),
			category: this.getPgTagString(row.tags, "category"),
			directive: this.getPgTagString(row.tags, "directive"),
			references: this.getPgTagStringArray(row.tags, "references"),
			documentation: this.getPgTagStringArray(row.tags, "documentation"),
			proof: this.getPgTagStringArray(row.tags, "proof"),
			needs_capabilities: this.getPgTagStringArray(
				row.tags,
				"needs_capabilities",
			),
			required_capabilities: this.getPgTagStringArray(
				row.tags,
				"required_capabilities",
			),
			external_injections: this.getPgTagStringArray(
				row.tags,
				"external_injections",
			),
			unlocks: this.getPgTagStringArray(row.tags, "unlocks"),
			rationale: this.getPgTagString(row.tags, "rationale"),
			builder: this.getPgTagString(row.tags, "builder"),
			auditor: this.getPgTagString(row.tags, "auditor"),
			...(parentProposalId && { parentProposalId }),
			...(acceptanceCriteria.length > 0 && {
				acceptanceCriteriaItems:
					this.mapPgAcceptanceCriteria(acceptanceCriteria),
			}),
			...(summary?.leased_by && leaseActive && claimCreated && claimExpires
				? {
						claim: {
							agent: summary.leased_by,
							created: claimCreated,
							expires: claimExpires,
						},
					}
				: {}),
			...(maturity && { maturity }),
			...(priority && { priority }),
			...(activityLog && activityLog.length > 0 ? { activityLog } : {}),
			...(activity
				? (() => {
						const live: NonNullable<Proposal["liveActivity"]> = {};
						if (activity.lease_holder) live.leaseHolder = activity.lease_holder;
						if (activity.gate_dispatch_agent)
							live.gateDispatchAgent = activity.gate_dispatch_agent;
						if (activity.gate_dispatch_role)
							live.gateDispatchRole = activity.gate_dispatch_role;
						if (activity.gate_dispatch_status)
							live.gateDispatchStatus = activity.gate_dispatch_status;
						if (activity.active_cubic) live.activeCubic = activity.active_cubic;
						if (activity.active_model) live.activeModel = activity.active_model;
						if (typeof activity.heartbeat_age_seconds === "number")
							live.heartbeatAgeSeconds = activity.heartbeat_age_seconds;
						if (activity.last_event_type)
							live.lastEventType = activity.last_event_type;
						if (activity.last_event_at)
							live.lastEventAt = new Date(activity.last_event_at).toISOString();
						return Object.keys(live).length > 0 ? { liveActivity: live } : {};
					})()
				: {}),
			...(metadata?.verificationProposalments &&
			Array.isArray(metadata.verificationProposalments) &&
			metadata.verificationProposalments.length > 0
				? {
						verificationProposalments: metadata.verificationProposalments.map(
							(item, index) => ({
								index:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { index?: unknown }).index === "number"
										? (item as { index: number }).index
										: index + 1,
								text:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { text?: unknown }).text === "string"
										? String((item as { text: string }).text)
										: String(item),
								checked:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { checked?: unknown }).checked === "boolean"
										? Boolean((item as { checked: boolean }).checked)
										: false,
								role:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { role?: unknown }).role === "string"
										? String((item as { role: string }).role)
										: undefined,
								evidence:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { evidence?: unknown }).evidence === "string"
										? String((item as { evidence: string }).evidence)
										: undefined,
							}),
						),
					}
				: {}),
		};
	}

	buildPgRawContent(row: ProposalRow): string {
		const rawContent = this.getPgTagString(row.tags, "rawContent");
		const sections = [
			["Summary", row.summary],
			["Motivation", row.motivation],
			["Design", row.design],
			["Drawbacks", row.drawbacks],
			["Alternatives", row.alternatives],
			["Dependency Note", row.dependency_note],
		].flatMap(([heading, value]) => {
			const content = value?.trim();
			return content ? [[heading, content] as [string, string]] : [];
		});

		if (sections.length === 0) {
			return rawContent ?? "";
		}

		if (sections.length === 1) {
			return sections[0][1].trim();
		}

		const built = sections
			.map(([heading, value]) => `## ${heading}\n\n${value.trim()}`)
			.join("\n\n");
		return rawContent && rawContent.trim().length > 0
			? `${built}\n\n${rawContent.trim()}`
			: built;
	}

	mapPgLabels(tags: ProposalRow["tags"]): string[] {
		const metadataPrefixes = [
			"labels:",
			"directive:",
			"domainid:",
			"category:",
			"references:",
			"documentation:",
			"proof:",
			"needs_capabilities:",
			"required_capabilities:",
			"external_injections:",
			"unlocks:",
			"rationale:",
			"implementationnotes:",
			"auditnotes:",
			"finalsummary:",
			"scopesummary:",
			"builder:",
			"auditor:",
			"rawcontent:",
		];
		const sanitizeLabels = (labels: string[]): string[] =>
			labels
				.map((label) => label.trim())
				.filter(
					(label) =>
						label.length > 0 &&
						label !== "[object Object]" &&
						!label.includes("\n") &&
						!metadataPrefixes.some((prefix) =>
							label.toLowerCase().startsWith(prefix),
						),
				);

		if (!tags) {
			return [];
		}

		const explicitLabels = this.getPgTagStringArray(tags, "labels");
		if (explicitLabels) {
			return sanitizeLabels(explicitLabels);
		}

		if (Array.isArray(tags)) {
			return sanitizeLabels(tags.map((tag) => String(tag)));
		}

		return sanitizeLabels([String(tags)]);
	}

	mapPgMaturity(row: ProposalRow): Proposal["maturity"] | undefined {
		// maturity is now a direct TEXT column — no JSONB parsing needed
		const state = row.maturity;
		if (!state) return undefined;
		switch (state) {
			case "new":
			case "active":
			case "mature":
			case "obsolete":
				return state;
			default:
				return undefined;
		}
	}

	mapPgPriority(
		priority: string | null,
	): Proposal["priority"] | undefined {
		switch (priority?.toLowerCase()) {
			case "high":
			case "medium":
			case "low":
				return priority.toLowerCase() as Proposal["priority"];
			default:
				return undefined;
		}
	}
}
