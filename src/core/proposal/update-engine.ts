/**
 * update-engine.ts — Field-mutation engine for proposal updates (P3796 AC-16).
 *
 * Extracted from `Core.applyProposalUpdateInput` in `roadmap.ts`. Each logical
 * group of fields is handled by a dedicated helper so callers can compose or
 * unit-test individual slices without touching the 900-line monolith.
 *
 * Callers must supply an `UpdateEngineContext` that bridges the two Core
 * capabilities this module requires (dependency resolution and blocking-issue
 * checks). `Core` wires this in `buildUpdateEngineContext()`.
 */
import type { Proposal, ProposalUpdateInput } from "../../types/index.ts";
import { isCompleteStatus } from "./directives.ts";
import {
	normalizeDependencies,
	normalizeStringList,
	stringArraysEqual,
} from "../../shared/utils/proposal-builders.ts";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface UpdateEngineContext {
	/** Validate that all given proposal IDs exist; returns { valid, invalid }. */
	validateDeps(
		ids: string[],
	): Promise<{ valid: string[]; invalid: string[] }>;
	/** Throw if the proposal has open blocking test issues. */
	assertNoBlockingTestIssues(
		proposalId: string,
		action: "mark as Complete" | "complete",
	): void;
}

// ---------------------------------------------------------------------------
// Shared free-function helpers (extracted from Core)
// ---------------------------------------------------------------------------

export function normalizePriority(
	value: string | undefined,
): ("high" | "medium" | "low") | undefined {
	if (value === undefined || value === "") return undefined;
	const normalized = value.toLowerCase();
	const allowed = ["high", "medium", "low"] as const;
	if (!allowed.includes(normalized as (typeof allowed)[number])) {
		throw new Error(
			`Invalid priority: ${value}. Valid values are: high, medium, low`,
		);
	}
	return normalized as "high" | "medium" | "low";
}

export function addActivityLog(
	proposal: Proposal,
	actor: string,
	action: string,
	reason?: string,
): void {
	if (!proposal.activityLog) proposal.activityLog = [];
	proposal.activityLog.push({
		timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
		actor,
		action,
		reason,
	});
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

type S = { proposal: Proposal; mutated: boolean };

function applyString(
	value: string | undefined,
	current: string | undefined,
	assign: (next: string) => void,
	s: S,
): void {
	if (typeof value === "string") {
		const next = value;
		if ((current ?? "") !== next) {
			assign(next);
			s.mutated = true;
		}
	}
}

function appendBlock(
	existing: string | undefined,
	additions: string[] | undefined,
): { value?: string; changed: boolean } {
	const sanitized = (additions ?? [])
		.map((v) => String(v).trim())
		.filter((v) => v.length > 0);
	if (sanitized.length === 0) return { value: existing, changed: false };
	const current = (existing ?? "").trim();
	const block = sanitized.join("\n\n");
	return {
		value: current.length === 0 ? block : `${current}\n\n${block}`,
		changed: true,
	};
}

function sanitizeAppend(values: string[] | undefined): string[] {
	if (!values) return [];
	return values.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

// ---------------------------------------------------------------------------
// Field-group helpers
// ---------------------------------------------------------------------------

function applyTextFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.title !== undefined) {
		const trimmed = input.title.trim();
		if (trimmed.length === 0) throw new Error("Title cannot be empty.");
		if (p.title !== trimmed) { p.title = trimmed; s.mutated = true; }
	}
	applyString(input.description, p.description, (v) => { p.description = v; }, s);
	applyString(input.summary, p.summary, (v) => { p.summary = v; p.description = v; }, s);
	applyString(input.motivation, p.motivation, (v) => { p.motivation = v; }, s);
	applyString(input.design, p.design, (v) => { p.design = v; p.implementationPlan = v; }, s);
	applyString(input.drawbacks, p.drawbacks, (v) => { p.drawbacks = v; }, s);
	applyString(input.alternatives, p.alternatives, (v) => { p.alternatives = v; }, s);
	applyString(input.dependency_note, p.dependency_note, (v) => { p.dependency_note = v; }, s);
	applyString(input.domainId, p.domainId, (v) => { p.domainId = v; }, s);
	applyString(input.proposalType, p.proposalType, (v) => { p.proposalType = v; }, s);
	applyString(input.category, p.category, (v) => { p.category = v; }, s);
	applyString(input.builder, p.builder, (v) => { p.builder = v; }, s);
	applyString(input.auditor, p.auditor, (v) => { p.auditor = v; }, s);
	applyString(input.rationale, p.rationale, (v) => { p.rationale = v; }, s);
}

function applyCapabilitiesFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.needs_capabilities !== undefined) {
		if (!stringArraysEqual(p.needs_capabilities ?? [], input.needs_capabilities)) {
			p.needs_capabilities = [...input.needs_capabilities];
			s.mutated = true;
		}
	}
	if (input.required_capabilities !== undefined) {
		if (!stringArraysEqual(p.required_capabilities ?? [], input.required_capabilities)) {
			p.required_capabilities = [...input.required_capabilities];
			p.needs_capabilities = [...input.required_capabilities];
			s.mutated = true;
		}
	}
	if (input.addNeedsCapabilities && input.addNeedsCapabilities.length > 0) {
		p.needs_capabilities = [...new Set([...(p.needs_capabilities ?? []), ...input.addNeedsCapabilities])];
		s.mutated = true;
	}
	if (input.removeNeedsCapabilities && input.removeNeedsCapabilities.length > 0) {
		const toRemove = new Set(input.removeNeedsCapabilities);
		p.needs_capabilities = (p.needs_capabilities ?? []).filter((_, i) => !toRemove.has(i + 1));
		s.mutated = true;
	}
}

function applyExternalInjectionsFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.external_injections !== undefined) {
		if (!stringArraysEqual(p.external_injections ?? [], input.external_injections)) {
			p.external_injections = [...input.external_injections];
			s.mutated = true;
		}
	}
	if (input.addExternalInjections && input.addExternalInjections.length > 0) {
		p.external_injections = [...new Set([...(p.external_injections ?? []), ...input.addExternalInjections])];
		s.mutated = true;
	}
	if (input.removeExternalInjections && input.removeExternalInjections.length > 0) {
		const toRemove = new Set(input.removeExternalInjections);
		p.external_injections = (p.external_injections ?? []).filter((_, i) => !toRemove.has(i + 1));
		s.mutated = true;
	}
}

function applyUnlocksFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.unlocks !== undefined) {
		if (!stringArraysEqual(p.unlocks ?? [], input.unlocks)) {
			p.unlocks = [...input.unlocks];
			s.mutated = true;
		}
	}
	if (input.addUnlocks && input.addUnlocks.length > 0) {
		p.unlocks = [...new Set([...(p.unlocks ?? []), ...input.addUnlocks])];
		s.mutated = true;
	}
	if (input.removeUnlocks && input.removeUnlocks.length > 0) {
		const toRemove = new Set(input.removeUnlocks);
		p.unlocks = (p.unlocks ?? []).filter((_, i) => !toRemove.has(i + 1));
		s.mutated = true;
	}
}

function applyProofFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.proof !== undefined) {
		if (!stringArraysEqual(p.proof ?? [], input.proof)) {
			p.proof = [...input.proof];
			s.mutated = true;
		}
	}
	if (input.addProof && input.addProof.length > 0) {
		p.proof = [...new Set([...(p.proof ?? []), ...input.addProof])];
		s.mutated = true;
	}
	if (input.removeProof && input.removeProof.length > 0) {
		const toRemove = new Set(input.removeProof);
		p.proof = (p.proof ?? []).filter((_, i) => !toRemove.has(i + 1));
		s.mutated = true;
	}
}

async function applyStatusField(
	ctx: UpdateEngineContext,
	input: ProposalUpdateInput,
	statusResolver: (status: string) => Promise<string>,
	s: S,
): Promise<void> {
	const p = s.proposal;
	if (input.status !== undefined) {
		const canonicalStatus = await statusResolver(input.status);
		if ((p.status ?? "") !== canonicalStatus) {
			if (isCompleteStatus(canonicalStatus)) {
				ctx.assertNoBlockingTestIssues(p.id, "mark as Complete");
			}
			p.status = canonicalStatus;
			s.mutated = true;
			const actor = input.activityActor ?? input.builder ?? "unknown";
			addActivityLog(p, actor, "status_change", `Changed to ${canonicalStatus}`);
		}
	}
}

function applyPriorityField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.priority !== undefined) {
		const normalized = normalizePriority(String(input.priority));
		if (p.priority !== normalized) {
			p.priority = normalized;
			s.mutated = true;
		}
	}
}

