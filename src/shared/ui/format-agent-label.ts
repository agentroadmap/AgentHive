/**
 * P919 + P928: Agent label formatting helper for dashboard and journalctl
 *
 * AC-10: formatAgentLabel(row) returns row.display_alias ?? row.agent_identity
 * Used in UI renderings and structured logs to show both human-readable name
 * and immutable identity when alias is present.
 *
 * P928 AC-5: Extended with optional opts to show backend hint when showBackend=true.
 * For subscription routes, shows route_provider; for metered routes, shows model_name.
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

/**
 * Format an agent label for display, preferring display_alias over identity.
 * Returns both if alias is present: "Claude-Bot-Architect (ccs45ant-bot-arch-a)"
 *
 * P928 AC-5: When opts.showBackend=true and route is provided:
 * - For subscription routes: returns "${alias} (${route_provider})"
 * - For other plan types: returns "${alias} (${model_name})"
 * - Default behavior unchanged when opts is omitted or showBackend=false
 */
export function formatAgentLabel(
	row: AgentLabelRow,
	opts?: { showBackend?: boolean; route?: BackendRouteHint | null },
): string {
	const base = row.display_alias ? `${row.display_alias} (${row.agent_identity})` : row.agent_identity;

	// P928 AC-5: backend hint rendering
	if (opts?.showBackend && opts.route) {
		const hint = opts.route.plan_type === "subscription"
			? opts.route.route_provider
			: opts.route.model_name;
		return hint ? `${row.display_alias ?? row.agent_identity} (${hint})` : base;
	}

	return base;
}

/**
 * Get just the display name, falling back to identity if no alias.
 * For use in places where space is limited.
 */
export function formatAgentLabelShort(row: AgentLabelRow): string {
	return row.display_alias ?? row.agent_identity;
}

/**
 * P933: Live-feed label with DB-driven host-strip.
 *
 * Rules (mirrors SQL CASE in v_agent_display_label):
 * (a) NULL/absent alias → raw identity, no parens
 * (b) 2-segment alias → "{alias} ({identity})"
 * (c) 3-segment alias, middle matches hostIds (case-insensitive) → "{P1}-{P3} ({identity})"
 * (d) 3-segment alias, middle unknown → "{alias} ({identity})" verbatim
 *
 * `hostIds` is caller-supplied (from DB query); this function does NOT query the DB.
 */
export function formatAgentLabelLive(row: AgentLabelRow, hostIds: string[]): string {
	if (!row.display_alias) return row.agent_identity;

	const parts = row.display_alias.split("-");
	if (parts.length === 3) {
		const middle = parts[1]!.toLowerCase();
		if (hostIds.some((h) => h.toLowerCase() === middle)) {
			return `${parts[0]}-${parts[2]} (${row.agent_identity})`;
		}
	}

	return `${row.display_alias} (${row.agent_identity})`;
}
