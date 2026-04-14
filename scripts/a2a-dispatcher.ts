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
 *   - Worktree agents (claude/*, gemini/*, etc.) → spawned via agent-spawner
 *   - Virtual agents (gate-agent, skeptic-*, etc.) → queued to transition_queue
 *   - Broadcast/system → logged and queued for next orchestrator cycle
 */

import { getPool, query } from "../src/infra/postgres/pool.ts";
import { spawnAgent } from "../src/core/orchestration/agent-spawner.ts";

const POLL_INTERVAL_MS = 10_000; // fallback poll every 10s
const DISPATCH_BATCH = 20;       // max messages per cycle

const logger = {
	log: (...args: unknown[]) => console.log("[A2A]", new Date().toISOString(), ...args),
	warn: (...args: unknown[]) => console.warn("[A2A]", new Date().toISOString(), ...args),
	error: (...args: unknown[]) => console.error("[A2A]", new Date().toISOString(), ...args),
};

// ─── Trust gate ────────────────────────────────────────────────────────────────

type TrustLevel = "authority" | "trusted" | "known" | "restricted" | "blocked";

/** Lookup trust level for (recipient, sender). Default: 'known' (open). */
async function getTrustLevel(
	recipient: string,
	sender: string,
): Promise<TrustLevel> {
	if (sender === "system") return "authority"; // system always authority
	if (recipient === sender) return "trusted";  // self-messages always pass

	try {
		const { rows } = await query<{ trust_level: string }>(
			`SELECT trust_level FROM roadmap_workforce.agent_trust
			 WHERE agent_identity = $1 AND trusted_agent = $2
			   AND (expires_at IS NULL OR expires_at > now())
			 LIMIT 1`,
			[recipient, sender],
		);
		if (rows.length > 0) return rows[0].trust_level as TrustLevel;
	} catch {
		// If trust table not accessible, default open
	}

	return "known"; // default: accept unknown senders
}

/** Returns true if the message should be delivered. */
async function trustGate(
	recipient: string,
	sender: string,
	messageType: string,
): Promise<boolean> {
	const level = await getTrustLevel(recipient, sender);
	if (level === "blocked") {
		logger.log(`[trust] BLOCKED: ${sender} → ${recipient}`);
		return false;
	}
	if (level === "restricted") {
		// Restricted: only accept task/command from authority senders
		const authoritative = ["system", "claude/one", "claude/andy", "gary"];
		if (!authoritative.includes(sender) && !["task", "command", "gate"].includes(messageType)) {
			logger.log(`[trust] RESTRICTED: ${sender} → ${recipient} (${messageType})`);
			return false;
		}
	}
	return true;
}

// ─── Recipient resolution ─────────────────────────────────────────────────────

const WORKTREE_ROOT = "/data/code/worktree";

/** Known worktrees (provider prefix recognized by agent-spawner). */
const KNOWN_PROVIDERS = new Set(["claude", "gemini", "copilot", "openclaw"]);

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
	// Single-name agents like "xiaomi" → "xiaomi-one"
	const single: Record<string, string> = {
		xiaomi: "xiaomi-one",
		hermes: "hermes-andy",
		"hermes-agent": "hermes-andy",
	};
	return single[identity] ?? null;
}

/** Returns true if the worktree directory and .env.agent both exist. */
import { existsSync } from "node:fs";
function worktreeExists(worktree: string): boolean {
	return (
		existsSync(`${WORKTREE_ROOT}/${worktree}`) &&
		existsSync(`${WORKTREE_ROOT}/${worktree}/.env.agent`)
	);
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

	const worktree = identityToWorktree(recipient);

	if (worktree && worktreeExists(worktree)) {
		// Worktree agent — spawn with message as task
		const task = `[A2A MESSAGE from ${msg.from_agent}]
Type: ${msg.message_type}
${msg.proposal_id ? `Proposal: P${String(msg.proposal_id).padStart(3, "0")}` : ""}
---
${msg.message_content}

Read the message above and take appropriate action based on your role. If it is a task or command, execute it. If informational, acknowledge and update your state.`;

		try {
			const result = await spawnAgent({
				worktree,
				task,
				proposalId: msg.proposal_id ?? undefined,
				stage: "a2a-dispatch",
				timeoutMs: 120_000,
			});
			logger.log(
				`[deliver] ${msg.from_agent} → ${recipient} (worktree: ${worktree}) exit=${result.exitCode}`,
			);
		} catch (err) {
			logger.error(`[deliver] spawn failed for ${recipient}:`, err);
		}
	} else {
		// Virtual agent — queue to transition_queue for next orchestrator cycle
		if (msg.proposal_id) {
			try {
				await query(
					`INSERT INTO roadmap.transition_queue
					 (proposal_id, from_stage, to_stage, triggered_by, metadata)
					 VALUES ($1, 'pending', 'pending', $2, $3::jsonb)
					 ON CONFLICT DO NOTHING`,
					[
						msg.proposal_id,
						`a2a-dispatch:${recipient}`,
						JSON.stringify({
							a2a_from: msg.from_agent,
							a2a_message: msg.message_content.slice(0, 400),
							a2a_type: msg.message_type,
						}),
					],
				);
				logger.log(`[deliver] queued for virtual agent ${recipient} (proposal_id=${msg.proposal_id})`);
			} catch (err) {
				logger.error(`[deliver] queue insert failed for ${recipient}:`, err);
			}
		} else {
			// No proposal_id — just log the delivery intent
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
			logger.error(`Failed to process message ${msg.id}:`, err);
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
		logger.log(`[notify] new message: ${msg.payload?.slice(0, 120)}`);
		// Give the INSERT a moment to fully commit before we fetch
		await new Promise((res) => setTimeout(res, 200));
		await dispatchPendingMessages();
	});

	client.on("error", (err) => {
		logger.error("pg LISTEN connection error:", err.message);
		// Reconnect after 5s
		setTimeout(() => startPgListener().catch(logger.error), 5000);
	});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	logger.log("A2A Message Dispatcher starting...");

	// Drain any messages that arrived before this process started
	const backlog = await dispatchPendingMessages();
	logger.log(`Backlog dispatched: ${backlog} messages`);

	// Start real-time pg_notify listener
	await startPgListener();

	// Fallback poll loop (catches missed notifications)
	setInterval(() => {
		dispatchPendingMessages().catch(logger.error);
	}, POLL_INTERVAL_MS);

	logger.log("A2A Dispatcher running.");
}

// Graceful shutdown
process.on("SIGINT", () => {
	logger.log("Shutting down A2A dispatcher...");
	process.exit(0);
});
process.on("SIGTERM", () => {
	logger.log("Shutting down A2A dispatcher...");
	process.exit(0);
});

main().catch((err) => {
	logger.error("Fatal error:", err);
	process.exit(1);
});