function applyDirectiveField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.directive !== undefined) {
		const normalized =
			input.directive === null
				? undefined
				: input.directive.trim().length > 0
					? input.directive.trim()
					: undefined;
		if ((p.directive ?? undefined) !== normalized) {
			if (normalized === undefined) delete p.directive;
			else p.directive = normalized;
			s.mutated = true;
		}
	}
}

function applyParentField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.parentProposalId !== undefined) {
		const normalized =
			input.parentProposalId === null
				? undefined
				: input.parentProposalId.trim().length > 0
					? input.parentProposalId.trim()
					: undefined;
		if ((p.parentProposalId ?? undefined) !== normalized) {
			if (normalized === undefined) delete p.parentProposalId;
			else p.parentProposalId = normalized;
			s.mutated = true;
		}
	}
}

function applyOrdinalField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.ordinal !== undefined) {
		if (Number.isNaN(input.ordinal) || input.ordinal < 0) {
			throw new Error("Ordinal must be a non-negative number.");
		}
		if (p.ordinal !== input.ordinal) {
			p.ordinal = input.ordinal;
			s.mutated = true;
		}
	}
}

function applyAssigneeField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.assignee !== undefined) {
		const sanitized = normalizeStringList(input.assignee) ?? [];
		if (!stringArraysEqual(sanitized, p.assignee ?? [])) {
			p.assignee = sanitized;
			s.mutated = true;
		}
	}
}

function applyLabelsFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	let current = [...(p.labels ?? [])];
	if (input.labels !== undefined) {
		const sanitized = normalizeStringList(input.labels) ?? [];
		if (!stringArraysEqual(sanitized, current)) {
			p.labels = sanitized;
			s.mutated = true;
		}
		current = sanitized;
	}
	const toAdd = normalizeStringList(input.addLabels) ?? [];
	if (toAdd.length > 0) {
		const labelSet = new Set(current.map((l) => l.toLowerCase()));
		for (const label of toAdd) {
			if (!labelSet.has(label.toLowerCase())) {
				current.push(label);
				labelSet.add(label.toLowerCase());
				s.mutated = true;
			}
		}
		p.labels = current;
	}
	const toRemove = normalizeStringList(input.removeLabels) ?? [];
	if (toRemove.length > 0) {
		const removalSet = new Set(toRemove.map((l) => l.toLowerCase()));
		const filtered = current.filter((l) => !removalSet.has(l.toLowerCase()));
		if (!stringArraysEqual(filtered, current)) {
			p.labels = filtered;
			s.mutated = true;
		}
	}
}

async function applyDependenciesFields(
	ctx: UpdateEngineContext,
	input: ProposalUpdateInput,
	s: S,
): Promise<void> {
	const p = s.proposal;
	let current = [...(p.dependencies ?? [])];

	if (input.dependencies !== undefined) {
		const normalized = normalizeDependencies(input.dependencies);
		const { valid, invalid } = await ctx.validateDeps(normalized);
		if (invalid.length > 0) {
			throw new Error(
				`The following dependencies do not exist: ${invalid.join(", ")}. Please create these proposals first or verify the IDs.`,
			);
		}
		if (!stringArraysEqual(valid, current)) {
			current = valid;
			s.mutated = true;
		}
	}
	if (input.addDependencies && input.addDependencies.length > 0) {
		const additions = normalizeDependencies(input.addDependencies);
		const { valid, invalid } = await ctx.validateDeps(additions);
		if (invalid.length > 0) {
			throw new Error(
				`The following dependencies do not exist: ${invalid.join(", ")}. Please create these proposals first or verify the IDs.`,
			);
		}
		const depSet = new Set(current);
		for (const dep of valid) {
			if (!depSet.has(dep)) {
				current.push(dep);
				depSet.add(dep);
				s.mutated = true;
			}
		}
	}
	if (input.removeDependencies && input.removeDependencies.length > 0) {
		const removals = new Set(normalizeDependencies(input.removeDependencies));
		const filtered = current.filter((d) => !removals.has(d));
		if (!stringArraysEqual(filtered, current)) {
			current = filtered;
			s.mutated = true;
		}
	}
	p.dependencies = current;
}

function applyReferencesFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	let current = [...(p.references ?? [])];
	if (input.references !== undefined) {
		const sanitized = normalizeStringList(input.references) ?? [];
		if (!stringArraysEqual(sanitized, current)) {
			p.references = sanitized;
			s.mutated = true;
		}
		current = sanitized;
	}
	const toAdd = normalizeStringList(input.addReferences) ?? [];
	if (toAdd.length > 0) {
		const refSet = new Set(current);
		for (const ref of toAdd) {
			if (!refSet.has(ref)) { current.push(ref); refSet.add(ref); s.mutated = true; }
		}
		p.references = current;
	}
	const toRemove = normalizeStringList(input.removeReferences) ?? [];
	if (toRemove.length > 0) {
		const removalSet = new Set(toRemove);
		const filtered = current.filter((r) => !removalSet.has(r));
		if (!stringArraysEqual(filtered, current)) { p.references = filtered; s.mutated = true; }
	}
}

function applyDocumentationFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	let current = [...(p.documentation ?? [])];
	if (input.documentation !== undefined) {
		const sanitized = normalizeStringList(input.documentation) ?? [];
		if (!stringArraysEqual(sanitized, current)) {
			p.documentation = sanitized;
			s.mutated = true;
		}
		current = sanitized;
	}
	const toAdd = normalizeStringList(input.addDocumentation) ?? [];
	if (toAdd.length > 0) {
		const docSet = new Set(current);
		for (const doc of toAdd) {
			if (!docSet.has(doc)) { current.push(doc); docSet.add(doc); s.mutated = true; }
		}
		p.documentation = current;
	}
	const toRemove = normalizeStringList(input.removeDocumentation) ?? [];
	if (toRemove.length > 0) {
		const removalSet = new Set(toRemove);
		const filtered = current.filter((d) => !removalSet.has(d));
		if (!stringArraysEqual(filtered, current)) { p.documentation = filtered; s.mutated = true; }
	}
}

function applyRequiresFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	let current = [...(p.requires ?? [])];
	if (input.requires !== undefined) {
		const sanitized = normalizeStringList(input.requires) ?? [];
		if (!stringArraysEqual(sanitized, current)) {
			p.requires = sanitized;
			s.mutated = true;
		}
		current = sanitized;
	}
	const toAdd = normalizeStringList(input.addRequires) ?? [];
	if (toAdd.length > 0) {
		const reqSet = new Set(current);
		for (const req of toAdd) {
			if (!reqSet.has(req)) { current.push(req); reqSet.add(req); s.mutated = true; }
		}
		p.requires = current;
	}
	if (input.clearRequires) {
		if (current.length > 0) { p.requires = []; s.mutated = true; }
		current = [];
	}
	if (input.removeRequires && input.removeRequires.length > 0) {
		const filtered = current.filter((_, idx) => !input.removeRequires!.includes(idx + 1));
		if (!stringArraysEqual(filtered, current)) {
			p.requires = filtered;
			s.mutated = true;
		}
	}
}

function applyAppendableFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;

	if (input.clearImplementationPlan) {
		if (p.implementationPlan !== undefined) { delete p.implementationPlan; s.mutated = true; }
	}
	applyString(input.implementationPlan, p.implementationPlan, (v) => { p.implementationPlan = v; }, s);
	const planAppends = sanitizeAppend(input.appendImplementationPlan);
	if (planAppends.length > 0) {
		const { value, changed } = appendBlock(p.implementationPlan, planAppends);
		if (changed) { p.implementationPlan = value; s.mutated = true; }
	}

	if (input.clearImplementationNotes) {
		if (p.implementationNotes !== undefined) { delete p.implementationNotes; s.mutated = true; }
	}
	applyString(input.implementationNotes, p.implementationNotes, (v) => { p.implementationNotes = v; }, s);
	const notesAppends = sanitizeAppend(input.appendImplementationNotes);
	if (notesAppends.length > 0) {
		const { value, changed } = appendBlock(p.implementationNotes, notesAppends);
		if (changed) { p.implementationNotes = value; s.mutated = true; }
	}

	if (input.clearAuditNotes) {
		if (p.auditNotes !== undefined) { delete p.auditNotes; s.mutated = true; }
	}
	applyString(input.auditNotes, p.auditNotes, (v) => { p.auditNotes = v; }, s);
	const auditAppends = sanitizeAppend(input.appendAuditNotes);
	if (auditAppends.length > 0) {
		const { value, changed } = appendBlock(p.auditNotes, auditAppends);
		if (changed) { p.auditNotes = value; s.mutated = true; }
	}

	if (input.clearFinalSummary) {
		if (p.finalSummary !== undefined) { p.finalSummary = ""; s.mutated = true; }
	}
	applyString(input.finalSummary, p.finalSummary, (v) => { p.finalSummary = v; }, s);
	const finalSummaryAppends = sanitizeAppend(input.appendFinalSummary);
	if (finalSummaryAppends.length > 0) {
		const { value, changed } = appendBlock(p.finalSummary, finalSummaryAppends);
		if (changed) { p.finalSummary = value; s.mutated = true; }
	}
}

