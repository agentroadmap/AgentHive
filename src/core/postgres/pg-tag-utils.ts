import type {
	ProposalAcceptanceCriterionRow,
	ProposalRow,
} from "../../infra/postgres/proposal-storage-v2.ts";
import type { AcceptanceCriterion, Proposal } from "../../types/index.ts";

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
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
