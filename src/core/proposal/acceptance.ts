/**
 * Acceptance Module
 * Manages validation, review, and acceptance of proposal transitions.
 * Agents cannot self-certify completion without evidence.
 *
 * Workflow: Active → Review → (pass) → Reached
 *                       ↘ (fail) → Active (return to claimant)
 *
 * Loop detection: If proposal fails review N times, escalate to coordinator.
 *
 * Issue blocking: Proposals with open critical/major test issues cannot reach Reached.
 */

import {
	getBlockingIssues,
	type IssueStore,
} from "../pipeline/issue-tracker.ts";

export type ProofType =
	| "command-output"
	| "test-result"
	| "artifact"
	| "commit"
	| "validation-summary";
export type Verifier = "builder" | "peer-tester" | "coordinator";
export type ReviewResult = "pass" | "fail" | "escalated";

export interface ProofReference {
	/** Type of proof */
	type: ProofType;
	/** The actual proof value (command output, path, hash, etc.) */
	value: string;
	/** Who verified this proof */
	verifiedBy?: string;
	/** Timestamp when proof was recorded */
	timestamp?: string;
}

export interface ProofRequirement {
	/** Human-readable description of what must be proven */
	description: string;
	/** Expected evidence type */
	evidenceType: ProofType;
	/** Who must verify: builder, peer-tester, or coordinator */
	verifier: Verifier;
}

export interface ProofValidationResult {
	valid: boolean;
	missingRequirements: string[];
	invalidProofs: string[];
	peerAuditRequired: boolean;
	peerAuditDone: boolean;
	message: string;
}

export interface ReviewEntry {
	/** Timestamp of the review */
	timestamp: string;
	/** Who performed the review */
	reviewer: string;
	/** Result: pass, fail, or escalated */
	result: ReviewResult;
	/** Original claimant to return to on failure */
	claimant: string;
	/** Reason for failure or escalation */
	reason?: string;
	/** Missing requirements or issues found */
	issues?: string[];
}

export interface ReviewHistory {
	/** Proposal ID */
	proposalId: string;
	/** All review attempts */
	entries: ReviewEntry[];
	/** Current review count */
	reviewCount: number;
	/** Whether proposal is currently in escalation */
	isEscalated: boolean;
}

/** Maximum review attempts before escalation */
const MAX_REVIEW_ATTEMPTS = 3;

/**
 * Check if a proof reference satisfies a requirement.
 */
export function proofSatisfiesRequirement(
	proof: ProofReference,
	requirement: ProofRequirement,
): boolean {
	if (proof.type !== requirement.evidenceType) return false;
	if (!proof.value || proof.value.trim().length === 0) return false;
	return true;
}

/**
 * Validate that all proof requirements are met by the provided proof references.
 */
export function validateProof(
	requirements: ProofRequirement[],
	references: ProofReference[],
	options?: { isPeerAudit?: boolean; auditAgent?: string },
): ProofValidationResult {
	const missingRequirements: string[] = [];
	const invalidProofs: string[] = [];
	let peerAuditRequired = false;
	let peerAuditDone = false;

	for (const req of requirements) {
		if (req.verifier === "peer-tester") {
			peerAuditRequired = true;
		}

		const matchingProof = references.find((p) =>
			proofSatisfiesRequirement(p, req),
		);

		if (!matchingProof) {
			missingRequirements.push(req.description);
			continue;
		}

		if (req.verifier === "peer-tester") {
			if (matchingProof.verifiedBy) {
				peerAuditDone = true;
			} else if (options?.isPeerAudit && options?.auditAgent) {
				matchingProof.verifiedBy = options.auditAgent;
				peerAuditDone = true;
			} else {
				invalidProofs.push(`${req.description} requires peer verification`);
			}
		}
	}

	const valid =
		missingRequirements.length === 0 &&
		invalidProofs.length === 0 &&
		(!peerAuditRequired || peerAuditDone);

	let message: string;
	if (valid) {
		message = "All proof requirements satisfied";
	} else {
		const parts: string[] = [];
		if (missingRequirements.length > 0) {
			parts.push(`Missing: ${missingRequirements.join(", ")}`);
		}
		if (invalidProofs.length > 0) {
			parts.push(`Invalid: ${invalidProofs.join(", ")}`);
		}
		if (peerAuditRequired && !peerAuditDone) {
			parts.push("Peer audit required but not completed");
		}
		message = parts.join("; ");
	}

	return {
		valid,
		missingRequirements,
		invalidProofs,
		peerAuditRequired,
		peerAuditDone,
		message,
	};
}

