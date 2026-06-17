import type {
	ProposalAcceptanceCriterionRow,
	ProposalActivity,
	ProposalDependency,
	ProposalRow,
	ProposalSummary,
} from "../../infra/postgres/proposal-storage-v2.ts";
import type { ActivityLogEntry, Proposal } from "../../types/index.ts";
import { formatLocalDateTime } from "../../utils/date-time.ts";
import {
	buildPgRawContent,
	getPgTagMetadata,
	getPgTagString,
	getPgTagStringArray,
	mapPgAcceptanceCriteria,
	mapPgLabels,
	mapPgMaturity,
	mapPgPriority,
} from "./pg-tag-utils.ts";

export interface PgHydratorDeps {
	getProposalSummary(id: string | number): Promise<ProposalSummary | null>;
	getProposal(id: string | number): Promise<ProposalRow | null>;
}

export async function hydratePgProposalRow(
	pg: PgHydratorDeps,
	row: ProposalRow,
	options?: {
		summary?: ProposalSummary | null;
		dependencies?: ProposalDependency[];
		acceptanceCriteria?: ProposalAcceptanceCriterionRow[];
		parentProposalId?: string;
		activity?: ProposalActivity | null;
		activityLog?: ActivityLogEntry[];
	},
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
	const metadata = getPgTagMetadata(row.tags);

	const id = row.display_id || `#${row.id}`;
	const labels = mapPgLabels(row.tags);
	const rawContent = buildPgRawContent(row);
	const maturity = mapPgMaturity(row);
	const priority = mapPgPriority(row.priority);
	const leaseActive =
		Boolean(summary?.leased_by) &&
		(summary?.lease_expires === null ||
			summary?.lease_expires === undefined ||
			new Date(summary.lease_expires) > new Date());
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
		implementationNotes: getPgTagString(row.tags, "implementationNotes"),
		auditNotes: getPgTagString(row.tags, "auditNotes"),
		finalSummary: getPgTagString(row.tags, "finalSummary"),
		scopeSummary: getPgTagString(row.tags, "scopeSummary"),
		createdDate: new Date(row.created_at).toISOString().slice(0, 16).replace("T", " "),
		updatedDate: new Date(row.modified_at || row.created_at).toISOString().slice(0, 16).replace("T", " "),
		proposalType: row.type,
		domainId: getPgTagString(row.tags, "domainId"),
		category: getPgTagString(row.tags, "category"),
		directive: getPgTagString(row.tags, "directive"),
		references: getPgTagStringArray(row.tags, "references"),
		documentation: getPgTagStringArray(row.tags, "documentation"),
		proof: getPgTagStringArray(row.tags, "proof"),
		needs_capabilities: getPgTagStringArray(row.tags, "needs_capabilities"),
		required_capabilities: getPgTagStringArray(row.tags, "required_capabilities"),
		external_injections: getPgTagStringArray(row.tags, "external_injections"),
		unlocks: getPgTagStringArray(row.tags, "unlocks"),
		rationale: getPgTagString(row.tags, "rationale"),
		builder: getPgTagString(row.tags, "builder"),
		auditor: getPgTagString(row.tags, "auditor"),
		...(parentProposalId && { parentProposalId }),
		...(acceptanceCriteria.length > 0 && {
			acceptanceCriteriaItems: mapPgAcceptanceCriteria(acceptanceCriteria),
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
