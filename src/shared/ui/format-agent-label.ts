/**
 * P933: TS-side agent label formatting for contexts where the SQL CASE isn't available.
 *
 * The canonical rendering logic lives in the SQL `hosts` CTE + CASE in live-feed.ts /
 * state-feed.sh. This helper mirrors that logic for TS post-processing (e.g. message
 * bodies built outside the UNION query, CLI output, test assertions).
 *
 * Host-strip rule: if alias has exactly 3 hyphen-segments and the middle segment
 * matches a known host, strip it → "{Provider}-{Role} ({identity})".
 * The caller supplies `knownHosts` from the DB (roadmap.agency.host_id), NOT a
 * hardcoded list — same naming-as-data principle enforced by P920/P933.
 */

export interface AgentLabelRow {
	display_alias?: string | null;
	agent_identity: string;
}

export interface FormatAgentLabelLiveOpts {
	/** Lower-cased host_id values from roadmap.agency. Pass [] when unknown. */
	knownHosts?: string[];
}

/**
 * Render the compact live-feed label for an agent row.
 *
 * - NULL alias   → raw identity (byte-for-byte backward compat)
 * - 2-segment alias ("Claude-Bot")              → "Claude-Bot ({identity})"
 * - 3-segment alias, middle = known host         → "Claude-Role ({identity})"
 * - 3-segment alias, middle = unknown host       → "Claude-Unknown-Role ({identity})"
 * - N≠3 segments                                → full alias ({identity})
 */
export function formatAgentLabelLive(
	row: AgentLabelRow,
	opts: FormatAgentLabelLiveOpts = {},
): string {
	if (!row.display_alias) {
		return row.agent_identity;
	}

	const parts = row.display_alias.split("-");
	const hosts = opts.knownHosts ?? [];

	let displayName: string;
	if (parts.length === 3 && hosts.includes(parts[1]!.toLowerCase())) {
		displayName = `${parts[0]}-${parts[2]}`;
	} else {
		displayName = row.display_alias;
	}

	return `${displayName} (${row.agent_identity})`;
}

/**
 * Short form — display name only, no identity suffix.
 * For space-constrained contexts (column headers, status chips).
 */
export function formatAgentLabelShort(row: AgentLabelRow, opts: FormatAgentLabelLiveOpts = {}): string {
	if (!row.display_alias) {
		return row.agent_identity;
	}

	const parts = row.display_alias.split("-");
	const hosts = opts.knownHosts ?? [];

	if (parts.length === 3 && hosts.includes(parts[1]!.toLowerCase())) {
		return `${parts[0]}-${parts[2]}`;
	}

	return row.display_alias;
}