/**
 * Record a review attempt and determine next action.
 * Returns the next status and whether escalation is needed.
 */
export function recordReview(
	history: ReviewHistory,
	reviewer: string,
	result: ReviewResult,
	claimant: string,
	issues?: string[],
	reason?: string,
): {
	nextStatus: "Reached" | "Active" | "Blocked";
	shouldEscalate: boolean;
	entry: ReviewEntry;
} {
	const entry: ReviewEntry = {
		timestamp: new Date().toISOString(),
		reviewer,
		result,
		claimant,
		reason,
		issues,
	};

	const newCount = history.reviewCount + 1;
	const shouldEscalate = result === "fail" && newCount >= MAX_REVIEW_ATTEMPTS;

	// Update history
	history.entries.push(entry);
	history.reviewCount = newCount;
	history.isEscalated = shouldEscalate;

	if (result === "pass") {
		return { nextStatus: "Reached", shouldEscalate: false, entry };
	}
	if (shouldEscalate) {
		return { nextStatus: "Blocked", shouldEscalate: true, entry };
	}
	// Return to claimant for fixes
	return { nextStatus: "Active", shouldEscalate: false, entry };
}

/**
 * Check if a proposal should be escalated based on review history.
 */
export function shouldEscalate(history: ReviewHistory): boolean {
	return (
		history.reviewCount >= MAX_REVIEW_ATTEMPTS &&
		!history.entries.some((e) => e.result === "pass")
	);
}

/**
 * Get the original claimant from review history (first entry's claimant).
 */
export function getOriginalClaimant(history: ReviewHistory): string | null {
	if (history.entries.length === 0) return null;
	return history.entries[0]?.claimant;
}

/**
 * Parse review history from markdown content.
 * Format:
 * ## Review History
 * - [pass] 2026-03-20T12:00:00Z by @Opus (claimant: @Gemini)
 * - [fail] 2026-03-20T13:00:00Z by @Copilot (claimant: @Gemini) — Missing tests
 */
export function parseReviewHistory(
	content: string,
	proposalId: string,
): ReviewHistory {
	const history: ReviewHistory = {
		proposalId,
		entries: [],
		reviewCount: 0,
		isEscalated: false,
	};
	const section = content.match(
		/## Review History\n\n([\s\S]*?)(?:\n##|\n---|$)/,
	);
	if (!section) return history;

	const lines = section[1]?.split("\n") || [];
	for (const line of lines) {
		const match = line.match(
			/^- \[(\w+)\] (\S+) by @?(\w[\w-]*)(?: \(claimant: @?(\w[\w-]*)\))?(?:\s*— (.+))?$/,
		);
		if (match) {
			history.entries.push({
				result: match[1] as ReviewResult,
				timestamp: match[2]!,
				reviewer: match[3]!,
				claimant: match[4] || "unknown",
				reason: match[5]?.trim(),
			});
		}
	}

	history.reviewCount = history.entries.length;
	history.isEscalated = shouldEscalate(history);
	return history;
}

/**
 * Serialize review history to markdown.
 */
export function serializeReviewHistory(history: ReviewHistory): string {
	if (history.entries.length === 0) return "";

	const lines = ["## Review History", ""];
	for (const entry of history.entries) {
		const claimant = entry.claimant ? ` (claimant: @${entry.claimant})` : "";
		const reason = entry.reason ? ` — ${entry.reason}` : "";
		lines.push(
			`- [${entry.result}] ${entry.timestamp} by @${entry.reviewer}${claimant}${reason}`,
		);
	}
	return lines.join("\n");
}

/**
 * Parse proof references from a markdown section.
 */
export function parseProofReferences(content: string): ProofReference[] {
	const references: ProofReference[] = [];
	const proofSection = content.match(
		/## Proof References\n\n([\s\S]*?)(?:\n##|\n---|$)/,
	);
	if (!proofSection) return references;

	const lines = proofSection[1]?.split("\n") || [];
	for (const line of lines) {
		const match = line.match(
			/^- \[[ x]\] (\w+[-\w]*): (.+?)(?: \(verified by (.+?)\))?$/,
		);
		if (match) {
			references.push({
				type: match[1] as ProofType,
				value: match[2]?.trim(),
				verifiedBy: match[3]?.trim(),
			});
		}
	}
	return references;
}

