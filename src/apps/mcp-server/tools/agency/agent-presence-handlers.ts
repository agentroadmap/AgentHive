/**
 * P1109 Tier-2: MCP tool entrypoints for agent presence + listener-subscription.
 *
 * Thin CallToolResult adapters over the infra-layer single source of truth in
 * src/infra/agency/presence-ops.ts. The infra module is where in-process agency
 * code (liaison-service.ts, liaison-agent.ts) calls the SAME wrappers, so there is
 * one audited copy of the SQL (no app/infra duplication, no layer inversion).
 *
 * agent_subscribe / agent_unsubscribe here are the audit/poll-mode entrypoints:
 * they record the SERVER's pooled backend pid. In-process LISTEN owners must call
 * presence-ops.recordListenerSubscription with their OWN client so the recorded
 * established_pid matches the backend that holds the LISTEN (see the BACKEND-PID
 * FOOTGUN note in presence-ops.ts).
 */

import { query } from "../../../../infra/postgres/pool.js";
import {
	agentPulse,
	recordListenerSubscription,
	removeListenerSubscription,
	type PresenceState,
} from "../../../../infra/agency/presence-ops.js";
import type { CallToolResult } from "../../types.ts";

function poolClient() {
	return { query: (t: string, v?: unknown[]) => query(t, (v ?? []) as unknown[]) };
}

export async function agentPulseHandler(args: {
	agency_id: string;
	state: PresenceState;
}): Promise<CallToolResult> {
	const result = await agentPulse(args?.agency_id, args?.state);
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		isError: !result.success,
	};
}

export async function handleAgentSubscribe(args: {
	agent_identity: string;
	channel: string;
}): Promise<CallToolResult> {
	const result = await recordListenerSubscription(
		poolClient(),
		args?.agent_identity,
		args?.channel,
	);
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		isError: !result.success,
	};
}

export async function handleAgentUnsubscribe(args: {
	agent_identity: string;
	channel: string;
}): Promise<CallToolResult> {
	const result = await removeListenerSubscription(
		poolClient(),
		args?.agent_identity,
		args?.channel,
	);
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		isError: !result.success,
	};
}
