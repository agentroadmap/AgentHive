/**
 * Claude Code Agency — LLM-backed A2A liaison for Claude Code sessions.
 *
 * This is the proper agency registration for Claude Code:
 *   1. Registers in agent_registry (FK anchor for messaging)
 *   2. Calls liaisonRegister() → creates roadmap.agency row + session
 *   3. Heartbeats every 30s (liaisonHeartbeat + pulseHeartbeat)
 *   4. pg LISTENs on a2a_msg_{identity} for incoming A2A messages
 *   5. Passes each message to `claude --print` for LLM response
 *   6. Replies through PgMessagingHandlers (trust gate + contract + pg_notify)
 *
 * Usage:
 *   AGENTHIVE_AGENT_IDENTITY=claude/claude-code \
 *   node --import jiti/register scripts/start-claude-code-agency.ts
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { getPool, closePool, query } from "../src/infra/postgres/pool.ts";
import { PgMessagingHandlers } from "../src/apps/mcp-server/tools/messages/pg-handlers.ts";
import {
	liaisonRegister,
	liaisonHeartbeat,
	endLiaisonSession,
} from "../src/infra/agency/liaison-service.ts";
import { pulseHeartbeat } from "../src/infra/pulse/heartbeat.ts";

const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? "claude/claude-code";
const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const hostId = process.env.AGENTHIVE_HOST ?? "bot";
const pgChannel = `a2a_msg_${agentIdentity}`;

const messaging = new PgMessagingHandlers(null as any, process.cwd());

interface NotifyPayload {
	message_id: number;
	correlation_id?: string;
	from_agent?: string;
}

async function ensureRegistered() {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, trust_tier, status)
		 VALUES ($1, 'agency', 'authority', 'active')
		 ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
		[agentIdentity],
	);
}

async function fetchMessage(messageId: number) {
	const pool = getPool();
	const { rows } = await pool.query(
		`SELECT id, from_agent, to_agent, message_content, message_type,
		        correlation_id, read_at
		 FROM roadmap.message_ledger
		 WHERE id = $1`,
		[messageId],
	);
	return rows[0] ?? null;
}

function runLlm(systemContext: string, userPrompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const fullPrompt = `${systemContext}\n\n---\nIncoming message:\n${userPrompt}`;
		const child = spawn(claudeBin, ["--print", fullPrompt], {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
		child.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
		});
		child.on("error", reject);
	});
}

async function handleIncoming(payload: NotifyPayload) {
	const msg = await fetchMessage(payload.message_id);
	if (!msg) {
		console.warn(`[ClaudeCodeAgency] Message ${payload.message_id} not found`);
		return;
	}
	if (msg.from_agent === agentIdentity) return;
	if (msg.read_at) return;

	console.log(
		`[ClaudeCodeAgency] RECV [${msg.message_type}] id=${msg.id}` +
		` from=${msg.from_agent} corr=${msg.correlation_id ?? "none"}`,
	);

	// P856: protocol_ping fast-path. Reply 'protocol_pong' synchronously with
	// reply_to + correlation_id matched so the orchestrator's liveness probe
	// can correlate. Skip LLM invocation entirely — this must be cheap.
	if (msg.message_type === "protocol_ping") {
		try {
			const pool = getPool();
			const { rows } = await pool.query(
				`INSERT INTO roadmap.message_ledger
                    (from_agent, to_agent, message_type, message_content,
                     correlation_id, reply_to)
                 VALUES ($1, $2, 'protocol_pong', 'pong', $3, $4)
                 RETURNING id`,
				[agentIdentity, msg.from_agent, msg.correlation_id ?? null, msg.id],
			);
			console.log(
				`[ClaudeCodeAgency] PONG → ${msg.from_agent} (reply_to=${msg.id}, pong_id=${rows[0]?.id})`,
			);
			await messaging.markRead({ message_id: msg.id, agent: agentIdentity });
		} catch (err) {
			console.warn("[ClaudeCodeAgency] protocol_pong INSERT failed:", err);
		}
		return;
	}

	console.log(`[ClaudeCodeAgency]      "${msg.message_content}"`);

	const systemContext =
		`You are ${agentIdentity}, the Claude Code liaison agent in the AgentHive system. ` +
		`You are an AI-native development platform agent capable of writing code, reviewing proposals, ` +
		`collaborating with other agents, and coordinating work. ` +
		`You received a ${msg.message_type} message from ${msg.from_agent}. ` +
		`Reply concisely and helpfully. If it's a task, acknowledge and outline your approach in 2-3 sentences.`;

	let replyContent: string;
	try {
		console.log(`[ClaudeCodeAgency] Invoking LLM (${claudeBin} --print)...`);
		replyContent = await runLlm(systemContext, msg.message_content);
		console.log(`[ClaudeCodeAgency] LLM replied: "${replyContent.slice(0, 120)}..."`);
	} catch (err) {
		console.error("[ClaudeCodeAgency] LLM failed:", err);
		replyContent = `[${agentIdentity}] Unable to process message ${msg.id} — LLM call failed.`;
	}

	const result = await messaging.sendMessage({
		from_agent: agentIdentity,
		to_agent: msg.from_agent,
		message_content: replyContent,
		message_type: "text",
	});

	const resultText =
		result.content[0]?.type === "text" ? result.content[0].text : "";

	if (resultText.startsWith("Message sent")) {
		console.log(`[ClaudeCodeAgency] SENT reply → ${msg.from_agent}: ${resultText}`);
	} else {
		console.warn(`[ClaudeCodeAgency] Send result (gated/dropped): ${resultText}`);
	}

	await messaging.markRead({ message_id: msg.id, agent: agentIdentity });
}

async function main() {
	console.log(`[ClaudeCodeAgency] Starting as: ${agentIdentity}`);
	console.log(`[ClaudeCodeAgency] Host: ${hostId} | LLM: ${claudeBin}`);

	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[ClaudeCodeAgency] DB connected");

	// 1. Ensure agent_registry row exists (FK anchor for message_ledger)
	await ensureRegistered();
	console.log("[ClaudeCodeAgency] agent_registry: OK");

	// 2. Register as a proper liaison agency
	let sessionId: string | null = null;
	try {
		const reg = await liaisonRegister({
			agency_id: agentIdentity,
			display_name: agentIdentity.split("/").pop() ?? agentIdentity,
			provider: "claude",
			host_id: hostId,
			capabilities: ["claude", "agent-spawner", "messaging", "code-review"],
			metadata: { pid: process.pid, version: "1.0" },
		});
		sessionId = reg.session_id;
		console.log(`[ClaudeCodeAgency] Liaison registered — session: ${sessionId}`);
	} catch (err) {
		console.warn("[ClaudeCodeAgency] liaisonRegister failed (non-fatal):", err);
	}

	// 3. Heartbeat loop — both liaison protocol + agent_health
	const startMs = Date.now();
	const heartbeatTimer = setInterval(async () => {
		try {
			if (sessionId) {
				await liaisonHeartbeat({ session_id: sessionId, status: "active" });
			}
		} catch (err) {
			console.warn("[ClaudeCodeAgency] liaisonHeartbeat failed:", err);
		}
		pulseHeartbeat(agentIdentity, {
			currentTask: "listening",
			uptimeSeconds: Math.floor((Date.now() - startMs) / 1000),
		}).catch((e) => console.warn("[ClaudeCodeAgency] pulseHeartbeat failed:", e));
	}, 30_000);

	// Emit immediately — visible without waiting 30s
	await pulseHeartbeat(agentIdentity, { currentTask: "starting" });
	if (sessionId) {
		await liaisonHeartbeat({ session_id: sessionId, status: "active" }).catch(() => {});
	}

	// 4. Dedicated pg LISTEN client for incoming A2A messages
	const listenClient = await pool.connect();
	await listenClient.query(`LISTEN "${pgChannel}"`);
	console.log(`[ClaudeCodeAgency] LISTEN active on: ${pgChannel}`);

	listenClient.on("notification", (n) => {
		if (n.channel !== pgChannel || !n.payload) return;
		let parsed: NotifyPayload;
		try {
			parsed = JSON.parse(n.payload);
		} catch {
			console.warn("[ClaudeCodeAgency] Bad notify payload:", n.payload);
			return;
		}
		handleIncoming(parsed).catch((err) =>
			console.error("[ClaudeCodeAgency] Handler error:", err),
		);
	});

	listenClient.on("error", (err) => {
		console.error("[ClaudeCodeAgency] LISTEN client error:", err);
		process.exit(1);
	});

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, async () => {
			console.log(`[ClaudeCodeAgency] ${sig} — shutting down`);
			clearInterval(heartbeatTimer);
			try { listenClient.release(); } catch { /* ignore */ }
			if (sessionId) {
				await endLiaisonSession(sessionId, "operator").catch(() => {});
			}
			const hardExit = setTimeout(() => process.exit(0), 3_000);
			hardExit.unref();
			await closePool();
			process.exit(0);
		});
	}

	console.log("[ClaudeCodeAgency] Ready — listening for A2A messages and pulsing heartbeat");
}

main().catch((err) => {
	console.error("[ClaudeCodeAgency] Fatal:", err);
	process.exit(1);
});