/**
 * Serialize proof references to markdown.
 */
export function serializeProofReferences(references: ProofReference[]): string {
	if (references.length === 0) return "";

	const lines = ["## Proof References", ""];
	for (const ref of references) {
		const verified = ref.verifiedBy ? ` (verified by ${ref.verifiedBy})` : "";
		lines.push(`- [x] ${ref.type}: ${ref.value}${verified}`);
	}
	return lines.join("\n");
}

/**
 * Parse proof requirements from a markdown section.
 */
export function parseProofRequirements(content: string): ProofRequirement[] {
	const requirements: ProofRequirement[] = [];
	const reqSection = content.match(
		/## Proof Requirements\n\n([\s\S]*?)(?:\n##|\n---|$)/,
	);
	if (!reqSection) return requirements;

	const lines = reqSection[1]?.split("\n") || [];
	for (const line of lines) {
		const match = line.match(
			/^- \[[ x]\] [\w-]+: (.+?) \(evidence: ([\w-]+), verifier: (\w[\w-]*)\)$/,
		);
		if (match) {
			requirements.push({
				description: match[1]?.trim(),
				evidenceType: match[2] as ProofType,
				verifier: match[3] as Verifier,
			});
		}
	}
	return requirements;
}

/**
 * Serialize proof requirements to markdown.
 */
export function serializeProofRequirements(
	requirements: ProofRequirement[],
): string {
	if (requirements.length === 0) return "";

	const lines = ["## Proof Requirements", ""];
	for (const req of requirements) {
		lines.push(
			`- [ ] req: ${req.description} (evidence: ${req.evidenceType}, verifier: ${req.verifier})`,
		);
	}
	return lines.join("\n");
}

/**
 * Format proof validation result for display.
 */
export function formatValidationResult(result: ProofValidationResult): string {
	if (result.valid) {
		return `✅ ${result.message}`;
	}

	const parts = [`❌ ${result.message}`];
	if (result.missingRequirements.length > 0) {
		parts.push(`  Missing requirements: ${result.missingRequirements.length}`);
	}
	if (result.peerAuditRequired && !result.peerAuditDone) {
		parts.push(`  Peer audit: required but not completed`);
	}
	return parts.join("\n");
}

/**
 * Format review decision for display.
 */
export function formatReviewDecision(
	nextStatus: string,
	shouldEscalate: boolean,
	claimant: string,
): string {
	if (nextStatus === "Reached") {
		return `✅ Accepted — moving to Reached`;
	}
	if (shouldEscalate) {
		return `🚨 Escalated — exceeded ${MAX_REVIEW_ATTEMPTS} review attempts, needs coordinator intervention`;
	}
	return `🔄 Returned to @${claimant} for fixes (attempt ${/* will be filled by caller */ "?"})`;
}

/**
 * Check if a proposal is blocked by open test issues.
 * Critical and major issues block the Reached transition.
 */
export function validateNoBlockingIssues(
	issueStore: IssueStore,
	proposalId: string,
): { blocked: boolean; issues: string[] } {
	const blocking = getBlockingIssues(issueStore, proposalId);
	if (blocking.length === 0) {
		return { blocked: false, issues: [] };
	}
	return {
		blocked: true,
		issues: blocking.map((i) => `${i.id}: ${i.title} (${i.severity})`),
	};
}

/**
 * Validate that a proposal can transition to Reached.
 * Checks both proof requirements and blocking issues.
 */
export function validateReachedTransition(
	requirements: ProofRequirement[],
	references: ProofReference[],
	issueStore: IssueStore,
	proposalId: string,
	options?: { isPeerAudit?: boolean; auditAgent?: string },
): { canReach: boolean; reasons: string[] } {
	const reasons: string[] = [];

	// Check proof requirements
	const proofResult = validateProof(requirements, references, options);
	if (!proofResult.valid) {
		reasons.push(proofResult.message);
	}

	// Check blocking issues
	const issueCheck = validateNoBlockingIssues(issueStore, proposalId);
	if (issueCheck.blocked) {
		reasons.push(
			`Blocked by ${issueCheck.issues.length} open issue(s): ${issueCheck.issues.join("; ")}`,
		);
	}

	return {
		canReach: reasons.length === 0,
		reasons,
	};
}