function applyClaimField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	if (input.claim !== undefined) {
		if (input.claim === null) {
			if (p.claim !== undefined) { p.claim = undefined; s.mutated = true; }
		} else {
			if (JSON.stringify(p.claim) !== JSON.stringify(input.claim)) {
				p.claim = input.claim;
				s.mutated = true;
			}
		}
	}
}

function applyAcceptanceCriteriaFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;
	let criteria = Array.isArray(p.acceptanceCriteriaItems)
		? p.acceptanceCriteriaItems.map((c) => ({ ...c }))
		: [];

	const rebuildIndices = () => {
		criteria = criteria.map((c, i) => ({ ...c, index: i + 1 }));
	};

	if (input.acceptanceCriteria !== undefined) {
		criteria = input.acceptanceCriteria
			.map((c) => ({ text: String(c.text ?? "").trim(), checked: Boolean(c.checked) }))
			.filter((c) => c.text.length > 0)
			.map((c, i) => ({ index: i + 1, text: c.text, checked: c.checked }));
		s.mutated = true;
	}

	if (input.addAcceptanceCriteria && input.addAcceptanceCriteria.length > 0) {
		const additions = input.addAcceptanceCriteria
			.map((c) => (typeof c === "string" ? c.trim() : String(c.text ?? "").trim()))
			.filter((t) => t.length > 0);
		let idx = criteria.length > 0 ? Math.max(...criteria.map((c) => c.index)) + 1 : 1;
		for (const text of additions) {
			criteria.push({ index: idx++, text, checked: false });
			s.mutated = true;
		}
	}

	if (input.removeAcceptanceCriteria && input.removeAcceptanceCriteria.length > 0) {
		const removalSet = new Set(input.removeAcceptanceCriteria);
		const before = criteria.length;
		criteria = criteria.filter((c) => !removalSet.has(c.index));
		if (criteria.length === before) {
			throw new Error(
				`Acceptance criterion ${Array.from(removalSet).map((i) => `#${i}`).join(", ")} not found`,
			);
		}
		s.mutated = true;
		rebuildIndices();
	}

	const toggleCriteria = (indices: number[] | undefined, checked: boolean) => {
		if (!indices || indices.length === 0) return;
		const missing: number[] = [];
		for (const idx of indices) {
			const c = criteria.find((item) => item.index === idx);
			if (!c) { missing.push(idx); continue; }
			if (c.checked !== checked) { c.checked = checked; s.mutated = true; }
		}
		if (missing.length > 0) {
			throw new Error(`Acceptance criterion ${missing.map((i) => `#${i}`).join(", ")} not found`);
		}
	};

	toggleCriteria(input.checkAcceptanceCriteria, true);
	toggleCriteria(input.uncheckAcceptanceCriteria, false);
	p.acceptanceCriteriaItems = criteria;
}

