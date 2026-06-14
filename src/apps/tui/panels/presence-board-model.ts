/**
 * P1065 — Presence Board: PURE decision logic (no blessed, no pg).
 *
 * Every function here is TTY-free and DB-free so it can be unit-tested
 * headlessly. The panel (`presence-board.ts`) maps a P1067 `PanelContext`
 * onto these helpers and feeds them rows it pulled via `ctx.query`.
 *
 * SCHEMA NOTE (ground-truthed against the live DB, 2026-06-14):
 *   The P1065 AC text references two schema variants that do NOT exist:
 *     - `fn_agency_status_for` / `roadmap.liaison_message.kind_id` /
 *       `squad_dispatch.acknowledged_at`  (AC-1..12 variant), and
 *     - `agency.*` / `workforce.*` / `agent_trust.revoked_at|lifecycle_status`
 *       (AC-15..26 variant).
 *   The REAL objects are:
 *     - roadmap.v_agency_status         (agency_id, display_name, status,
 *                                        presence_state, silence_seconds,
 *                                        dispatchable, liveness_state,
 *                                        has_live_listener, last_heartbeat_at)
 *     - roadmap.liaison_message         (agency_id, direction, kind, payload,
 *                                        acked_at, created_at)   direction is a
 *                                        CHECK of the two exact AC-11 strings.
 *     - roadmap_workforce.agent_trust   (agent_identity, trusted_agent,
 *                                        trust_level, expires_at, created_at)
 *     - roadmap_workforce.squad_dispatch(agency_identity, dispatch_status,
 *                                        proposal_id, assigned_at, claimed_at)
 *   This module builds against the REAL schema. Trust-filtered view (AC-3) is
 *   MVP-deferred per AC-14/AC-23 since fn_agency_status_for is not deployed.
 */

// ---------------------------------------------------------------------------
// Row shapes (mirror the live SELECTs in presence-board.ts)
// ---------------------------------------------------------------------------

/** One row of roadmap.v_agency_status + the joined active-task display_id. */
export interface AgencyRow {
	agency_id: string;
	display_name: string;
	status: string;
	presence_state: string;
	/** seconds since last heartbeat (numeric in pg → number here). */
	silence_seconds: number;
	dispatchable: boolean;
	liveness_state: string | null;
	has_live_listener: boolean;
	/** proposal display_id of the most-recent non-terminal dispatch, or null. */
	active_task: string | null;
}

/** A liaison_message row for the inspector Messaging tab. */
export interface MessageRow {
	message_id: string;
	direction: string; // 'orchestrator->liaison' | 'liaison->orchestrator'
	kind: string;
	created_at: string; // ISO
	acked_at: string | null;
}

