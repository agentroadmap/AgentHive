/**
 * P1109 Tier-2 (infra layer): the single audited wrapper around the presence and
 * listener-subscription DB operations that agency processes used to issue as raw
 * SQL.
 *
 * Lives in infra/ (not the MCP tool layer) so in-process agency code
 * (liaison-service.ts, liaison-agent.ts) can call it WITHOUT importing app-layer
 * code — avoiding a layer inversion / import cycle. The MCP handlers in
 * apps/mcp-server/tools/agency/agent-presence-handlers.ts delegate here.
 *
 * BACKEND-PID FOOTGUN: roadmap.fn_listener_reconcile_drift() keys on
 * listener_subscription.established_pid vs pg_stat_activity. recordListenerSubscription
 * runs its INSERT on the SAME pg client that holds the LISTEN (passed in), so the
 * recorded pid is the LISTEN backend — not a throwaway pooled connection.
 *
 * SCHEMA NOTE: AC-4 prose names {agency_id, backend_pid, last_seen_at} but the
 * shipped roadmap.listener_subscription table (P1106) uses
 * {agent_identity, established_pid, established_at}. We bind to the real schema.
 */

import { query } from "../postgres/pool.ts";

export type PresenceState = "online" | "busy" | "away" | "offline";

const VALID_STATES: ReadonlySet<string> = new Set([
	"online",
	"busy",
	"away",
	"offline",
]);

export interface AgentPulseResult {
	success: boolean;
	agency_id: string;
	presence_state: string;
	last_heartbeat_at?: string;
	error?: string;
}

/** Minimal pg client surface satisfied by both pg.Client and the pooled wrapper. */
export interface PgQueryable {
	query: (
		text: string,
		values?: unknown[],
	) => Promise<{
		rows: Array<Record<string, unknown>>;
		rowCount?: number | null;
	}>;
}

/**
 * AC-3 / AC-10 / AC-11: presence heartbeat wrapper around roadmap.fn_pulse.
 * fn_pulse atomically sets roadmap.agency.last_heartbeat_at = now() and
 * presence_state, then bridges provider_registry recovery. Reads the row back so
 * callers don't need their own SELECT.
 */
export async function agentPulse(
	agency_id: string | undefined,
	state: PresenceState | string | undefined,
): Promise<AgentPulseResult> {
	const id = agency_id?.trim();
	if (!id) {
		return {
			success: false,
			agency_id: agency_id ?? "",
			presence_state: "",
			error: "agency_id is required",
		};
	}
	if (!state || !VALID_STATES.has(state)) {
		return {
			success: false,
			agency_id: id,
			presence_state: "",
			error: `state must be one of online|busy|away|offline (got ${JSON.stringify(state)})`,
		};
	}
	try {
		await query("SELECT roadmap.fn_pulse($1, $2)", [id, state]);
		const after = await query(
			`SELECT presence_state, last_heartbeat_at
			   FROM roadmap.agency
			  WHERE agency_id = $1`,
			[id],
		);
		if (after.rows.length === 0) {
			return {
				success: false,
				agency_id: id,
				presence_state: "",
				error: `agency ${id} not found`,
			};
		}
		const row = after.rows[0] as {
			presence_state: string;
			last_heartbeat_at: string | null;
		};
		return {
			success: true,
			agency_id: id,
			presence_state: row.presence_state,
			last_heartbeat_at:
				row.last_heartbeat_at != null
					? new Date(row.last_heartbeat_at as unknown as string).toISOString()
					: undefined,
		};
	} catch (err) {
		return {
			success: false,
			agency_id: id,
			presence_state: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export interface ListenerSubscriptionResult {
	success: boolean;
	agent_identity: string;
	channel: string;
	established_pid?: number;
	error?: string;
}

/**
 * AC-4 / AC-6: record (idempotent on (agent_identity, channel)) a listener row,
 * capturing the pid of the `client` that holds the LISTEN.
 */
export async function recordListenerSubscription(
	client: PgQueryable,
	agent_identity: string | undefined,
	channel: string | undefined,
): Promise<ListenerSubscriptionResult> {
	const id = agent_identity?.trim();
	const ch = channel?.trim();
	if (!id || !ch) {
		return {
			success: false,
			agent_identity: agent_identity ?? "",
			channel: channel ?? "",
			error: "agent_identity and channel are required",
		};
	}
	try {
		const res = await client.query(
			`INSERT INTO roadmap.listener_subscription
			     (agent_identity, channel, established_at, established_pid)
			 VALUES ($1, $2, now(), pg_backend_pid())
			 ON CONFLICT (agent_identity, channel)
			 DO UPDATE SET established_at = now(),
			               established_pid = pg_backend_pid()
			 RETURNING established_pid`,
			[id, ch],
		);
		return {
			success: true,
			agent_identity: id,
			channel: ch,
			established_pid: res.rows[0]?.established_pid as number | undefined,
		};
	} catch (err) {
		return {
			success: false,
			agent_identity: id,
			channel: ch,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * AC-5: remove the listener row on clean shutdown. Keyed on (agent_identity,
 * channel) so any connection can perform the delete.
 */
export async function removeListenerSubscription(
	client: PgQueryable,
	agent_identity: string | undefined,
	channel: string | undefined,
): Promise<ListenerSubscriptionResult> {
	const id = agent_identity?.trim();
	const ch = channel?.trim();
	if (!id || !ch) {
		return {
			success: false,
			agent_identity: agent_identity ?? "",
			channel: channel ?? "",
			error: "agent_identity and channel are required",
		};
	}
	try {
		await client.query(
			`DELETE FROM roadmap.listener_subscription
			  WHERE agent_identity = $1 AND channel = $2`,
			[id, ch],
		);
		return { success: true, agent_identity: id, channel: ch };
	} catch (err) {
		return {
			success: false,
			agent_identity: id,
			channel: ch,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * AC-14: tool-layer wrapper for the agent_registry FK-anchor row that
 * liaison-agent.ts used to INSERT with raw SQL at startup.
 */
export async function ensureAgentRegistryRow(
	agent_identity: string | undefined,
	opts?: { agent_type?: string; trust_tier?: string; status?: string },
): Promise<{ success: boolean; agent_identity: string; error?: string }> {
	const id = agent_identity?.trim();
	if (!id) {
		return {
			success: false,
			agent_identity: agent_identity ?? "",
			error: "agent_identity is required",
		};
	}
	try {
		await query(
			`INSERT INTO roadmap_workforce.agent_registry
			     (agent_identity, agent_type, trust_tier, status)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (agent_identity) DO UPDATE SET status = $4`,
			[
				id,
				opts?.agent_type ?? "agency",
				opts?.trust_tier ?? "authority",
				opts?.status ?? "active",
			],
		);
		return { success: true, agent_identity: id };
	} catch (err) {
		return {
			success: false,
			agent_identity: id,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
