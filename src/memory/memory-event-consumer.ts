/**
 * P194: Memory event consumer - asynchronous, event-sourced memory writes.
 *
 * Consumes the durable proposal outbox plus adjacent audit/feed tables:
 *   1. LISTEN roadmap_events for low-latency roadmap_proposal.proposal_event rows
 *   2. polling fallback for proposal_event, transition, gate, dispatch, liaison,
 *      route, and budget audit rows
 *
 * The cursor lives in roadmap.project_memory so progress survives restarts
 * without marking the shared outbox dispatched_at.
 *
 * Boundaries:
 *   - Never advances proposal maturity or state.
 *   - Writes are replayable and idempotent by source/source_id.
 *   - Does not depend on gate_pipeline.ts or proposal-completion callbacks.
 */

import { Client, type ClientConfig } from "pg";
import { query } from "../infra/postgres/pool.ts";
import { ConfigResolver } from "../shared/runtime/config.ts";

const LISTEN_CHANNEL = "roadmap_events";
const POLL_INTERVAL_MS = 60_000;
const CURSOR_KEY = "_memory_consumer_cursor";
const CURSOR_CATEGORY = "workflow";
const BATCH_SIZE = 100;
const EPISODIC_TTL_SECONDS = 7 * 24 * 3600;
const MAX_TRANSITIONS = 50;
const MAX_ACTIVITIES = 100;
const MAX_DECISIONS = 100;

interface RawNotification {
	event_id: number;
	type: string;
	proposal: number;
}

interface ProposalEventRow {
	id: number;
	proposal_id: number;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: Date;
}

type SourceCursor = number | string;

interface MemoryConsumerCursor {
	last_event_id?: number;
	sources?: Record<string, SourceCursor>;
}

export interface MemoryEvent {
	source: string;
	source_id: SourceCursor;
	proposal_id: number | null;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: Date;
}

export interface MemoryEventClassification {
	bucket:
		| "transition"
		| "agent_episodic"
		| "activity"
		| "route_decision"
		| "budget_decision"
		| "ignore";
	projectKey?: string;
	category?: string;
	agentIdentity?: string;
}

type SourcePoller = {
	name: string;
	poll: (cursor: SourceCursor | undefined) => Promise<MemoryEvent[]>;
	cursorFrom: (event: MemoryEvent) => SourceCursor;
};

type MemoryConsumerGlobal = typeof globalThis & {
	__memoryConsumerPollInterval?: ReturnType<typeof setInterval>;
	__memoryConsumerListenClient?: Client;
};

function consumerGlobal(): MemoryConsumerGlobal {
	return globalThis as MemoryConsumerGlobal;
}

async function readCursor(): Promise<MemoryConsumerCursor> {
	try {
		const { rows } = await query<{ content: MemoryConsumerCursor }>(
			`SELECT content FROM roadmap.project_memory WHERE key = $1`,
			[CURSOR_KEY],
		);
		const content = rows[0]?.content;
		if (!content) return { sources: {} };
		return {
			last_event_id: content.last_event_id ?? 0,
			sources: content.sources ?? {
				proposal_event: content.last_event_id ?? 0,
			},
		};
	} catch {
		return { sources: {} };
	}
}

async function writeCursor(cursor: MemoryConsumerCursor): Promise<void> {
	const sources = cursor.sources ?? {};
	const lastEventId = Number(
		sources.proposal_event ?? cursor.last_event_id ?? 0,
	);
	await query(
		`INSERT INTO roadmap.project_memory (key, category, content)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO UPDATE SET
		   content    = EXCLUDED.content,
		   version    = roadmap.project_memory.version + 1,
		   updated_at = now()`,
		[
			CURSOR_KEY,
			CURSOR_CATEGORY,
			JSON.stringify({ last_event_id: lastEventId, sources }),
		],
	);
}

async function agentExists(identity: string): Promise<boolean> {
	try {
		const { rows } = await query<{ count: string }>(
			`SELECT COUNT(*) AS count
			 FROM roadmap_workforce.agent_registry
			 WHERE agent_identity = $1`,
			[identity],
		);
		return Number(rows[0]?.count ?? 0) > 0;
	} catch {
		return false;
	}
}

async function upsertProjectMemory(
	key: string,
	category: string,
	content: Record<string, unknown>,
): Promise<void> {
	await query(
		`INSERT INTO roadmap.project_memory (key, category, content)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO UPDATE SET
		   content    = EXCLUDED.content,
		   version    = roadmap.project_memory.version + 1,
		   updated_at = now()`,
		[key, category, JSON.stringify(content)],
	);
}