/** An agent_trust row for the inspector Trust tab. */
export interface TrustRow {
	agent_identity: string;
	trusted_agent: string;
	trust_level: string;
	created_at: string | null;
	expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Presence → colour (AC-9 / AC-17). Returns a SEMANTIC theme key, never a raw
// blessed colour literal (P1067 AC-21). The panel resolves these via ctx.theme.
// ---------------------------------------------------------------------------

export type ThemeKey =
	| "success" // online → green
	| "warning" // away → yellow
	| "muted" // idle → dim-yellow
	| "danger" // offline → red
	| "accent" // section headings / labels
	| "fg"; // unknown/restricted → grey-ish (theme fg)

/**
 * Map a v_agency_status row to a semantic colour key.
 *
 * The live view only emits presence_state ∈ {online, offline}, but AC-9/AC-17
 * want the full ladder. We derive the finer buckets from silence_seconds when
 * the row is not already offline, matching AC-17's thresholds:
 *   online  : dispatchable / silence ≤ 60s
 *   away    : 60s  < silence ≤ 300s
 *   idle    : 300s < silence ≤ 3600s
 *   offline : silence > 3600s OR presence_state='offline' OR status≠'active'
 *   unknown : presence_state='unknown' (restricted) → fg/grey
 */
export function presenceColorKey(row: {
	presence_state: string;
	silence_seconds: number;
	dispatchable: boolean;
	status: string;
}): ThemeKey {
	if (row.presence_state === "unknown") return "fg";
	if (
		row.presence_state === "offline" ||
		row.status !== "active" ||
		row.silence_seconds > 3600
	) {
		return "danger";
	}
	if (row.dispatchable || row.silence_seconds <= 60) return "success";
	if (row.silence_seconds <= 300) return "warning";
	return "muted"; // 300 < silence ≤ 3600 → idle/dim-yellow
}

/** Human label for the presence bucket (used in the legend + cell text). */
export function presenceLabel(row: {
	presence_state: string;
	silence_seconds: number;
	dispatchable: boolean;
	status: string;
}): string {
	if (row.presence_state === "unknown") return "restricted";
	if (
		row.presence_state === "offline" ||
		row.status !== "active" ||
		row.silence_seconds > 3600
	) {
		return "offline";
	}
	if (row.dispatchable || row.silence_seconds <= 60) return "online";
	if (row.silence_seconds <= 300) return "away";
	return "idle";
}

// ---------------------------------------------------------------------------
// silence_seconds formatting (AC-1 / AC-15): "Xs" or "Xm Ys".
// ---------------------------------------------------------------------------

export function formatSilence(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
}

// ---------------------------------------------------------------------------
// Cold-wake detection (AC-10 / AC-24). Fresh heartbeat OR a live listener means
// "live" even if it failed a synchronous poke — the P2404 heartbeat-override
// rule. A row is flagged cold-wake when it is registered-active with a STALE
// heartbeat but is NOT yet offline (so the board can hash-overlay it).
// ---------------------------------------------------------------------------

export function isColdWake(row: {
	status: string;
	silence_seconds: number;
	has_live_listener: boolean;
	liveness_state: string | null;
}): boolean {
	if (row.status !== "active") return false;
	// Honour heartbeat/listener freshness over poke outcome.
	if (row.has_live_listener) return false;
	if (row.silence_seconds <= 60) return false;
	// registered-active, no live listener, stale-ish but not fully offline
	return row.silence_seconds <= 3600;
}

// ---------------------------------------------------------------------------
// Sort (AC-1 / AC-8 / AC-15): offline last, then silence_seconds DESC so the
// stalest *non-offline* agency floats to the top. Stable + total.
// ---------------------------------------------------------------------------

export function sortAgencyRows(rows: AgencyRow[]): AgencyRow[] {
	const isOffline = (r: AgencyRow) => presenceLabel(r) === "offline";
	return [...rows].sort((a, b) => {
		const ao = isOffline(a) ? 1 : 0;
		const bo = isOffline(b) ? 1 : 0;
		if (ao !== bo) return ao - bo; // offline (1) sorts last
		// both same offline-ness → silence DESC (stalest first)
		if (b.silence_seconds !== a.silence_seconds) {
			return b.silence_seconds - a.silence_seconds;
		}
		return a.agency_id.localeCompare(b.agency_id); // tiebreak for stability
	});
}

// ---------------------------------------------------------------------------
// Inspector — Messaging tab split (AC-4 / AC-11 / AC-19).
//   inbox  = direction 'orchestrator->liaison'
//   outbox = direction 'liaison->orchestrator'
// Unacked = acked_at IS NULL (protocol ack). AC-22's "unacked offers" warning
// surfaces offer_dispatch messages older than 2 min with acked_at NULL.
// ---------------------------------------------------------------------------

export interface MessagingView {
	inbox: MessageRow[];
	outbox: MessageRow[];
	unackedOffers: MessageRow[];
}

export const OFFER_UNACK_THRESHOLD_MS = 2 * 60 * 1000;

export function splitMessages(
	rows: MessageRow[],
	now: number = Date.now(),
): MessagingView {
	const inbox: MessageRow[] = [];
	const outbox: MessageRow[] = [];
	const unackedOffers: MessageRow[] = [];
	for (const r of rows) {
		if (r.direction === "orchestrator->liaison") inbox.push(r);
		else outbox.push(r);
		const isOffer = /offer/i.test(r.kind);
		if (
			isOffer &&
			r.acked_at == null &&
			now - new Date(r.created_at).getTime() >= OFFER_UNACK_THRESHOLD_MS
		) {
			unackedOffers.push(r);
		}
	}
	return { inbox, outbox, unackedOffers };
}

/** "warning row" text for an unacked offer (AC-22: red [UNACK] + time delta). */
export function unackedOfferLabel(
	r: MessageRow,
	now: number = Date.now(),
): string {
	const ageS = Math.floor((now - new Date(r.created_at).getTime()) / 1000);
	return `[UNACK] ${r.kind} — ${formatSilence(ageS)} ago`;
}

// ---------------------------------------------------------------------------
// Inspector — Trust tab grouping (AC-5 / AC-12 / AC-20).
//   expires_at < now           → expired (dimmed, separate section)
//   now ≤ expires_at < now+24h  → expiring (yellow highlight)
//   else / null                 → ok
// ---------------------------------------------------------------------------

export type TrustExpiry = "expired" | "expiring" | "ok";

export const TRUST_EXPIRY_WARN_MS = 24 * 60 * 60 * 1000;

export function trustExpiry(
	r: TrustRow,
	now: number = Date.now(),
): TrustExpiry {
	if (r.expires_at == null) return "ok";
	const exp = new Date(r.expires_at).getTime();
	if (exp < now) return "expired";
	if (exp < now + TRUST_EXPIRY_WARN_MS) return "expiring";
	return "ok";
}

export interface TrustView {
	/** non-expired rows grouped by trust_level tier. */
	activeByTier: Map<string, TrustRow[]>;
	/** expired rows (rendered dimmed under an [expired] section). */
	expired: TrustRow[];
}

export function groupTrust(
	rows: TrustRow[],
	now: number = Date.now(),
): TrustView {
	const activeByTier = new Map<string, TrustRow[]>();
	const expired: TrustRow[] = [];
	for (const r of rows) {
		if (trustExpiry(r, now) === "expired") {
			expired.push(r);
			continue;
		}
		const tier = r.trust_level;
		const bucket = activeByTier.get(tier) ?? [];
		bucket.push(r);
		activeByTier.set(tier, bucket);
	}
	return { activeByTier, expired };
}

// ---------------------------------------------------------------------------
// Board view-model: selection + mode state machine (AC-6 / AC-21).
//   BOARD → (enter) → INSPECTOR-messaging ↔ (tab) → INSPECTOR-trust
//   INSPECTOR-* → (esc) → BOARD
// Pure reducer so the keypress sequence in AC-21 can be unit-tested.
// ---------------------------------------------------------------------------

export type BoardMode = "board" | "inspector-messaging" | "inspector-trust";

export interface BoardState {
	mode: BoardMode;
	/** index into the (already sorted) rows array. */
	cursor: number;
	rowCount: number;
}

export type BoardKey = "up" | "down" | "enter" | "tab" | "esc";

export function reduceBoard(state: BoardState, key: BoardKey): BoardState {
	switch (key) {
		case "up":
			if (state.mode !== "board") return state;
			return { ...state, cursor: Math.max(0, state.cursor - 1) };
		case "down":
			if (state.mode !== "board") return state;
			return {
				...state,
				cursor: Math.min(Math.max(0, state.rowCount - 1), state.cursor + 1),
			};
		case "enter":
			if (state.mode !== "board" || state.rowCount === 0) return state;
			return { ...state, mode: "inspector-messaging" };
		case "tab":
			if (state.mode === "inspector-messaging")
				return { ...state, mode: "inspector-trust" };
			if (state.mode === "inspector-trust")
				return { ...state, mode: "inspector-messaging" };
			return state;
		case "esc":
			if (state.mode === "board") return state;
			return { ...state, mode: "board" };
		default:
			return state;
	}
}

/** Status-bar mode tag (AC-21): '[BOARD]' | '[INSPECTOR-messaging]' | … */
export function modeTag(mode: BoardMode): string {
	return mode === "board" ? "[BOARD]" : `[INSPECTOR-${mode.split("-")[1]}]`;
}

// ---------------------------------------------------------------------------
// Fallback banner (AC-7 / AC-14 / AC-23). Since fn_agency_status_for is NOT
// deployed, the board renders the legacy view UNFILTERED and shows a banner.
// ---------------------------------------------------------------------------

export function fallbackBanner(hasStatusForFn: boolean): string | null {
	if (hasStatusForFn) return null;
	return "[Presence unfiltered — fn_agency_status_for not deployed; showing legacy v_agency_status view]";
}
