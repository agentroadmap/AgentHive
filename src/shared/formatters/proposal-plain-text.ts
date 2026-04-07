import type { Proposal } from "../../types/index.ts";
import type { ChecklistItem } from "../../ui/checklist.ts";
import { transformCodePathsPlain } from "../../ui/code-path.ts";
import { formatStatusWithIcon } from "../../ui/status-icon.ts";
import { sortByProposalId } from "../../utils/proposal-sorting.ts";
import { isCompleteStatus } from "../../utils/status.ts";

export type ProposalPlainTextOptions = {
	filePathOverride?: string;
};

type ChecklistFormattingOptions = {
	hideChecked?: boolean;
};

export function formatDateForDisplay(dateStr: string): string {
	if (!dateStr) return "";
	const hasTime = dateStr.includes(" ") || dateStr.includes("T");
	return hasTime ? dateStr : dateStr;
}

function buildChecklistItems(
	items: Proposal["acceptanceCriteriaItems"],
): ChecklistItem[] {
	const criteria = items ?? [];
	return criteria
		.slice()
		.sort((a, b) => a.index - b.index)
		.map((criterion) => ({
			text: criterion.text,
			checked: criterion.checked,
			role: criterion.role,
			evidence: criterion.evidence,
			index: criterion.index,
		}));
}

export function buildAcceptanceCriteriaItems(
	proposal: Proposal,
): ChecklistItem[] {
	return buildChecklistItems(proposal.acceptanceCriteriaItems);
}

export function buildVerificationProposalments(
	proposal: Proposal,
): ChecklistItem[] {
	return buildChecklistItems(proposal.verificationProposalments);
}

export function formatAcceptanceCriteriaLines(
	items: ChecklistItem[],
	options: ChecklistFormattingOptions = {},
): string[] {
	const visibleItems = options.hideChecked
		? items.filter((item) => !item.checked)
		: items;
	if (visibleItems.length === 0) return [];
	return visibleItems.map((item) => {
		const prefix = item.checked ? "- [x]" : "- [ ]";
		const indexPart = item.index !== undefined ? `#${item.index} ` : "";

		let text = transformCodePathsPlain(item.text);
		const structured = item as any;
		if (structured.role) {
			text = `[${structured.role}] ${text}`;
		}
		if (structured.evidence) {
			text = `${text} (evidence: ${structured.evidence})`;
		}

		return `${prefix} ${indexPart}${text}`;
	});
}

function formatPriority(priority?: "high" | "medium" | "low"): string | null {
	if (!priority) return null;
	const label = priority.charAt(0).toUpperCase() + priority.slice(1);
	return label;
}

function formatAssignees(assignee?: string[]): string | null {
	if (!assignee || assignee.length === 0) return null;
	return assignee.map((a) => (a.startsWith("@") ? a : `@${a}`)).join(", ");
}

function formatSubproposalLines(
	subproposals: Array<{ id: string; title: string }>,
): string[] {
	if (subproposals.length === 0) return [];
	const sorted = sortByProposalId(subproposals);
	return sorted.map(
		(subproposal) => `- ${subproposal.id} - ${subproposal.title}`,
	);
}

