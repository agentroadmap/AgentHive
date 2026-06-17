import * as pgPool from "../../postgres/pool.ts";
import type {
	ProposalAcceptanceCriterionRow,
	ProposalActivity,
	ProposalRow,
	ProposalSummary,
	ProposalDependency,
} from "../../infra/postgres/proposal-storage-v2.ts";
import * as pg from "../../infra/postgres/proposal-storage-v2.ts";
import type {
	AcceptanceCriterion,
	ActivityLogEntry,
	Proposal,
} from "../../types/index.ts";
import { formatLocalDateTime } from "../../utils/date-time.ts";

export function getPgTagMetadata(
	tags: ProposalRow["tags"],
): Record<string, unknown> | null {
	if (!tags || Array.isArray(tags) || typeof tags !== "object") {
		return null;
	}
	return tags as Record<string, unknown>;
}

export function getPgTagString(
	tags: ProposalRow["tags"],
	key: string,
): string | undefined {
	const metadata = getPgTagMetadata(tags);
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

export function getPgTagStringArray(
	tags: ProposalRow["tags"],
	key: string,
): string[] | undefined {
	const metadata = getPgTagMetadata(tags);
	const value = metadata?.[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	const normalized = value.map((item) => String(item).trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

export function buildPgTags(proposal: Proposal): Record<string, unknown> | null {
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

export function mapPgAcceptanceCriteria(
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

export function buildPgRawContent(row: ProposalRow): string {
	const rawContent = getPgTagString(row.tags, "rawContent");
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

export function mapPgLabels(tags: ProposalRow["tags"]): string[] {
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

	const explicitLabels = getPgTagStringArray(tags, "labels");
	if (explicitLabels) {
		return sanitizeLabels(explicitLabels);
	}

	if (Array.isArray(tags)) {
		return sanitizeLabels(tags.map((tag) => String(tag)));
	}

	return sanitizeLabels([String(tags)]);
}

export function mapPgMaturity(row: ProposalRow): Proposal["maturity"] | undefined {
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

export function mapPgPriority(
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

export function extractEventActor(
	payload: Record<string, unknown>,
): string | undefined {
	const actor =
		typeof payload.agent === "string"
			? payload.agent
			: typeof payload.agent_identity === "string"
				? payload.agent_identity
				: typeof payload.source === "string"
					? payload.source
					: undefined;
	return actor?.trim() || undefined;
}

export function extractEventReason(
	eventType: string,
	payload: Record<string, unknown>,
): string | undefined {
	const text = (value: unknown): string | undefined =>
		typeof value === "string" && value.trim().length > 0
			? value.trim()
			: undefined;

	switch (eventType) {
		case "proposal_created":
			return text(payload.status)
				? `status ${String(payload.status)}`
				: undefined;
		case "lease_claimed":
			return text(payload.expires_at)
				? `expires ${String(payload.expires_at)}`
				: undefined;
		case "lease_released":
			return text(payload.release_reason);
		default:
			return (
				text(payload.reason) ?? text(payload.notes) ?? text(payload.message)
			);
	}
}

export function describeProposalEvent(eventType: string): string {
	switch (eventType) {
		case "proposal_created":
			return "created proposal";
		case "lease_claimed":
			return "lease claimed";
		case "lease_released":
			return "lease released";
		case "decision_made":
			return "decision recorded";
		case "dependency_added":
			return "dependency added";
		case "dependency_resolved":
			return "dependency resolved";
		case "ac_updated":
			return "acceptance criteria updated";
		case "review_submitted":
			return "review submitted";
		case "milestone_achieved":
			return "milestone achieved";
		default:
			return eventType.replace(/_/g, " ");
	}
}

export async function loadPgProposalActivity(
	proposalId: number,
	limit = 50,
): Promise<ActivityLogEntry[]> {
	type TimelineEntry = {
		timestampMs: number;
		entry: ActivityLogEntry;
	};

	const [stateRows, maturityRows, eventRows] = await Promise.all([
		pgPool.query<{
			transitioned_at: Date;
			transitioned_by: string | null;
			from_state: string;
			to_state: string;
			transition_reason: string | null;
			notes: string | null;
		}>(
			`SELECT transitioned_at, transitioned_by, from_state, to_state, transition_reason, notes
         FROM roadmap_proposal.proposal_state_transitions
         WHERE proposal_id = $1
         ORDER BY transitioned_at ASC, id ASC
         LIMIT $2`,
			[proposalId, limit],
		),
		pgPool.query<{
			created_at: Date;
			transitioned_by: string | null;
			from_maturity: string;
			to_maturity: string;
			transition_reason: string | null;
			decision_notes: string | null;
		}>(
			`SELECT created_at, transitioned_by, from_maturity, to_maturity, transition_reason, decision_notes
         FROM roadmap_proposal.proposal_maturity_transitions
         WHERE proposal_id = $1
         ORDER BY created_at ASC, id ASC
         LIMIT $2`,
			[proposalId, limit],
		),
		pgPool.query<{
			created_at: Date;
			event_type: string;
			payload: Record<string, unknown>;
		}>(
			`SELECT created_at, event_type, payload
         FROM roadmap_proposal.proposal_event
         WHERE proposal_id = $1
           AND event_type IN (
             'proposal_created',
             'lease_claimed',
             'lease_released',
             'decision_made',
             'dependency_added',
             'dependency_resolved',
             'ac_updated',
             'review_submitted',
             'milestone_achieved'
           )
         ORDER BY created_at ASC, id ASC
         LIMIT $2`,
			[proposalId, limit],
		),
	]);

	const entries: TimelineEntry[] = [];

	for (const row of stateRows.rows) {
		const reason = [row.transition_reason, row.notes]
			.filter((part): part is string => Boolean(part?.trim()))
			.join(" — ");
		entries.push({
			timestampMs: new Date(row.transitioned_at).getTime(),
			entry: {
				timestamp: formatLocalDateTime(new Date(row.transitioned_at)),
				actor: row.transitioned_by ?? "system",
				action: `state ${row.from_state} → ${row.to_state}`,
				...(reason ? { reason } : {}),
			},
		});
	}

	for (const row of maturityRows.rows) {
		const reason = [row.transition_reason, row.decision_notes]
			.filter((part): part is string => Boolean(part?.trim()))
			.join(" — ");
		entries.push({
			timestampMs: new Date(row.created_at).getTime(),
			entry: {
				timestamp: formatLocalDateTime(new Date(row.created_at)),
				actor: row.transitioned_by ?? "system",
				action: `maturity ${row.from_maturity} → ${row.to_maturity}`,
				...(reason ? { reason } : {}),
			},
		});
	}

	for (const row of eventRows.rows) {
		const agent = extractEventActor(row.payload) ?? "system";
		const reason = extractEventReason(row.event_type, row.payload);
		const action = describeProposalEvent(row.event_type);
		entries.push({
			timestampMs: new Date(row.created_at).getTime(),
			entry: {
				timestamp: formatLocalDateTime(new Date(row.created_at)),
				actor: agent,
				action,
				...(reason ? { reason } : {}),
			},
		});
	}

	return entries
		.sort((left, right) => {
			if (left.timestampMs !== right.timestampMs) {
				return left.timestampMs - right.timestampMs;
			}
			return left.entry.action.localeCompare(right.entry.action);
		})
		.slice(-limit)
		.map((item) => item.entry);
}

export async function hydratePgProposalRow(
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
		updatedDate: new Date(row.modified_at || row.created_at)
			.toISOString()
			.slice(0, 16)
			.replace("T", " "),
		proposalType: row.type,
		domainId: getPgTagString(row.tags, "domainId"),
		category: getPgTagString(row.tags, "category"),
		directive: getPgTagString(row.tags, "directive"),
		references: getPgTagStringArray(row.tags, "references"),
		documentation: getPgTagStringArray(row.tags, "documentation"),
		proof: getPgTagStringArray(row.tags, "proof"),
		needs_capabilities: getPgTagStringArray(row.tags, "needs_capabilities"),
		required_capabilities: getPgTagStringArray(
			row.tags,
			"required_capabilities",
		),
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
