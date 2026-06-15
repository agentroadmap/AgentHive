/**
 * V3-C6 (P1438) AC-9 — persona matchmaking for the self-claim path.
 *
 * When the AI liaison self-claims an open offer, it must pick the worker
 * *persona* before spawning. The C6 design (docs/runbooks/c6-ai-liaison.md
 * step 5) states the rule:
 *
 *   - common / popular capabilities → a STABLE persona name (so the same kind
 *     of work always maps to the same recognizable worker identity), and
 *   - rare / specialized capabilities → a DYNAMIC `claude.<specialty>` name
 *     derived from the requested capability.
 *
 * This module is the *mechanical* half of that judgment (the
 * "wrapper-enforced concerns" principle): given the claimed role + required
 * capabilities it returns a deterministic persona selection. The liaison brain
 * may still override the choice, but the default is encoded here, not
 * "remembered" by an LLM, so it is testable and consistent.
 *
 * The selection feeds the spawner's structured-identity branch: `expertiseHint`
 * is the capability hint that `agent-name.ts` encodes into the worker_identity
 * segment, and `personaName` is persisted on the dispatch row
 * (metadata.persona_name) so the control feed reflects the chosen persona.
 *
 * Pure: no DB, no I/O. The set of "common" capabilities is the live dispatch
 * taxonomy (ROLE_TO_REQUIRED_CAPABILITIES capability values + the role names the
 * marketplace routinely posts). Anything outside that set is treated as rare.
 */

/** Result of a matchmaking decision for one claimed offer. */
export interface PersonaMatch {
	/**
	 * The persona name recorded on the dispatch (metadata.persona_name) and used
	 * for the control-feed worker label. Stable for common capabilities,
	 * `claude.<specialty>` for rare ones.
	 */
	personaName: string;
	/**
	 * The capability/expertise hint handed to the spawner's structured-identity
	 * branch (agent-spawner identityHints → agent-name EXPERTISE encoding). For
	 * common capabilities this is the normalized capability; for rare ones it is
	 * the raw specialty so the worker_identity carries the specialty.
	 */
	expertiseHint: string;
	/** true = common/stable mapping; false = dynamic `claude.<specialty>`. */
	stable: boolean;
	/** Which signal the decision keyed on (for telemetry/debugging). */
	source: "role" | "capability" | "dynamic";
}

/**
 * Common capabilities → stable persona name. Keyed on the canonical capability
 * value (what agencies advertise / fn_claim_work_offer matches on), NOT the role
 * name — role names (developer/engineer/architect) all collapse to the
 * "develop" capability, and we want one stable persona per capability class.
 */
const STABLE_PERSONA_BY_CAPABILITY: Record<string, string> = {
	develop: "senior-developer",
	review: "gate-reviewer",
	design: "ui-designer",
	research: "trend-researcher",
	architecture: "software-architect",
	merge: "git-workflow-master",
};

/**
 * A few role names map to a more specific stable persona than their capability
 * alone would (a skeptic is a review capability but a distinct persona). Keyed
 * on the lowercased dispatch role. Checked before the capability fallback.
 */
const STABLE_PERSONA_BY_ROLE: Record<string, string> = {
	skeptic: "reality-checker",
	"skeptic-alpha": "reality-checker",
	"skeptic-beta": "reality-checker",
	"code-reviewer": "code-reviewer",
	"architecture-reviewer": "software-architect",
	architect: "software-architect",
	enhancer: "trend-researcher",
	researcher: "trend-researcher",
	merge: "git-workflow-master",
	merge_decision_agent: "gate-reviewer",
	gate_decision_agent: "gate-reviewer",
};

/** Map a stable persona name to its expertise hint for the structured identity. */
const PERSONA_EXPERTISE: Record<string, string> = {
	"senior-developer": "develop",
	"gate-reviewer": "review",
	"ui-designer": "design",
	"trend-researcher": "research",
	"software-architect": "architecture",
	"git-workflow-master": "merge",
	"reality-checker": "review",
	"code-reviewer": "review",
};

/**
 * Normalize a raw capability/specialty token into a slug safe for a
 * `claude.<specialty>` name and an agent-identity expertise segment:
 * lowercase, non-alphanumerics → single hyphen, trimmed, capped.
 */
export function slugifySpecialty(raw: string): string {
	const slug = raw
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	return slug.length > 0 ? slug : "general";
}

/**
 * Pick the worker persona for a claimed offer.
 *
 * Precedence:
 *   1. A role-specific stable persona (skeptic → reality-checker, etc.).
 *   2. A capability-class stable persona (develop → senior-developer, etc.),
 *      using the first required capability the marketplace matched on.
 *   3. Otherwise the capability is RARE → dynamic `claude.<specialty>`.
 *
 * @param role the claimed dispatch role (squad_dispatch.dispatch_role)
 * @param capabilities the offer's required_capabilities (may be empty)
 */
export function matchPersonaForCapability(
	role: string,
	capabilities: readonly string[] = [],
): PersonaMatch {
	const normRole = (role ?? "").toLowerCase().trim();

	// 1. Role-specific stable persona.
	const roleStable = STABLE_PERSONA_BY_ROLE[normRole];
	if (roleStable) {
		return {
			personaName: roleStable,
			expertiseHint: PERSONA_EXPERTISE[roleStable] ?? "develop",
			stable: true,
			source: "role",
		};
	}

	// 2. Capability-class stable persona. Pick the first capability that has a
	//    stable mapping so an offer advertising ["develop"] is deterministic even
	//    if it also lists rarer extras.
	for (const cap of capabilities) {
		const normCap = (cap ?? "").toLowerCase().trim();
		const capStable = STABLE_PERSONA_BY_CAPABILITY[normCap];
		if (capStable) {
			return {
				personaName: capStable,
				expertiseHint: PERSONA_EXPERTISE[capStable] ?? normCap,
				stable: true,
				source: "capability",
			};
		}
	}

	// 3. Rare capability → dynamic claude.<specialty>. Prefer the first
	//    non-empty capability as the specialty, else fall back to the role.
	const specialtySource =
		capabilities.find((c) => c && c.trim().length > 0) ?? normRole ?? "general";
	const specialty = slugifySpecialty(specialtySource);
	return {
		personaName: `claude.${specialty}`,
		expertiseHint: specialty,
		stable: false,
		source: "dynamic",
	};
}
