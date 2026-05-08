/**
 * P919: Agent label formatting helper for dashboard and journalctl
 *
 * AC-10: formatAgentLabel(row) returns row.display_alias ?? row.agent_identity
 * Used in UI renderings and structured logs to show both human-readable name
 * and immutable identity when alias is present.
 */

export interface AgentLabelRow {
	display_alias?: string | null;
	agent_identity: string;
}

/**
 * Format an agent label for display, preferring display_alias over identity.
 * Returns both if alias is present: "Claude-Bot-Architect (ccs45ant-bot-arch-a)"
 */
export function formatAgentLabel(row: AgentLabelRow): string {
	if (row.display_alias) {
		return `${row.display_alias} (${row.agent_identity})`;
	}
	return row.agent_identity;
}

/**
 * Get just the display name, falling back to identity if no alias.
 * For use in places where space is limited.
 */
export function formatAgentLabelShort(row: AgentLabelRow): string {
	return row.display_alias ?? row.agent_identity;
}