async function upsertAgentEpisodic(
	agentIdentity: string,
	key: string,
	value: Record<string, unknown>,
): Promise<void> {
	if (!(await agentExists(agentIdentity))) return;

	await query(
		`INSERT INTO roadmap_efficiency.agent_memory (agent_identity, layer, key, value, ttl_seconds)
		 VALUES ($1, 'episodic', $2, $3, $4)
		 ON CONFLICT (agent_identity, key, layer)
		 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		[agentIdentity, key, JSON.stringify(value), EPISODIC_TTL_SECONDS],
	);
}

export function classifyMemoryEvent(
	event: MemoryEvent,
): MemoryEventClassification {
	if (
		event.source === "proposal_state_transitions" ||
		event.source === "gate_decision_log" ||
		event.event_type === "status_changed" ||
		event.event_type === "maturity_changed" ||
		event.event_type.startsWith("gate_")
	) {
		return {
			bucket: "transition",
			projectKey: "recent_transitions",
			category: "workflow",
		};
	}

	if (event.source === "dispatch_route_audit") {
		return {
			bucket: "route_decision",
			projectKey: "route_decisions",
			category: "workflow",
		};
	}

	if (
		event.source === "agent_budget_ledger" ||
		event.event_type.includes("budget")
	) {
		return {
			bucket: "budget_decision",
			projectKey: "budget_decisions",
			category: "workflow",
		};
	}

	const agentIdentity = firstString(
		event.payload.agent_identity,
		event.payload.agent,
		event.payload.leaser,
		event.payload.agency_id,
	);

	if (
		agentIdentity &&
		(event.source === "squad_dispatch" ||
			event.source === "agent_runs" ||
			event.source === "liaison_message" ||
			event.event_type === "lease_claimed" ||
			event.event_type === "lease_released" ||
			event.event_type.startsWith("agent_") ||
			event.event_type.startsWith("squad_") ||
			event.event_type.startsWith("liaison_"))
	) {
		return { bucket: "agent_episodic", agentIdentity };
	}

	if (
		event.event_type === "ac_updated" ||
		event.event_type === "review_submitted" ||
		event.event_type === "proposal_created" ||
		event.event_type === "proposal_updated" ||
		event.event_type === "discussion_added" ||
		event.event_type === "operator_action"
	) {
		return {
			bucket: "activity",
			projectKey: "recent_activity",
			category: "workflow",
		};
	}

	return { bucket: "ignore" };
}

export function mergeRecentEvents(
	existing: unknown,
	field: "transitions" | "activities" | "decisions",
	event: Record<string, unknown>,
	limit: number,
): Record<string, unknown[]> {
	const current =
		isRecord(existing) && Array.isArray(existing[field]) ? existing[field] : [];
	const identity = `${event.source}:${event.source_id}`;
	const merged = [
		event,
		...current.filter((item) => {
			if (!isRecord(item)) return true;
			return `${item.source}:${item.source_id}` !== identity;
		}),
	];
	return { [field]: merged.slice(0, limit) };
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDate(value: unknown): Date {
	return value instanceof Date ? value : new Date(String(value));
}

async function readProjectMemory(
	key: string,
): Promise<Record<string, unknown> | null> {
	try {
		const { rows } = await query<{ content: Record<string, unknown> }>(
			`SELECT content FROM roadmap.project_memory WHERE key = $1`,
			[key],
		);
		return rows[0]?.content ?? null;
	} catch {
		return null;
	}
}

async function processEvent(event: MemoryEvent): Promise<void> {
	const classification = classifyMemoryEvent(event);
	if (classification.bucket === "ignore") return;

	const memoryRow = {
		source: event.source,
		source_id: event.source_id,
		proposal_id: event.proposal_id,
		event_type: event.event_type,
		payload: event.payload,
		occurred_at: event.created_at,
	};

	if (
		classification.bucket === "agent_episodic" &&
		classification.agentIdentity
	) {
		const proposalPrefix = event.proposal_id
			? `p${event.proposal_id}`
			: "global";
		const key = `${proposalPrefix}:${event.source}:${event.event_type}:${event.source_id}`;
		await upsertAgentEpisodic(classification.agentIdentity, key, memoryRow);
		return;
	}

	if (!classification.projectKey || !classification.category) return;

	const field =
		classification.bucket === "transition"
			? "transitions"
			: classification.bucket === "activity"
				? "activities"
				: "decisions";
	const limit =
		classification.bucket === "transition"
			? MAX_TRANSITIONS
			: classification.bucket === "activity"
				? MAX_ACTIVITIES
				: MAX_DECISIONS;
	const existing = await readProjectMemory(classification.projectKey);
	const content = mergeRecentEvents(existing, field, memoryRow, limit);

	await upsertProjectMemory(
		classification.projectKey,
		classification.category,
		{
			...content,
			updated_at: new Date().toISOString(),
		},
	);
}

function proposalEventToMemoryEvent(event: ProposalEventRow): MemoryEvent {
	return {
		source: "proposal_event",
		source_id: event.id,
		proposal_id: event.proposal_id,
		event_type: event.event_type,
		payload: event.payload,
		created_at: asDate(event.created_at),
	};
}

async function pollBatch(): Promise<{ processed: number; maxId: number }> {
	const cursor = await readCursor();
	const sources = cursor.sources ?? {};
	const proposalEventCursor = Number(
		sources.proposal_event ?? cursor.last_event_id ?? 0,
	);

	const { rows } = await query<ProposalEventRow>(
		`SELECT id, proposal_id, event_type, payload, created_at
		 FROM roadmap_proposal.proposal_event
		 WHERE id > $1
		 ORDER BY id
		 LIMIT $2`,
		[proposalEventCursor, BATCH_SIZE],
	);

	if (rows.length === 0) return { processed: 0, maxId: proposalEventCursor };

	let maxId = proposalEventCursor;
	for (const event of rows) {
		try {
			await processEvent(proposalEventToMemoryEvent(event));
			maxId = Math.max(maxId, event.id);
		} catch (err) {
			console.error(
				`[MemoryEventConsumer] Failed to process event ${event.id} (${event.event_type}):`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	sources.proposal_event = maxId;
	await writeCursor({ ...cursor, last_event_id: maxId, sources });
	return { processed: rows.length, maxId };
}

async function tableExists(schema: string, table: string): Promise<boolean> {
	const { rows } = await query<{ count: string }>(
		`SELECT COUNT(*) AS count
		 FROM information_schema.tables
		 WHERE table_schema = $1 AND table_name = $2`,
		[schema, table],
	);
	return Number(rows[0]?.count ?? 0) > 0;
}

async function pollOptionalSources(): Promise<number> {
	const pollers = buildOptionalPollers();
	const cursor = await readCursor();
	const sources = cursor.sources ?? {};
	let processed = 0;

	for (const poller of pollers) {
		try {
			const events = await poller.poll(sources[poller.name]);
			for (const event of events) {
				await processEvent(event);
				sources[poller.name] = poller.cursorFrom(event);
				processed++;
			}
		} catch (err) {
			console.error(
				`[MemoryEventConsumer] Optional source ${poller.name} failed:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	if (processed > 0) {
		await writeCursor({ ...cursor, sources });
	}

	return processed;
}

function buildOptionalPollers(): SourcePoller[] {
	return [
		{
			name: "proposal_state_transitions",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (
					!(await tableExists("roadmap_proposal", "proposal_state_transitions"))
				) {
					return [];
				}
				const { rows } = await query<{
					id: number;
					proposal_id: number;
					payload: Record<string, unknown>;
					transitioned_at: Date;
				}>(
					`SELECT id, proposal_id, to_jsonb(t) AS payload, transitioned_at
					 FROM roadmap_proposal.proposal_state_transitions t
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "proposal_state_transitions",
					source_id: row.id,
					proposal_id: row.proposal_id,
					event_type: "proposal_state_transition",
					payload: row.payload,
					created_at: asDate(row.transitioned_at),
				}));
			},
		},
		{
			name: "gate_decision_log",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (!(await tableExists("roadmap_proposal", "gate_decision_log"))) {
					return [];
				}
				const { rows } = await query<{
					id: number;
					proposal_id: number;
					payload: Record<string, unknown>;
					created_at: Date;
				}>(
					`SELECT id, proposal_id, to_jsonb(g) AS payload, created_at
					 FROM roadmap_proposal.gate_decision_log g
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "gate_decision_log",
					source_id: row.id,
					proposal_id: row.proposal_id,
					event_type: "gate_decision",
					payload: row.payload,
					created_at: asDate(row.created_at),
				}));
			},
		},
		{
			name: "squad_dispatch",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (!(await tableExists("roadmap_workforce", "squad_dispatch")))
					return [];
				const { rows } = await query<{
					id: number;
					proposal_id: number;
					payload: Record<string, unknown>;
					assigned_at: Date;
				}>(
					`SELECT id, proposal_id, to_jsonb(sd) AS payload, assigned_at
					 FROM roadmap_workforce.squad_dispatch sd
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "squad_dispatch",
					source_id: row.id,
					proposal_id: row.proposal_id,
					event_type: "dispatch_event",
					payload: row.payload,
					created_at: asDate(row.assigned_at),
				}));
			},
		},
		{
			name: "proposal_discussions",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (!(await tableExists("roadmap_proposal", "proposal_discussions"))) {
					return [];
				}
				const { rows } = await query<{
					id: number;
					proposal_id: number;
					payload: Record<string, unknown>;
					created_at: Date;
				}>(
					`SELECT id, proposal_id, to_jsonb(pd) AS payload, created_at
					 FROM roadmap_proposal.proposal_discussions pd
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "proposal_discussions",
					source_id: row.id,
					proposal_id: row.proposal_id,
					event_type: "discussion_added",
					payload: row.payload,
					created_at: asDate(row.created_at),
				}));
			},
		},
		{
			name: "agent_runs",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (!(await tableExists("roadmap_workforce", "agent_runs"))) return [];
				const { rows } = await query<{
					id: number;
					proposal_id: number | null;
					status: string;
					payload: Record<string, unknown>;
					started_at: Date;
				}>(
					`SELECT id, proposal_id, status, to_jsonb(ar) AS payload, started_at
					 FROM roadmap_workforce.agent_runs ar
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "agent_runs",
					source_id: row.id,
					proposal_id: row.proposal_id,
					event_type: `agent_run_${row.status}`,
					payload: row.payload,
					created_at: asDate(row.started_at),
				}));
			},
		},
		{
			name: "liaison_message",
			cursorFrom: (event) => event.created_at.toISOString(),
			poll: async (cursor) => {
				if (!(await tableExists("roadmap", "liaison_message"))) return [];
				const since =
					typeof cursor === "string" ? cursor : "1970-01-01T00:00:00.000Z";
				const { rows } = await query<{
					message_id: string;
					agency_id: string;
					kind: string;
					payload: Record<string, unknown>;
					created_at: Date;
				}>(
					`SELECT message_id::text, agency_id, kind, to_jsonb(lm) AS payload, created_at
					 FROM roadmap.liaison_message lm
					 WHERE created_at > $1::timestamptz
					 ORDER BY created_at, message_id
					 LIMIT $2`,
					[since, BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "liaison_message",
					source_id: row.message_id,
					proposal_id: Number(row.payload.proposal_id ?? 0) || null,
					event_type: `liaison_${row.kind}`,
					payload: { ...row.payload, agency_id: row.agency_id },
					created_at: asDate(row.created_at),
				}));
			},
		},
		{
			name: "dispatch_route_audit",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (!(await tableExists("roadmap", "dispatch_route_audit"))) return [];
				const { rows } = await query<{
					id: number;
					payload: Record<string, unknown>;
					decided_at: Date;
				}>(
					`SELECT id, to_jsonb(dra) AS payload, decided_at
					 FROM roadmap.dispatch_route_audit dra
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "dispatch_route_audit",
					source_id: row.id,
					proposal_id: null,
					event_type: "route_decision",
					payload: row.payload,
					created_at: asDate(row.decided_at),
				}));
			},
		},
		{
			name: "agent_budget_ledger",
			cursorFrom: (event) => event.source_id,
			poll: async (cursor) => {
				if (!(await tableExists("roadmap_efficiency", "agent_budget_ledger"))) {
					return [];
				}
				const { rows } = await query<{
					id: number;
					proposal_id: number | null;
					payload: Record<string, unknown>;
					recorded_at: Date;
				}>(
					`SELECT id, proposal_id, to_jsonb(abl) AS payload, recorded_at
					 FROM roadmap_efficiency.agent_budget_ledger abl
					 WHERE id > $1
					 ORDER BY id
					 LIMIT $2`,
					[Number(cursor ?? 0), BATCH_SIZE],
				);
				return rows.map((row) => ({
					source: "agent_budget_ledger",
					source_id: row.id,
					proposal_id: row.proposal_id,
					event_type: "budget_decision",
					payload: row.payload,
					created_at: asDate(row.recorded_at),
				}));
			},
		},
	];
}

