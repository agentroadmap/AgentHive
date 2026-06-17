/**
 * Shared proposal-event feed grammar.
 *
 * Single source of truth for how proposal lifecycle events are spoken across
 * AgentHive's feeds: the Discord state feed (scripts/state-feed-listener.ts)
 * and the TUI board feed (src/apps/ui/board.ts + live-feed.ts). Keeping the
 * agent-name normalization, status verbs, and emoji vocabulary here stops the
 * two feeds from drifting apart (P720 grammar is the canonical baseline).
 *
 * Pure module — no I/O, no imports — safe to use from a `bun run` script and
 * from the jiti-loaded TUI alike.
 */

// ─── Status verbs (state → human verb) ──────────────────────────────────────

export const STATUS_VERB_RFC: Record<string, string> = {
	DRAFT: "drafting",
	REVIEW: "reviewing",
	DEVELOP: "developing",
	MERGE: "merge-ready",
	COMPLETE: "shipped",
};

export const STATUS_VERB_HOTFIX: Record<string, string> = {
	TRIAGE: "triaging",
	FIX: "fixing",
	DEPLOYED: "deployed",
};

export function statusVerb(type: string | null, status: string): string {
	const upper = (status ?? "").toUpperCase();
	if ((type ?? "").toLowerCase() === "hotfix") {
		return STATUS_VERB_HOTFIX[upper] ?? upper.toLowerCase();
	}
	return STATUS_VERB_RFC[upper] ?? upper.toLowerCase();
}

// ─── Emoji vocabulary ───────────────────────────────────────────────────────
// Status emoji keyed by the TARGET state (what the proposal is becoming).

export const STATUS_EMOJI: Record<string, string> = {
	COMPLETE: "🏁",
	DEPLOYED: "🚀",
	MERGE: "🔀",
	DEVELOP: "🔨",
	FIX: "🔧",
	REVIEW: "🔍",
	TRIAGE: "🔎",
	DRAFT: "📝",
};
export const STATUS_EMOJI_DEFAULT = "🔄";

export function statusEmoji(toState: string | null | undefined): string {
	return STATUS_EMOJI[(toState ?? "").toUpperCase()] ?? STATUS_EMOJI_DEFAULT;
}

/** Maturity changes use a single "promote" glyph in the Discord feed. */
export const MATURITY_EMOJI = "⏫";

export const LEASE_CLAIMED_EMOJI = "🔒";
/** Lease release glyph keyed by the gate release_reason. */
export const LEASE_RELEASED_EMOJI: Record<string, string> = {
	gate_review_complete: "✅",
	gate_hold: "⏸️",
	gate_reject: "🚫",
	gate_waive: "🔄",
};
export const LEASE_RELEASED_DEFAULT = "🔓";

/** Gate decision glyph keyed by the decision verb. */
export const DECISION_EMOJI: Record<string, string> = {
	advance: "✅",
	hold: "⏸️",
	reject: "🚫",
	waive: "🔄",
};
export const DECISION_EMOJI_DEFAULT = "🔔";

export const REVIEW_EMOJI = "💬";
export const CREATED_EMOJI = "📝";
export const GATE_READY_EMOJI = "🚪";

/** Agent-run outcome glyphs (these feed lines carry the provider/model). */
export const RUN_EMOJI = {
	passed: "✅",
	failed: "❌",
	running: "⚙️",
} as const;

// ─── Agent identity normalization ───────────────────────────────────────────

/**
 * Normalize a raw agent identity for display. Two collapses, so the same
 * logical actor is spoken with one name across the Discord + TUI feeds:
 *
 *   1. Worker spawn form "worker-12 (claude)@host" → "host/claude".
 *   2. Agency-liaison suffix "<agency>.a" → "<agency>". Per the operator
 *      identity model, `claude-bot-gary` is the AGENCY and `claude-bot-gary.a`
 *      is its liaison (the dispatcher session); a lease the liaison claims on
 *      the agency's behalf reads as the agency. Without this, the feed shows
 *      both names for what is one actor and looks inconsistent. Only a trailing
 *      ".a" (the documented liaison form) is stripped — hyphenated identities
 *      like `claude-bot-gary-a` (a distinct LLM route) are left untouched.
 *
 * Otherwise returns the trimmed identity (or "agent" when empty).
 */
export function normalizeAgent(raw: string | null | undefined): string {
	const s = (raw ?? "").trim();
	if (!s) return "agent";
	const m = /^worker-\d+\s+\(([^)]+)\)@(.+)$/i.exec(s);
	if (m) return `${m[2]}/${m[1]}`;
	const liaison = /^(.+)\.a$/.exec(s);
	if (liaison) return liaison[1];
	return s;
}
