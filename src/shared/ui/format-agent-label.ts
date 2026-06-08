/**
 * P919 + P928 + P933: Agent label formatting helper for dashboard and journalctl
 *
 * AC-10: formatAgentLabel(row) returns row.display_alias with optional identity suffix
 * Used in UI renderings and structured logs to show both human-readable name
 * and immutable identity when alias is present.
 *
 * P928 AC-5: Extended with optional opts to show backend hint when showBackend=true.
 * For subscription routes, shows route_provider; for metered routes, shows model_name.
 *
 * P933: Additional host-stripping logic for contexts where SQL CASE isn't available.
 * Host-strip rule: if alias has exactly 3 hyphen-segments and the middle segment
 * matches a known host, strip it → "{Provider}-{Role} ({identity})".
 * The caller supplies `knownHosts` from the DB (roadmap.agency.host_id), NOT a
 * hardcoded list — same naming-as-data principle enforced by P920/P933.
 */

export interface AgentLabelRow {
	display_alias?: string | null;
	agent_identity: string;
}

export interface BackendRouteHint {
	plan_type?: string | null;
	route_provider?: string;
	model_name?: string;
}

export interface FormatAgentLabelOpts {
	/** Lower-cased host_id values from roadmap.agency. Pass [] when unknown. */
	knownHosts?: string[];
	/** Show backend route hint in output */
	showBackend?: boolean;
	/** Route information for backend hint rendering (P928) */
	route?: BackendRouteHint | null;
}

/**
 * Primary formatter: handles both P928 backend hints and P933 host stripping.
 * Returns display_alias with optional identity suffix and/or backend hint.
 *
 * - NULL alias → raw identity (byte-for-byte backward compat)
 * - 2-segment alias ("Claude-Bot") → "Claude-Bot ({identity})" or with hint
 * - 3-segment alias, middle = known host → "Claude-Role ({identity})"
 * - 3-segment alias, middle = unknown host → "Claude-Unknown-Role ({identity})"
 * - N≠3 segments → full alias ({identity}) or with hint
 */
export function formatAgentLabel(
	row: AgentLabelRow,
	opts?: FormatAgentLabelOpts,
): string {
	if (!row.display_alias) {
		return row.agent_identity;
	}

	const parts = row.display_alias.split("-");
	const hosts = opts?.knownHosts ?? [];

	// P933: Apply host-stripping logic
	let displayName: string;
	if (parts.length === 3 && hosts.includes(parts[1]!.toLowerCase())) {
		displayName = `${parts[0]}-${parts[2]}`;
	} else {
		displayName = row.display_alias;
	}

	// P928 AC-5: backend hint rendering (optional)
	if (opts?.showBackend && opts.route) {
		const hint =
			opts.route.plan_type === "subscription"
				? opts.route.route_provider
				: opts.route.model_name;
		return hint ? `${displayName} (${hint})` : `${displayName} (${row.agent_identity})`;
	}

	return `${displayName} (${row.agent_identity})`;
}

/**
 * Short form — display name only, no identity suffix.
 * For space-constrained contexts (column headers, status chips).
 * Applies P933 host-stripping if knownHosts is provided.
 */
export function formatAgentLabelShort(row: AgentLabelRow, opts?: FormatAgentLabelOpts): string {
	if (!row.display_alias) {
		return row.agent_identity;
	}

	const parts = row.display_alias.split("-");
	const hosts = opts?.knownHosts ?? [];

	if (parts.length === 3 && hosts.includes(parts[1]!.toLowerCase())) {
		return `${parts[0]}-${parts[2]}`;
	}

	return row.display_alias;
}

/**
 * P933: Live-feed label — strips the known host segment from 3-part aliases.
 *
 * For aliases of the form "{Provider}-{Host}-{Role}" where Host is in knownHosts,
 * returns "{Provider}-{Role} ({agent_identity})".
 * 2-part aliases and unknown hosts render verbatim with identity in parens.
 * NULL alias falls back to raw identity (no parens).
 *
 * Host matching is case-insensitive. knownHosts defaults to [] (no stripping).
 */
export function formatAgentLabelLive(
	row: AgentLabelRow,
	opts?: { knownHosts?: string[] },
): string {
	if (!row.display_alias) return row.agent_identity;

	const parts = row.display_alias.split("-");
	const knownHosts = opts?.knownHosts ?? [];

	if (
		parts.length === 3 &&
		knownHosts.some((h) => h.toLowerCase() === parts[1].toLowerCase())
	) {
		return `${parts[0]}-${parts[2]} (${row.agent_identity})`;
	}

	return `${row.display_alias} (${row.agent_identity})`;
}