function buildListenClientConfig(): ClientConfig {
	const host = process.env.PGHOST ?? "127.0.0.1";
	const port = Number(process.env.PGPORT ?? 5432);
	const user = process.env.PGUSER ?? "";
	const database = process.env.PGDATABASE ?? "agenthive";
	const password = ConfigResolver.resolvePasswordSync({
		host,
		port: String(port),
		database,
		user,
	});

	return {
		host,
		port,
		user,
		password: password ?? undefined,
		database,
		options:
			"-c search_path=roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public",
	};
}

async function startListenClient(): Promise<Client | null> {
	try {
		const client = new Client(buildListenClientConfig());
		await client.connect();
		await client.query(`LISTEN ${LISTEN_CHANNEL}`);

		client.on("notification", (msg) => {
			if (!msg.payload) return;
			try {
				const notif: RawNotification = JSON.parse(msg.payload);
				void query<ProposalEventRow>(
					`SELECT id, proposal_id, event_type, payload, created_at
					 FROM roadmap_proposal.proposal_event
					 WHERE id = $1`,
					[notif.event_id],
				)
					.then(async ({ rows }) => {
						if (!rows[0]) return;
						try {
							const cursor = await readCursor();
							const sources = cursor.sources ?? {};
							const current = Number(
								sources.proposal_event ?? cursor.last_event_id ?? 0,
							);
							await processEvent(proposalEventToMemoryEvent(rows[0]));
							const next = Math.max(current, rows[0].id);
							sources.proposal_event = next;
							await writeCursor({ ...cursor, last_event_id: next, sources });
						} catch (err) {
							console.error(
								`[MemoryEventConsumer] Notification handler failed for event ${notif.event_id}:`,
								err instanceof Error ? err.message : String(err),
							);
						}
					})
					.catch((err) => {
						console.error(
							"[MemoryEventConsumer] Notification fetch failed:",
							err instanceof Error ? err.message : String(err),
						);
					});
			} catch (err) {
				console.error(
					"[MemoryEventConsumer] Failed to parse notification:",
					err instanceof Error ? err.message : String(err),
				);
			}
		});

		client.on("error", (err) => {
			console.error("[MemoryEventConsumer] LISTEN client error:", err.message);
		});

		return client;
	} catch (err) {
		console.error(
			"[MemoryEventConsumer] Failed to start LISTEN client (will rely on polling):",
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
}

async function isSchemaReady(): Promise<boolean> {
	try {
		const eventReady = await tableExists("roadmap_proposal", "proposal_event");
		const memReady = await tableExists("roadmap", "project_memory");
		return eventReady && memReady;
	} catch {
		return false;
	}
}

export async function registerMemoryEventConsumer(): Promise<void> {
	const logger = console;
	const globals = consumerGlobal();

	if (globals.__memoryConsumerPollInterval) {
		logger.info(
			"[MemoryEventConsumer] Memory event consumer already registered",
		);
		return;
	}

	if (!(await isSchemaReady())) {
		logger.warn(
			"[MemoryEventConsumer] Schema not ready (proposal_event or project_memory missing) - skipping",
		);
		return;
	}

	try {
		const { processed, maxId } = await pollBatch();
		const optionalProcessed = await pollOptionalSources();
		if (processed > 0 || optionalProcessed > 0) {
			logger.info(
				`[MemoryEventConsumer] Drained ${processed} proposal events and ${optionalProcessed} audit/feed events (proposal cursor now ${maxId})`,
			);
		}
	} catch (err) {
		logger.error(
			"[MemoryEventConsumer] Backlog drain failed:",
			err instanceof Error ? err.message : String(err),
		);
	}

	const listenClient = await startListenClient();
	if (listenClient) {
		logger.info(
			`[MemoryEventConsumer] Listening on channel '${LISTEN_CHANNEL}'`,
		);
		globals.__memoryConsumerListenClient = listenClient;
	}

	const intervalId = setInterval(() => {
		void pollBatch().catch((err) => {
			logger.error(
				"[MemoryEventConsumer] Proposal event poll failed:",
				err instanceof Error ? err.message : String(err),
			);
		});
		void pollOptionalSources().catch((err) => {
			logger.error(
				"[MemoryEventConsumer] Audit/feed poll failed:",
				err instanceof Error ? err.message : String(err),
			);
		});
	}, POLL_INTERVAL_MS);

	globals.__memoryConsumerPollInterval = intervalId;
	logger.info(
		"[MemoryEventConsumer] Memory event consumer registered (poll interval: 60s)",
	);
}

export async function stopMemoryEventConsumer(): Promise<void> {
	const globals = consumerGlobal();
	const interval = globals.__memoryConsumerPollInterval;
	if (interval) {
		clearInterval(interval);
		delete globals.__memoryConsumerPollInterval;
	}

	const client = globals.__memoryConsumerListenClient;
	if (client) {
		try {
			await client.query(`UNLISTEN ${LISTEN_CHANNEL}`);
			await client.end();
		} catch {
			// Best-effort cleanup.
		}
		delete globals.__memoryConsumerListenClient;
	}
}
