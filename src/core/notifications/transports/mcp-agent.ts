/**
 * mcp_agent transport — escalates to a specific agent identity via the
 * existing message ledger. The agent picks the message up through normal
 * inbox channels.
 *
 * `route.target` MUST be a non-empty agent identity (e.g. "ops/oncall",
 * "claude/agency-bot"). The transport writes a row to `roadmap.message_ledger`
 * with `to_agent = target` and a structured envelope in message_content.
 *
 * This keeps the transport scoped to in-system delivery; outbound MCP calls
 * to remote agents (if needed later) get a separate adapter so the auth
 * surface is explicit.
 */

import { query as pgQuery } from "../../../infra/postgres/pool.ts";
import type {
	DispatchArgs,
	NotificationTransport,
} from "../types.ts";
import { TransportError } from "../types.ts";

type QueryFn = typeof pgQuery;
let query: QueryFn = pgQuery;

export function _setNotificationMcpAgentQueryForTest(fn: QueryFn): void {
	query = fn;
}

export const mcpAgentTransport: NotificationTransport = {
	name: "mcp_agent",
	async send({ envelope, route }: DispatchArgs): Promise<void> {
		const target = route.target?.trim();
		if (!target) {
			throw new TransportError(
				"mcp_agent",
				"missing target",
				"mcp_agent: route.target must be a non-empty agent identity",
			);
		}

		const content = [
			`[${envelope.severity}] ${envelope.kind}`,
			envelope.title,
			"",
			envelope.body,
			"",
			"---",
			`payload: ${JSON.stringify(envelope.payload)}`,
		].join("\n");

		try {
			await query(
				`INSERT INTO roadmap.message_ledger
				 (from_agent, to_agent, channel, proposal_id, message_content, message_type)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					"notification-router",
					target,
					"escalation",
					envelope.proposalId,
					content,
					"alert",
				],
			);
		} catch (err) {
			throw new TransportError("mcp_agent", err);
		}
	},
};
