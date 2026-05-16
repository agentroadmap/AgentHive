/**
 * AgentHive — A2A Message Dispatcher
 *
 * Long-running service that listens for new messages via pg_notify and routes
 * them to registered agents using a trust-model gate.
 *
 * Trust model:
 *   1. Check `agent_trust` for (recipient, sender) row — use that trust_level
 *   2. If no row exists → default_open (accept)
 *   3. 'blocked' → silently discard
 *   4. 'restricted' → accept only task/command message_types from authority agents
 *   5. 'known' | 'trusted' | 'authority' → accept all
 *
 * Delivery:
 *   - Worktree agents (claude/*, gemini/*, etc.) → pg_notify to agent:<identity> channel
 *   - Virtual agents (gate-agent, skeptic-*, etc.) → logged; the unified
 *     orchestrator scanQueues() loop now owns their dispatch (P753).
 *   - Broadcast/system → logged and queued for next orchestrator cycle
 */

import { getPool, query } from "../src/infra/postgres/pool.ts";
import { trustGate } from "../src/infra/messaging/a2a-trust-gate.ts";
import { registerSigReconciler } from "../src/infra/messaging/sig-reconciler.ts";

const POLL_INTERVAL_MS = 10_000; // fallback poll every 10s
const DISPATCH_BATCH = 20;       // max messages per cycle

const logger = {
	log: (...args: unknown[]) => console.log("[A2A]", new Date().toISOString(), ...args),
	warn: (...args: unknown[]) => console.warn("[A2A]", new Date().toISOString(), ...args),
	error: (...args: unknown[]) => console.error("[A2A]", new Date().toISOString(), ...args),
};

// Trust gate is sourced from src/infra/messaging/a2a-trust-gate.ts so it can be
// unit-tested without booting this dispatcher script. Logging on
// blocked/restricted decisions has been removed during the extraction; reintroduce
// a logging wrapper here if telemetry is needed.

// ─── Recipient resolution ─────────────────────────────────────────────────────

const WORKTREE_ROOT = "/data/code/worktree";

/** Known worktrees (provider prefix recognized by agent-spawner). */
const KNOWN_PROVIDERS = new Set(["claude", "gemini", "copilot", "openclaw", "codex"]);

const TERMINAL_TRANSITION_STATUSES = new Set(["done", "failed", "cancelled"]);
const ACTIONABLE_VIRTUAL_MESSAGE_TYPES = new Set(["task", "command", "gate"]);

/** Map agent_identity to worktree name, or null if no valid worktree. */
function identityToWorktree(identity: string): string | null {
	// Patterns: "claude/one" → "claude-one", "claude/andy" → "claude-andy"
	const slash = identity.indexOf("/");
	if (slash !== -1) {
		const provider = identity.slice(0, slash);
		const name = identity.slice(slash + 1);
		if (!KNOWN_PROVIDERS.has(provider)) return null;
		return `${provider}-${name}`;
	}
	// Single-word identities with no slash are not resolvable to a worktree
	// without a DB lookup — callers should use the canonical "provider/name" form.
	return null;
}

/** Returns true if the worktree directory and .env.agent both exist. */
import { existsSync } from "node:fs";
function worktreeExists(worktree: string): boolean {
	return (
		existsSync(`${WORKTREE_ROOT}/${worktree}`) &&
		existsSync(`${WORKTREE_ROOT}/${worktree}/.env.agent`)
	);
}

function parseLegacyTransitionTask(content: string): number | null {
	const match = content.match(/Transition queue row:\s*(\d+)/i);
	if (!match) return null;
	const queueId = Number(match[1]);
	return Number.isInteger(queueId) && queueId > 0 ? queueId : null;
}

async function shouldSkipLegacyTransitionTask(
	msg: PendingMessage,
	recipient: string,
): Promise<boolean> {
	if (msg.message_type !== "task") return false;
	const queueId = parseLegacyTransitionTask(msg.message_content);
	if (!queueId) return false;

	// P753: transition_queue retired; any message referencing a legacy queue ID
	// is by definition stale. Drop it without a SQL lookup.
	logger.log(
		`[msg:${msg.id}] dropped legacy transition task for ${recipient}; queue ${queueId} no longer exists (P753)`,
	);
	return true;
}

