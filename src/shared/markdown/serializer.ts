import matter from "gray-matter";
import type { Decision, Document, Proposal } from "../../types/index.ts";
import { normalizeAssignee } from "../../utils/assignee.ts";
import {
	AcceptanceCriteriaManager,
	getStructuredSections,
	type StructuredSectionValues,
	updateStructuredSections,
	VerificationProposalmentsManager,
} from "./structured-sections.ts";

export function serializeProposal(proposal: Proposal): string {
	normalizeAssignee(proposal);
	const frontmatter = {
		id: proposal.id,
		title: proposal.title,
		status: proposal.status,
		assignee: proposal.assignee,
		...(proposal.reporter && { reporter: proposal.reporter }),
		created_date: proposal.createdDate,
		...(proposal.updatedDate && { updated_date: proposal.updatedDate }),
		labels: proposal.labels,
		...(proposal.domainId && { domain_id: proposal.domainId }),
		...(proposal.proposalType && { proposal_type: proposal.proposalType }),
		...(proposal.category && { category: proposal.category }),
		...(proposal.type && { type: proposal.type }),
		...(proposal.directive && { directive: proposal.directive }),
		dependencies: proposal.dependencies,
		...(proposal.references &&
			proposal.references.length > 0 && { references: proposal.references }),
		...(proposal.documentation &&
			proposal.documentation.length > 0 && {
				documentation: proposal.documentation,
			}),
		...(proposal.requires &&
			proposal.requires.length > 0 && { requires: proposal.requires }),
		...(proposal.parentProposalId && {
			parent_proposal_id: proposal.parentProposalId,
		}),
		...(proposal.subproposals &&
			proposal.subproposals.length > 0 && {
				subproposals: proposal.subproposals,
			}),
		...(proposal.priority && { priority: proposal.priority }),
		...(proposal.ordinal !== undefined && { ordinal: proposal.ordinal }),
		...(proposal.onStatusChange && { onStatusChange: proposal.onStatusChange }),
		...(proposal.rationale && { rationale: proposal.rationale }),
		...(proposal.maturity && { maturity: proposal.maturity }),
		...(proposal.builder && { builder: proposal.builder }),
		...(proposal.auditor && { auditor: proposal.auditor }),
		...(proposal.needs_capabilities &&
			proposal.needs_capabilities.length > 0 && {
				needs_capabilities: proposal.needs_capabilities,
			}),
		...(proposal.external_injections &&
			proposal.external_injections.length > 0 && {
				external_injections: proposal.external_injections,
			}),
		...(proposal.claim && {
			claim: {
				agent: proposal.claim.agent,
				created: proposal.claim.created,
				expires: proposal.claim.expires,
				...(proposal.claim.lastHeartbeat && {
					last_heartbeat: proposal.claim.lastHeartbeat,
				}),
				...(proposal.claim.message && { message: proposal.claim.message }),
			},
		}),
	};

	let contentBody = proposal.rawContent ?? "";

	// Update checklists first using their specialized managers
	if (Array.isArray(proposal.acceptanceCriteriaItems)) {
		const existingCriteria =
			AcceptanceCriteriaManager.parseAllCriteria(contentBody);
		const hasExistingStructuredCriteria = existingCriteria.length > 0;
		if (
			proposal.acceptanceCriteriaItems.length > 0 ||
			hasExistingStructuredCriteria
		) {
			contentBody = AcceptanceCriteriaManager.updateContent(
				contentBody,
				proposal.acceptanceCriteriaItems,
			);
		}
	}
	if (Array.isArray(proposal.verificationProposalments)) {
		const existingVerificationProposalments =
			VerificationProposalmentsManager.parseAllCriteria(contentBody);
		const hasExistingVerificationProposalments =
			existingVerificationProposalments.length > 0;
		if (
			proposal.verificationProposalments.length > 0 ||
			hasExistingVerificationProposalments
		) {
			contentBody = VerificationProposalmentsManager.updateContent(
				contentBody,
				proposal.verificationProposalments,
			);
		}
	}

	// Update all other structured sections at once to avoid individual updates stripping each other
	const updatedSections: StructuredSectionValues = {};

	if (
		typeof proposal.description === "string" &&
		proposal.description.trim() !== ""
	) {
		updatedSections.description = proposal.description;
	}
	if (
		typeof proposal.implementationPlan === "string" &&
		proposal.implementationPlan.trim() !== ""
	) {
		updatedSections.implementationPlan = proposal.implementationPlan;
	}
	if (
		typeof proposal.implementationNotes === "string" &&
		proposal.implementationNotes.trim() !== ""
	) {
		updatedSections.implementationNotes = proposal.implementationNotes;
	}
	if (
		typeof proposal.auditNotes === "string" &&
		proposal.auditNotes.trim() !== ""
	) {
		updatedSections.auditNotes = proposal.auditNotes;
	}
	if (
		typeof proposal.finalSummary === "string" &&
		proposal.finalSummary.trim() !== ""
	) {
		updatedSections.finalSummary = proposal.finalSummary;
	}
	if (Array.isArray(proposal.proof) && proposal.proof.length > 0) {
		updatedSections.proof = proposal.proof
			.map((p) => String(p).trim())
			.filter(Boolean)
			.map((p) => `- ${p}`)
			.join("\n");
	}

	if (Object.keys(updatedSections).length > 0) {
		contentBody = updateStructuredSections(contentBody, updatedSections);
	}

	const serialized = matter.stringify(contentBody, frontmatter);
	// Ensure there's a blank line between frontmatter and content
	return serialized.replace(/^(---\n(?:.*\n)*?---)\n(?!$)/, "$1\n\n");
}