export function formatProposalPlainText(
	proposal: Proposal,
	options: ProposalPlainTextOptions = {},
): string {
	const lines: string[] = [];
	const filePath = options.filePathOverride ?? proposal.filePath;
	const reachedProposal = isCompleteStatus(proposal.status);

	if (filePath) {
		lines.push(`File: ${filePath}`);
		lines.push("");
	}

	const displayId =
		proposal.status === "Draft" ? proposal.id : proposal.id.toUpperCase();
	lines.push(`Proposal ${displayId} - ${proposal.title}`);
	if (proposal.type) lines.push(`Type: ${proposal.type.toUpperCase()}`);
	lines.push("=".repeat(50));
	lines.push("");
	lines.push(`Status: ${formatStatusWithIcon(proposal.status)}`);

	const priorityLabel = formatPriority(proposal.priority);
	if (priorityLabel) {
		lines.push(`Priority: ${priorityLabel}`);
	}

	const assigneeText = formatAssignees(proposal.assignee);
	if (assigneeText) {
		lines.push(`Assignee: ${assigneeText}`);
	}

	if (proposal.reporter) {
		const reporter = proposal.reporter.startsWith("@")
			? proposal.reporter
			: `@${proposal.reporter}`;
		lines.push(`Reporter: ${reporter}`);
	}

	if (proposal.hype) lines.push(`Hype: ${proposal.hype}`);
	lines.push(`Created: ${formatDateForDisplay(proposal.createdDate)}`);
	if (proposal.updatedDate) {
		lines.push(`Updated: ${formatDateForDisplay(proposal.updatedDate)}`);
	}

	if (proposal.labels?.length) {
		lines.push(`Labels: ${proposal.labels.join(", ")}`);
	}

	if (proposal.directive) {
		lines.push(`Directive: ${proposal.directive}`);
	}

	if (proposal.rationale) {
		lines.push(`Rationale: ${proposal.rationale}`);
	}

	if (proposal.maturity) {
		lines.push(`Maturity: ${proposal.maturity.toUpperCase()}`);
	}

	if (proposal.builder) {
		const builder = proposal.builder.startsWith("@")
			? proposal.builder
			: `@${proposal.builder}`;
		lines.push(`Builder: ${builder}`);
	}

	if (proposal.auditor) {
		const auditor = proposal.auditor.startsWith("@")
			? proposal.auditor
			: `@${proposal.auditor}`;
		lines.push(`Auditor: ${auditor}`);
	}

	if (proposal.needs_capabilities?.length) {
		lines.push(`Needs (Agent): ${proposal.needs_capabilities.join(", ")}`);
	}

	if (proposal.external_injections?.length) {
		lines.push(
			`External Injections: ${proposal.external_injections.join(", ")}`,
		);
	}

	if (proposal.unlocks?.length) {
		lines.push(`Unlocks (Product): ${proposal.unlocks.join(", ")}`);
	}

	if (proposal.claim) {
		const now = new Date();
		const expires = new Date(proposal.claim.expires.replace(" ", "T"));
		const isExpired = expires <= now;
		const status = isExpired ? "EXPIRED" : "ACTIVE";
		lines.push(`Claim: ${proposal.claim.agent} (${status})`);
		lines.push(`  Created: ${proposal.claim.created}`);
		lines.push(`  Expires: ${proposal.claim.expires}`);
		if (proposal.claim.message) {
			lines.push(`  Message: ${proposal.claim.message}`);
		}
	}

	if (proposal.parentProposalId) {
		const parentLabel = proposal.parentProposalTitle
			? `${proposal.parentProposalId} - ${proposal.parentProposalTitle}`
			: proposal.parentProposalId;
		lines.push(`Parent: ${parentLabel}`);
	}

	const subproposalSummaries = proposal.subproposalSummaries ?? [];
	const subproposalCount =
		subproposalSummaries.length > 0
			? subproposalSummaries.length
			: (proposal.subproposals?.length ?? 0);
	if (subproposalCount > 0) {
		const subproposalLines = formatSubproposalLines(subproposalSummaries);
		if (subproposalLines.length > 0) {
			lines.push(`Subproposals (${subproposalCount}):`);
			lines.push(...subproposalLines);
		} else {
			lines.push(`Subproposals: ${subproposalCount}`);
		}
	}

	if (proposal.dependencies?.length) {
		lines.push(`Dependencies: ${proposal.dependencies.join(", ")}`);
	}

	if (proposal.references?.length) {
		lines.push(`References: ${proposal.references.join(", ")}`);
	}

	if (proposal.documentation?.length) {
		lines.push(`Documentation: ${proposal.documentation.join(", ")}`);
	}

	lines.push("");

	const scopeSummary = proposal.scopeSummary?.trim();
	if (scopeSummary) {
		lines.push("Scope Summary:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(scopeSummary));
		lines.push("");
	}

	lines.push("Description:");
	lines.push("-".repeat(50));
	const description = proposal.description?.trim();
	lines.push(
		transformCodePathsPlain(
			description && description.length > 0
				? description
				: "No description provided",
		),
	);
	lines.push("");

	const criteriaItems = buildAcceptanceCriteriaItems(proposal);
	const visibleCriteriaLines = formatAcceptanceCriteriaLines(criteriaItems, {
		hideChecked: reachedProposal,
	});
	if (!reachedProposal || visibleCriteriaLines.length > 0) {
		lines.push("Acceptance Criteria:");
		lines.push("-".repeat(50));
		if (visibleCriteriaLines.length > 0) {
			lines.push(...visibleCriteriaLines);
		} else {
			lines.push("No acceptance criteria defined");
		}
		lines.push("");
	}

	lines.push("Verification Proposalments:");
	lines.push("-".repeat(50));
	const verificationItems = buildVerificationProposalments(proposal);
	if (verificationItems.length > 0) {
		lines.push(...formatAcceptanceCriteriaLines(verificationItems));
	} else {
		lines.push("No verification proposalments defined");
	}
	lines.push("");

	const implementationPlan = proposal.implementationPlan?.trim();
	if (implementationPlan && !reachedProposal) {
		lines.push("Implementation Plan:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(implementationPlan));
		lines.push("");
	}

	const implementationNotes = proposal.implementationNotes?.trim();
	if (implementationNotes) {
		lines.push("Implementation Notes:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(implementationNotes));
		lines.push("");
	}

	const auditNotes = proposal.auditNotes?.trim();
	if (auditNotes) {
		lines.push("Audit Notes:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(auditNotes));
		lines.push("");
	}

	const finalSummary = proposal.finalSummary?.trim();
	if (finalSummary) {
		lines.push("Final Summary:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(finalSummary));
		lines.push("");
	}

	// Activity Log
	const activityLog = proposal.activityLog;
	if (activityLog && activityLog.length > 0) {
		lines.push("Activity Log:");
		lines.push("-".repeat(50));
		for (const entry of activityLog) {
			const reasonPart = entry.reason ? ` (${entry.reason})` : "";
			lines.push(
				`  ${entry.timestamp} | ${entry.actor} | ${entry.action}${reasonPart}`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}
