/**
 * P1374 (P1365-B): Pure, headlessly-testable formatting logic for the cockpit
 * WORKFORCE panel's throttle-state observability.
 *
 * The blessed-terminal rendering in cockpit.ts cannot be visually verified in a
 * headless test, so all the decision/format logic that *can* be verified lives
 * here as pure functions over plain data. cockpit.ts imports these so the SQL,
 * the renderer, and the unit tests agree by construction.
 *
 * Data source: roadmap_workforce.agency_capacity (P1365) — throttle_action
 * ('none'|'soft'|'hard'|'unknown'), headroom_pct numeric(5,2), reset_at.
 * The cockpit maps those onto WorkforceAgent.capacity* fields in unified-view.ts.
 */

/** Minimal shape the split/badge logic needs from a WorkforceAgent. */
export interface CapacityView {
	/** throttle_action from agency_capacity; null/absent ⇒ no capacity row. */
	capacityThrottleAction?: "none" | "soft" | "hard" | null;
	/** headroom_pct from agency_capacity; null/absent ⇒ unknown. */
	capacityHeadroomPct?: number | null;
}

/**
 * Headroom below which an agency is considered to be "coasting toward limits".
 * AC-5: badge appears when headroom_pct < HEADROOM_BADGE_THRESHOLD.
 */
export const HEADROOM_BADGE_THRESHOLD = 25;

/**
 * AC-3 classification. Among the idle (dispatchable) bench:
 *   - cooling = soft-throttled by capacity (throttle_action='soft')
 *   - ready   = everything else idle (throttle_action='none' or no capacity row)
 *
 * Soft-throttled agents are STILL dispatchable (deprioritized, not excluded —
 * mirrors the P1373 resolver), so they belong in AVAILABLE, not THROTTLED.
 * Hard-throttled agents are handled upstream (status='throttled') and never
 * reach this split.
 */
export function isCooling(a: CapacityView): boolean {
	return a.capacityThrottleAction === "soft";
}

/** Convenience: split a list of idle agents into [ready, cooling]. */
export function splitReadyCooling<T extends CapacityView>(
	idle: T[],
): { ready: T[]; cooling: T[] } {
	const ready: T[] = [];
	const cooling: T[] = [];
	for (const a of idle) {
		if (isCooling(a)) cooling.push(a);
		else ready.push(a);
	}
	return { ready, cooling };
}

/**
 * AC-3 header fragment for the ready/cooling counts.
 *   coolingCount = 0 → "N ready"
 *   coolingCount > 0 → "N ready · M cooling"
 * Returns the bare text (no blessed tags) so it is trivially assertable; the
 * caller wraps it in colour tags.
 */
export function formatReadyCoolingLabel(
	readyCount: number,
	coolingCount: number,
): string {
	if (coolingCount > 0) {
		return `${readyCount} ready · ${coolingCount} cooling`;
	}
	return `${readyCount} ready`;
}

/**
 * Human-readable relative time. ms is a duration (not an epoch).
 *   <0        → "now"
 *   <60s      → "in Xs"
 *   <60m      → "in Xm"
 *   otherwise → "in Xh"
 * Matches the long-standing cockpit.ts helper so badges and reset windows read
 * identically across the panel.
 */
export function formatRelativeTime(ms: number): string {
	if (ms < 0) return "now";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `in ${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `in ${hours}h`;
}

/**
 * P1377: canonical workforce counts the cockpit renders. Mirror of
 * WorkforceMetrics (src/shared/queries/workforce-counts.ts) — kept structural
 * here so cockpit-format stays DB/import-light and headlessly testable.
 *
 * NOTE: the soft dependency on P1372 — `drift_count > 0` is EXPECTED until
 * P1372's register_agency action populates roadmap.agency rows for every active
 * agent_registry row. Same note applies to AC-5's implementation-notes caveat.
 */
export interface CockpitCounts {
	total_agents: number;
	total_providers: number;
	online_count: number;
	registered_agencies: number;
	drift_count: number;
}

/**
 * P1377 AC-2/AC-7: top-of-screen header counts fragment. Renders EXACTLY:
 *   `{total_agents} agents · {total_providers} providers · {online_count} online · {registered_agencies} registered`
 * The word "agencies" must NOT appear (the old header conflated providers with
 * agencies). Returns bare text (no blessed tags) so it is exact-match testable;
 * the caller composes it into the titled header line.
 */
export function formatCockpitHeaderCounts(c: CockpitCounts): string {
	return (
		`${c.total_agents} agents · ${c.total_providers} providers · ` +
		`${c.online_count} online · ${c.registered_agencies} registered`
	);
}

/**
 * P1377 AC-3/AC-8: workforce panel subheader parts — EXACTLY 4 elements in this
 * order: agents, providers, online, registered. The caller wraps each in colour
 * tags and joins with ` · `. Returned as an array so tests can assert the exact
 * length and ordering independent of colour markup.
 */
export function buildWorkforceSubheaderParts(c: CockpitCounts): string[] {
	return [
		`${c.total_agents} agents`,
		`${c.total_providers} providers`,
		`${c.online_count} online`,
		`${c.registered_agencies} registered`,
	];
}

/**
 * P1377 AC-3/AC-9: drift marker for an agent's provider-group line. An agent in
 * agent_registry (active, un-reaped) with NO matching roadmap.agency row is
 * "drift" and renders a `[DRIFT]` ASCII marker; registered agents render no
 * marker. Returns " [DRIFT]" (leading space, so it appends cleanly after the
 * provider token) when drifting, else "".
 */
export function formatDriftMarker(isDrift: boolean | undefined): string {
	return isDrift ? " [DRIFT]" : "";
}

/**
 * AC-5 per-agency headroom badge: `[X% reset in Tm]`.
 *   - X = rounded headroom_pct
 *   - Tm = relative time until reset (uses formatRelativeTime)
 * Returns "" (no badge) when:
 *   - headroom is missing (null/undefined) — no capacity row, AC-5, or
 *   - headroom ≥ HEADROOM_BADGE_THRESHOLD (healthy, no badge).
 *
 * @param headroomPct  capacity headroom percentage, or null/undefined.
 * @param resetAtMs    epoch ms when capacity resets, or null/undefined.
 * @param nowMs        current epoch ms (injected for deterministic tests).
 */
export function formatHeadroomBadge(
	headroomPct: number | null | undefined,
	resetAtMs: number | null | undefined,
	nowMs: number,
): string {
	if (headroomPct === null || headroomPct === undefined) return "";
	if (headroomPct >= HEADROOM_BADGE_THRESHOLD) return "";
	const pct = Math.round(headroomPct);
	if (resetAtMs === null || resetAtMs === undefined) {
		// Known-low headroom but no reset horizon — still surface the pressure.
		return `[${pct}% reset unknown]`;
	}
	const rel = formatRelativeTime(resetAtMs - nowMs);
	return `[${pct}% reset ${rel}]`;
}