export function serializeDecision(decision: Decision): string {
	const frontmatter = {
		id: decision.id,
		title: decision.title,
		date: decision.date,
		status: decision.status,
	};

	let content = `## Context\n\n${decision.context}\n\n`;
	content += `## Decision\n\n${decision.decision}\n\n`;
	content += `## Consequences\n\n${decision.consequences}`;

	if (decision.alternatives) {
		content += `\n\n## Alternatives\n\n${decision.alternatives}`;
	}

	return matter.stringify(content, frontmatter);
}

export function serializeDocument(document: Document): string {
	const frontmatter = {
		id: document.id,
		title: document.title,
		type: document.type,
		created_date: document.createdDate,
		...(document.updatedDate && { updated_date: document.updatedDate }),
		...(document.tags && document.tags.length > 0 && { tags: document.tags }),
	};

	return matter.stringify(document.rawContent, frontmatter);
}

export function updateProposalAcceptanceCriteria(
	content: string,
	criteria: string[],
): string {
	// Normalize to LF while computing, preserve original EOL at return
	const useCRLF = /\r\n/.test(content);
	const src = content.replace(/\r\n/g, "\n");
	// Find if there's already an Acceptance Criteria section
	const criteriaRegex = /## Acceptance Criteria\s*\n([\s\S]*?)(?=\n## |$)/i;
	const match = src.match(criteriaRegex);

	const newCriteria = criteria
		.map((criterion) => `- [ ] ${criterion}`)
		.join("\n");
	const newSection = `## Acceptance Criteria\n\n${newCriteria}`;

	let out: string | undefined;
	if (match) {
		// Replace existing section
		out = src.replace(criteriaRegex, newSection);
	} else {
		// Add new section at the end
		out = `${src}\n\n${newSection}`;
	}
	return useCRLF ? out.replace(/\n/g, "\r\n") : out;
}

export function updateProposalImplementationPlan(
	content: string,
	plan: string,
): string {
	const sections = getStructuredSections(content);
	return updateStructuredSections(content, {
		...sections,
		implementationPlan: plan,
	});
}

export function updateProposalImplementationNotes(
	content: string,
	notes: string,
): string {
	const sections = getStructuredSections(content);
	return updateStructuredSections(content, {
		...sections,
		implementationNotes: notes,
	});
}

export function updateProposalAuditNotes(
	content: string,
	notes: string,
): string {
	const sections = getStructuredSections(content);
	return updateStructuredSections(content, {
		...sections,
		auditNotes: notes,
	});
}

export function updateProposalFinalSummary(
	content: string,
	summary: string,
): string {
	const sections = getStructuredSections(content);
	return updateStructuredSections(content, {
		...sections,
		finalSummary: summary,
	});
}

export function appendProposalImplementationNotes(
	content: string,
	notesChunks: string | string[],
): string {
	const chunks = (Array.isArray(notesChunks) ? notesChunks : [notesChunks])
		.map((c) => String(c))
		.map((c) => c.replace(/\r\n/g, "\n"))
		.map((c) => c.trim())
		.filter(Boolean);

	const sections = getStructuredSections(content);
	const appendedBlock = chunks.join("\n\n");
	const existingNotes = sections.implementationNotes?.trim();
	const combined = existingNotes
		? `${existingNotes}\n\n${appendedBlock}`
		: appendedBlock;
	return updateStructuredSections(content, {
		...sections,
		implementationNotes: combined,
	});
}

export function appendProposalAuditNotes(
	content: string,
	notesChunks: string | string[],
): string {
	const chunks = (Array.isArray(notesChunks) ? notesChunks : [notesChunks])
		.map((c) => String(c))
		.map((c) => c.replace(/\r\n/g, "\n"))
		.map((c) => c.trim())
		.filter(Boolean);

	const sections = getStructuredSections(content);
	const appendedBlock = chunks.join("\n\n");
	const existingNotes = sections.auditNotes?.trim();
	const combined = existingNotes
		? `${existingNotes}\n\n${appendedBlock}`
		: appendedBlock;
	return updateStructuredSections(content, {
		...sections,
		auditNotes: combined,
	});
}

export function updateProposalDescription(
	content: string,
	description: string,
): string {
	const sections = getStructuredSections(content);
	return updateStructuredSections(content, {
		...sections,
		description,
	});
}

export function updateProposalProof(
	content: string,
	proof: string[] | string,
): string {
	const sections = getStructuredSections(content);
	const proofArray = Array.isArray(proof) ? proof : [proof];
	const proofText = proofArray
		.map((p) => String(p).trim())
		.filter(Boolean)
		.map((p) => `- ${p}`)
		.join("\n");
	return updateStructuredSections(content, {
		...sections,
		proof: proofText,
	});
}
