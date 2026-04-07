/**
 * Generates a Markdown document from a Proposal object.
 * Used for exporting proposals to .md files.
 */

import type { Proposal } from "../types/index.ts";

export function generateProposalMarkdown(proposal: Proposal): string {
	const lines: string[] = [];

	// Frontmatter
	lines.push("---");
	lines.push(`id: ${proposal.id}`);
	lines.push(`title: "${proposal.title}"`);
	lines.push(`status: ${proposal.status}`);
	if (proposal.type) lines.push(`type: ${proposal.type}`);
	if (proposal.priority) lines.push(`priority: ${proposal.priority}`);
	if (proposal.directive) lines.push(`directive: ${proposal.directive}`);
	if (proposal.proposalType)
		lines.push(`proposalType: ${proposal.proposalType}`);
	if (proposal.category) lines.push(`category: ${proposal.category}`);
	if (proposal.domainId) lines.push(`domainId: ${proposal.domainId}`);
	if (proposal.rationale) lines.push(`rationale: "${proposal.rationale}"`);
	if (proposal.maturity) lines.push(`maturity: ${proposal.maturity}`);
	if (proposal.builder) lines.push(`builder: ${proposal.builder}`);
	if (proposal.auditor) lines.push(`auditor: ${proposal.auditor}`);
	if (proposal.assignee?.length)
		lines.push(`assignee: [${proposal.assignee.join(", ")}]`);
	if (proposal.labels?.length)
		lines.push(`labels: [${proposal.labels.join(", ")}]`);
	if (proposal.dependencies?.length)
		lines.push(`dependencies: [${proposal.dependencies.join(", ")}]`);
	if (proposal.needs_capabilities?.length)
		lines.push(
			`needs_capabilities: [${proposal.needs_capabilities.join(", ")}]`,
		);
	if (proposal.external_injections?.length)
		lines.push(
			`external_injections: [${proposal.external_injections.join(", ")}]`,
		);
	if (proposal.unlocks?.length)
		lines.push(`unlocks: [${proposal.unlocks.join(", ")}]`);
	lines.push(`createdDate: ${proposal.createdDate}`);
	if (proposal.updatedDate) lines.push(`updatedDate: ${proposal.updatedDate}`);
	lines.push("---");
	lines.push("");

	// Title
	lines.push(`# ${proposal.title}`);
	lines.push("");

	// Description
	if (proposal.description) {
		lines.push(proposal.description);
		lines.push("");
	}

	// Implementation plan
	if (proposal.implementationPlan) {
		lines.push("## Implementation Plan");
		lines.push("");
		lines.push(proposal.implementationPlan);
		lines.push("");
	}

	// Implementation notes
	if (proposal.implementationNotes) {
		lines.push("## Implementation Notes");
		lines.push("");
		lines.push(proposal.implementationNotes);
		lines.push("");
	}

	// Acceptance criteria
	if (proposal.acceptanceCriteriaItems?.length) {
		lines.push("## Acceptance Criteria");
		lines.push("");
		for (const criterion of proposal.acceptanceCriteriaItems) {
			const check = criterion.checked ? "x" : " ";
			lines.push(`- [${check}] ${criterion.text}`);
		}
		lines.push("");
	}

	// Proof
	if (proposal.proof?.length) {
		lines.push("## Proof");
		lines.push("");
		for (const p of proposal.proof) {
			lines.push(`- ${p}`);
		}
		lines.push("");
	}

	// Final summary
	if (proposal.finalSummary) {
		lines.push("## Final Summary");
		lines.push("");
		lines.push(proposal.finalSummary);
		lines.push("");
	}

	// Scope summary
	if (proposal.scopeSummary) {
		lines.push("## Scope Summary");
		lines.push("");
		lines.push(proposal.scopeSummary);
		lines.push("");
	}

	// Audit notes
	if (proposal.auditNotes) {
		lines.push("## Audit Notes");
		lines.push("");
		lines.push(proposal.auditNotes);
		lines.push("");
	}

	// Body markdown (raw content)
	if (proposal.rawContent) {
		lines.push(proposal.rawContent);
	}

	return lines.join("\n");
}