/** Get all agent subscribers for a channel. */
async function getChannelSubscribers(channel: string): Promise<string[]> {
	try {
		const { rows } = await query<{ agent_identity: string }>(
			`SELECT DISTINCT cs.agent_identity
			 FROM roadmap.channel_subscription cs
			 JOIN roadmap_workforce.agent_registry ar ON ar.agent_identity = cs.agent_identity
			 WHERE cs.channel = $1 AND ar.status = 'active'`,
			[channel],
		);
		return rows.map((r) => r.agent_identity);
	} catch (err) {
		logger.error("Failed to get channel subscribers:", err);
		return [];
	}
}

// ─── Message delivery ─────────────────────────────────────────────────────────

interface PendingMessage {
	id: number;
	from_agent: string;
	to_agent: string | null;
	channel: string | null;
	message_content: string;
	message_type: string;
	proposal_id: number | null;
	created_at: string;
}

/** Deliver a message to a single agent. */
async function deliverToAgent(
	msg: PendingMessage,
	recipient: string,
): Promise<void> {
	const allowed = await trustGate(recipient, msg.from_agent, msg.message_type);
	if (!allowed) return;

	if (await shouldSkipLegacyTransitionTask(msg, recipient)) {
		return;
	}

	const worktree = identityToWorktree(recipient);

	if (worktree && worktreeExists(worktree)) {
		// Worktree agent — notify via pg_notify; agent reads its inbox via msg_read MCP
		try {
			await query(`SELECT pg_notify($1, $2)`, [
				`agent:${recipient}`,
				JSON.stringify({
					type: "new_message",
					message_id: msg.id,
					from: msg.from_agent,
					message_type: msg.message_type,
					...(msg.proposal_id ? { proposal_id: msg.proposal_id } : {}),
				}),
			]);
			logger.log(
				`[deliver] ${msg.from_agent} → ${recipient} (worktree: ${worktree}) — notified via pg_notify`,
			);
		} catch (err) {
			logger.error(`[deliver] pg_notify failed for ${recipient}:`, err);
		}
	} else {
		// Virtual agent (gate-agent, skeptic-*, etc.) — P753 retired the
		// transition_queue write path that used to enqueue these. The unified
		// orchestrator scanQueues() loop now picks up virtual-agent work from
		// proposal maturity/state directly, so we log-and-drop here.
		if (!ACTIONABLE_VIRTUAL_MESSAGE_TYPES.has(msg.message_type)) {
			logger.log(
				`[deliver] virtual agent ${recipient} — ${msg.message_type} message logged only`,
			);
			return;
		}

		if (msg.proposal_id) {
			logger.log(
				`[deliver] virtual agent ${recipient} (proposal_id=${msg.proposal_id}) — message logged; orchestrator owns dispatch (P753)`,
			);
		} else {
			logger.log(`[deliver] virtual agent ${recipient} — no proposal_id, message logged only`);
		}
	}
}

/** Process a single message: resolve recipients, gate by trust, deliver. */
async function processMessage(msg: PendingMessage): Promise<void> {
	const recipients: string[] = [];

	// Direct message
	if (msg.to_agent) {
		recipients.push(msg.to_agent);
	}

	// Channel broadcast — add all subscribers (excluding sender)
	if (msg.channel && msg.channel !== "direct") {
		const subscribers = await getChannelSubscribers(msg.channel);
		for (const sub of subscribers) {
			if (sub !== msg.from_agent && !recipients.includes(sub)) {
				recipients.push(sub);
			}
		}
	}

	if (recipients.length === 0) {
		logger.log(`[msg:${msg.id}] no recipients for channel=${msg.channel} to_agent=${msg.to_agent}`);
	}

	for (const recipient of recipients) {
		await deliverToAgent(msg, recipient);
	}

	// Mark the message as read (consumed by dispatcher)
	await query(
		`UPDATE roadmap.message_ledger SET read_at = now() WHERE id = $1 AND read_at IS NULL`,
		[msg.id],
	);
}

// ─── Fetch + dispatch loop ────────────────────────────────────────────────────