function applyVerificationProposalmentsFields(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;

	if (input.verificationProposalments !== undefined) {
		if (
			!stringArraysEqual(
				(p.verificationProposalments ?? []).map((c) => c.text),
				input.verificationProposalments.map((c) => c.text),
			)
		) {
			p.verificationProposalments = input.verificationProposalments.map((c, i) => ({
				index: i + 1,
				text: c.text,
				checked: !!c.checked,
				role: c.role,
				evidence: c.evidence,
			}));
			s.mutated = true;
		}
	}

	let items = p.verificationProposalments ?? [];
	const rebuildIndices = () => {
		items = items.map((c, i) => ({ ...c, index: i + 1 }));
	};

	if (input.addVerificationProposalments && input.addVerificationProposalments.length > 0) {
		let nextIdx = items.length > 0 ? Math.max(...items.map((c) => c.index)) + 1 : 1;
		for (const item of input.addVerificationProposalments) {
			if (typeof item === "string") {
				items.push({ text: item, checked: false, index: nextIdx++ });
			} else {
				items.push({ text: item.text, checked: !!item.checked, role: item.role, evidence: item.evidence, index: nextIdx++ });
			}
		}
		s.mutated = true;
	}

	const toggleItems = (indices: number[] | undefined, checked: boolean): void => {
		if (!indices || indices.length === 0) return;
		const missing: number[] = [];
		for (const idx of indices) {
			const c = items.find((item) => item.index === idx);
			if (!c) { missing.push(idx); continue; }
			if (c.checked !== checked) { c.checked = checked; s.mutated = true; }
		}
		if (missing.length > 0) {
			throw new Error(`Verification proposalment ${missing.map((i) => `#${i}`).join(", ")} not found`);
		}
	};

	toggleItems(input.checkVerificationProposalments, true);
	toggleItems(input.uncheckVerificationProposalments, false);

	if (input.removeVerificationProposalments && input.removeVerificationProposalments.length > 0) {
		const removalSet = new Set(input.removeVerificationProposalments);
		const before = items.length;
		items = items.filter((c) => !removalSet.has(c.index));
		if (items.length === before) {
			throw new Error(
				`Verification proposalment ${Array.from(removalSet).map((i) => `#${i}`).join(", ")} not found`,
			);
		}
		s.mutated = true;
		rebuildIndices();
	}

	p.verificationProposalments = items;
}

function applyMaturityField(input: ProposalUpdateInput, s: S): void {
	const p = s.proposal;

	if (input.maturity) {
		const maturity = input.maturity.toLowerCase() as any;
		if (p.maturity !== maturity) {
			if (maturity === "audited") {
				if (!p.builder && !input.builder)
					throw new Error(`Verification Gate: Proposal ${p.id} cannot be marked as 'audited' without a builder.`);
				if (!p.auditor && !input.auditor)
					throw new Error(`Verification Gate: Proposal ${p.id} cannot be marked as 'audited' without an auditor.`);
				if (!p.auditNotes && !input.auditNotes)
					throw new Error(`Verification Gate: Proposal ${p.id} cannot be marked as 'audited' without audit notes.`);
				const currentAuditor = input.auditor || p.auditor;
				const currentBuilder = input.builder || p.builder;
				if (currentAuditor === currentBuilder)
					throw new Error(`Verification Gate: Peer Audit requires distinct agents. Auditor '${currentAuditor}' cannot be the same as Builder '${currentBuilder}'.`);
				const proposalments = p.verificationProposalments ?? [];
				if (proposalments.length > 0) {
					const unchecked = proposalments.filter((item) => !item.checked);
					if (unchecked.length > 0)
						throw new Error(`Verification Gate: Proposal ${p.id} has ${unchecked.length} unchecked verification proposalments. Peer audit must verify all assertions.`);
				}
			}
			p.maturity = maturity;
			s.mutated = true;
		}
	}

	// Automatic transition: skeleton → contracted when ACs or Plan added
	if (p.maturity === "skeleton" || !p.maturity) {
		const hasACs = p.acceptanceCriteriaItems && p.acceptanceCriteriaItems.length > 0;
		const hasProposalments = p.verificationProposalments && p.verificationProposalments.length > 0;
		const hasPlan = !!p.implementationPlan;
		if (hasACs || hasPlan || hasProposalments) {
			p.maturity = "contracted";
			s.mutated = true;
		}
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function applyProposalUpdateInput(
	ctx: UpdateEngineContext,
	proposal: Proposal,
	input: ProposalUpdateInput,
	statusResolver: (status: string) => Promise<string>,
): Promise<{ proposal: Proposal; mutated: boolean }> {
	const s: S = { proposal, mutated: false };

	applyTextFields(input, s);
	applyCapabilitiesFields(input, s);
	applyExternalInjectionsFields(input, s);
	applyUnlocksFields(input, s);
	applyProofFields(input, s);
	await applyStatusField(ctx, input, statusResolver, s);
	applyPriorityField(input, s);
	applyDirectiveField(input, s);
	applyParentField(input, s);
	applyOrdinalField(input, s);
	applyAssigneeField(input, s);
	applyLabelsFields(input, s);
	await applyDependenciesFields(ctx, input, s);
	applyReferencesFields(input, s);
	applyDocumentationFields(input, s);
	applyRequiresFields(input, s);
	applyAppendableFields(input, s);
	applyClaimField(input, s);
	applyAcceptanceCriteriaFields(input, s);
	applyVerificationProposalmentsFields(input, s);
	applyMaturityField(input, s);

	return s;
}
