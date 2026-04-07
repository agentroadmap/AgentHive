import { parseStructuredText } from "../../markdown/structured-sections.ts";
import type { ProposalUpdateInput } from "../types/index.ts";
import type { ProposalEditArgs } from "../types/proposal-edit-args.ts";
import { normalizeStringList } from "./proposal-builders.ts";

function sanitizeStringArray(
	values: string[] | undefined,
): string[] | undefined {
	if (!values) return undefined;
	const trimmed = values
		.map((value) => String(value).trim())
		.filter((value) => value.length > 0);
	return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeAppend(values: string[] | undefined): string[] | undefined {
	const sanitized = sanitizeStringArray(values);
	if (!sanitized) {
		return undefined;
	}
	return sanitized;
}

function toAcceptanceCriteriaEntries(values: string[] | undefined) {
	if (!values) return undefined;
	const trimmed = values
		.map((value) => String(value).trim())
		.filter((value) => value.length > 0);
	if (trimmed.length === 0) {
		return undefined;
	}
	return trimmed.map((val, index) => {
		const { text, role, evidence } = parseStructuredText(val);
		return {
			text,
			checked: false,
			index: index + 1,
			...(role && { role }),
			...(evidence && { evidence }),
		};
	});
}

export function buildProposalUpdateInput(
	args: ProposalEditArgs,
): ProposalUpdateInput {
	const updateInput: ProposalUpdateInput = {};

	if (typeof args.title === "string") {
		updateInput.title = args.title;
	}

	if (typeof args.description === "string") {
		updateInput.description = args.description;
	}

	if (typeof args.status === "string") {
		updateInput.status = args.status;
	}

	if (typeof args.domainId === "string") {
		updateInput.domainId = args.domainId;
	}

	if (typeof args.proposalType === "string") {
		updateInput.proposalType = args.proposalType;
	}

	if (typeof args.category === "string") {
		updateInput.category = args.category;
	}

	if (typeof args.builder === "string") {
		updateInput.builder = args.builder;
	}

	if (typeof args.auditor === "string") {
		updateInput.auditor = args.auditor;
	}

	if (typeof args.priority === "string") {
		updateInput.priority = args.priority;
	}

	if (typeof args.scopeSummary === "string") {
		updateInput.scopeSummary = args.scopeSummary;
	}

	if (args.directive === null) {
		updateInput.directive = null;
	} else if (typeof args.directive === "string") {
		const trimmed = args.directive.trim();
		updateInput.directive = trimmed.length > 0 ? trimmed : null;
	}

	if (typeof args.ordinal === "number") {
		updateInput.ordinal = args.ordinal;
	}

	const labels = normalizeStringList(args.labels);
	if (labels) {
		updateInput.labels = labels;
	}

	const addLabels = normalizeStringList(args.addLabels);
	if (addLabels) {
		updateInput.addLabels = addLabels;
	}

	const removeLabels = normalizeStringList(args.removeLabels);
	if (removeLabels) {
		updateInput.removeLabels = removeLabels;
	}

	const assignee = normalizeStringList(args.assignee);
	if (assignee) {
		updateInput.assignee = assignee;
	}

	const dependencies = sanitizeStringArray(args.dependencies);
	if (dependencies) {
		updateInput.dependencies = dependencies;
	}

	const references = sanitizeStringArray(args.references);
	if (references) {
		updateInput.references = references;
	}

	const addReferences = sanitizeStringArray(args.addReferences);
	if (addReferences) {
		updateInput.addReferences = addReferences;
	}

	const removeReferences = sanitizeStringArray(args.removeReferences);
	if (removeReferences) {
		updateInput.removeReferences = removeReferences;
	}

	const documentation = sanitizeStringArray(args.documentation);
	if (documentation) {
		updateInput.documentation = documentation;
	}

	const addDocumentation = sanitizeStringArray(args.addDocumentation);
	if (addDocumentation) {
		updateInput.addDocumentation = addDocumentation;
	}

	const removeDocumentation = sanitizeStringArray(args.removeDocumentation);
	if (removeDocumentation) {
		updateInput.removeDocumentation = removeDocumentation;
	}

	const planSet = args.planSet ?? args.implementationPlan;
	if (typeof planSet === "string") {
		updateInput.implementationPlan = planSet;
	}

	const planAppends = sanitizeAppend(args.planAppend);
	if (planAppends) {
		updateInput.appendImplementationPlan = planAppends;
	}

	if (args.planClear) {
		updateInput.clearImplementationPlan = true;
	}

	const notesSet = args.notesSet ?? args.implementationNotes;
	if (typeof notesSet === "string") {
		updateInput.implementationNotes = notesSet;
	}

	const notesAppends = sanitizeAppend(args.notesAppend);
	if (notesAppends) {
		updateInput.appendImplementationNotes = notesAppends;
	}

	if (args.notesClear) {
		updateInput.clearImplementationNotes = true;
	}

	const auditNotesSet = args.auditNotesSet ?? args.auditNotes;
	if (typeof auditNotesSet === "string") {
		updateInput.auditNotes = auditNotesSet;
	}

	const auditNotesAppends = sanitizeAppend(args.auditNotesAppend);
	if (auditNotesAppends) {
		updateInput.appendAuditNotes = auditNotesAppends;
	}

	if (args.auditNotesClear) {
		updateInput.clearAuditNotes = true;
	}

	if (typeof args.finalSummary === "string") {
		updateInput.finalSummary = args.finalSummary;
	}

	const finalSummaryAppends = sanitizeAppend(args.finalSummaryAppend);
	if (finalSummaryAppends) {
		updateInput.appendFinalSummary = finalSummaryAppends;
	}

	if (args.finalSummaryClear) {
		updateInput.clearFinalSummary = true;
	}

	const criteriaSet = toAcceptanceCriteriaEntries(args.acceptanceCriteriaSet);
	if (criteriaSet) {
		updateInput.acceptanceCriteria = criteriaSet;
	}

	if (
		Array.isArray(args.acceptanceCriteriaAdd) &&
		args.acceptanceCriteriaAdd.length > 0
	) {
		const additions = args.acceptanceCriteriaAdd
			.map((text) => String(text).trim())
			.filter((text) => text.length > 0)
			.map((text) => ({ text, checked: false }));
		if (additions.length > 0) {
			updateInput.addAcceptanceCriteria = additions;
		}
	}

	if (
		Array.isArray(args.acceptanceCriteriaRemove) &&
		args.acceptanceCriteriaRemove.length > 0
	) {
		updateInput.removeAcceptanceCriteria = [...args.acceptanceCriteriaRemove];
	}

	if (
		Array.isArray(args.acceptanceCriteriaCheck) &&
		args.acceptanceCriteriaCheck.length > 0
	) {
		updateInput.checkAcceptanceCriteria = [...args.acceptanceCriteriaCheck];
	}

	if (
		Array.isArray(args.acceptanceCriteriaUncheck) &&
		args.acceptanceCriteriaUncheck.length > 0
	) {
		updateInput.uncheckAcceptanceCriteria = [...args.acceptanceCriteriaUncheck];
	}

	if (
		Array.isArray(args.verificationProposalmentsSet) &&
		args.verificationProposalmentsSet.length > 0
	) {
		updateInput.verificationProposalments = toAcceptanceCriteriaEntries(
			args.verificationProposalmentsSet,
		);
	}

	if (
		Array.isArray(args.verificationProposalmentsAdd) &&
		args.verificationProposalmentsAdd.length > 0
	) {
		const additions = args.verificationProposalmentsAdd
			.map((text) => String(text).trim())
			.filter((text) => text.length > 0)
			.map((val) => {
				const { text, role, evidence } = parseStructuredText(val);
				return {
					text,
					checked: false,
					...(role && { role }),
					...(evidence && { evidence }),
				};
			});
		if (additions.length > 0) {
			updateInput.addVerificationProposalments = additions;
		}
	}

	if (
		Array.isArray(args.verificationProposalmentsRemove) &&
		args.verificationProposalmentsRemove.length > 0
	) {
		updateInput.removeVerificationProposalments = [
			...args.verificationProposalmentsRemove,
		];
	}

	if (
		Array.isArray(args.verificationProposalmentsCheck) &&
		args.verificationProposalmentsCheck.length > 0
	) {
		updateInput.checkVerificationProposalments = [
			...args.verificationProposalmentsCheck,
		];
	}

	if (
		Array.isArray(args.verificationProposalmentsUncheck) &&
		args.verificationProposalmentsUncheck.length > 0
	) {
		updateInput.uncheckVerificationProposalments = [
			...args.verificationProposalmentsUncheck,
		];
	}

	const requires = sanitizeStringArray(args.requires);
	if (requires) {
		updateInput.requires = requires;
	}

	const requiresAdd = sanitizeStringArray(args.requiresAdd);
	if (requiresAdd) {
		updateInput.addRequires = requiresAdd;
	}

	if (Array.isArray(args.requiresRemove) && args.requiresRemove.length > 0) {
		updateInput.removeRequires = [...args.requiresRemove];
	}

	if (args.requiresClear) {
		updateInput.clearRequires = true;
	}

	if (args.maturity) {
		updateInput.maturity = args.maturity;
	}

	const needs = sanitizeStringArray(args.needs_capabilities);
	if (needs) {
		updateInput.needs_capabilities = needs;
	}
	const addNeeds = sanitizeStringArray(args.addNeedsCapabilities);
	if (addNeeds) {
		updateInput.addNeedsCapabilities = addNeeds;
	}
	if (
		Array.isArray(args.removeNeedsCapabilities) &&
		args.removeNeedsCapabilities.length > 0
	) {
		updateInput.removeNeedsCapabilities = [...args.removeNeedsCapabilities];
	}

	const external = sanitizeStringArray(args.external_injections);
	if (external) {
		updateInput.external_injections = external;
	}
	const addExternal = sanitizeStringArray(args.addExternalInjections);
	if (addExternal) {
		updateInput.addExternalInjections = addExternal;
	}
	if (
		Array.isArray(args.removeExternalInjections) &&
		args.removeExternalInjections.length > 0
	) {
		updateInput.removeExternalInjections = [...args.removeExternalInjections];
	}

	const unlocks = sanitizeStringArray(args.unlocks);
	if (unlocks) {
		updateInput.unlocks = unlocks;
	}
	const addUnlocks = sanitizeStringArray(args.addUnlocks);
	if (addUnlocks) {
		updateInput.addUnlocks = addUnlocks;
	}
	if (Array.isArray(args.removeUnlocks) && args.removeUnlocks.length > 0) {
		updateInput.removeUnlocks = [...args.removeUnlocks];
	}

	const proof = sanitizeStringArray(args.proof);
	if (proof) {
		updateInput.proof = proof;
	}
	const addProof = sanitizeStringArray(args.addProof);
	if (addProof) {
		updateInput.addProof = addProof;
	}
	if (Array.isArray(args.removeProof) && args.removeProof.length > 0) {
		updateInput.removeProof = [...args.removeProof];
	}

	if (typeof args.rationale === "string") {
		updateInput.rationale = args.rationale;
	}

	return updateInput;
}