/** Fetch and process unread messages. Returns count processed. */
async function dispatchPendingMessages(): Promise<number> {
	let rows: PendingMessage[];
	try {
		const result = await query<PendingMessage>(
			`SELECT id, from_agent, to_agent, channel, message_content, message_type,
			        proposal_id, created_at
			 FROM roadmap.message_ledger
			 WHERE read_at IS NULL
			 ORDER BY created_at ASC
			 LIMIT $1`,
			[DISPATCH_BATCH],
		);
		rows = result.rows;
	} catch (err) {
		logger.error("Failed to fetch pending messages:", err);
		return 0;
	}

	if (rows.length === 0) return 0;
	logger.log(`Dispatching ${rows.length} pending messages...`);

	for (const msg of rows) {
		try {
			await processMessage(msg);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			logger.error(`Failed to process message ${msg.id}:`, err);
			// F4 (P1106): Route unrecoverable delivery failures to roadmap.dead_letter_queue
			try {
				await query(
					`INSERT INTO roadmap.dead_letter_queue
					 (original_message_id, from_agent, to_agent, channel, payload, failure_reason, retry_budget_used)
					 VALUES ($1, $2, $3, $4, $5, $6, 0)`,
					[msg.id, msg.from_agent, msg.to_agent, msg.channel, msg.message_content, reason.slice(0, 500)],
				);
				logger.log(`[msg:${msg.id}] routed to dead_letter_queue (reason: ${reason.slice(0, 80)})`);
			} catch (dlqErr) {
				logger.error(
					`[msg:${msg.id}] Failed to write DLQ entry:`,
					dlqErr instanceof Error ? dlqErr.message : dlqErr,
				);
			}
		}
	}
	return rows.length;
}

// ─── pg_notify listener ───────────────────────────────────────────────────────

async function startPgListener(): Promise<void> {
	const pool = getPool();
	const client = await pool.connect();

	await client.query("LISTEN new_message");
	logger.log("LISTEN new_message — waiting for pg_notify events");

	client.on("notification", async (msg) => {
		if (msg.channel !== "new_message") return;
		if (stopping) return;
		logger.log(`[notify] new message: ${msg.payload?.slice(0, 120)}`);
		// Give the INSERT a moment to fully commit before we fetch
		await new Promise((res) => setTimeout(res, 200));
		await trackedDispatch();
	});

	client.on("error", (err) => {
		logger.error("pg LISTEN connection error:", err.message);
		// Reconnect after 5s
		setTimeout(() => startPgListener().catch(logger.error), 5000);
	});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// P267: graceful-shutdown bookkeeping. New iterations are refused once
// `stopping` is true; the current iteration is awaited before exit.
let stopping = false;
let currentDispatch: Promise<number> | null = null;
let pollTimer: NodeJS.Timeout | null = null;
const SHUTDOWN_DRAIN_MS = Number(
	process.env.AGENTHIVE_A2A_DRAIN_MS ?? 90_000,
);

function trackedDispatch(): Promise<number> {
	if (stopping) return Promise.resolve(0);
	const p = dispatchPendingMessages();
	currentDispatch = p;
	p.finally(() => {
		if (currentDispatch === p) currentDispatch = null;
	}).catch(() => {});
	return p;
}

async function main() {
	logger.log("A2A Message Dispatcher starting...");

	// F2 (P1106): Register background signature reconciler
	await registerSigReconciler(getPool());

	// Drain any messages that arrived before this process started
	const backlog = await dispatchPendingMessages();
	logger.log(`Backlog dispatched: ${backlog} messages`);

	// Start real-time pg_notify listener
	await startPgListener();

	// Fallback poll loop (catches missed notifications)
	pollTimer = setInterval(() => {
		if (stopping) return;
		trackedDispatch().catch(logger.error);
	}, POLL_INTERVAL_MS);

	logger.log("A2A Dispatcher running.");
}

// P267: graceful shutdown — drain current iteration + close pool before exit.
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	logger.log(
		`${signal} received, draining (current=${currentDispatch ? "1" : "0"}, timeout ${SHUTDOWN_DRAIN_MS}ms)...`,
	);

	if (pollTimer) clearInterval(pollTimer);

	if (currentDispatch) {
		const drainStart = Date.now();
		const winner = await Promise.race([
			currentDispatch.then(() => "drained" as const).catch(() => "drained" as const),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), SHUTDOWN_DRAIN_MS),
			),
		]);
		logger.log(`Drain ${winner} after ${Date.now() - drainStart}ms`);
	}

	try {
		await getPool().end();
	} catch (e) {
		logger.error(`pool.end: ${e instanceof Error ? e.message : e}`);
	}
	process.exit(0);
}

process.on("SIGINT", () => {
	shutdown("SIGINT").catch((e) => {
		logger.error("Shutdown failed:", e);
		process.exit(1);
	});
});
process.on("SIGTERM", () => {
	shutdown("SIGTERM").catch((e) => {
		logger.error("Shutdown failed:", e);
		process.exit(1);
	});
});

main().catch((err) => {
	logger.error("Fatal error:", err);
	process.exit(1);
});
