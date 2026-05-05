/**
 * Autonomous A2A Message Agent
 *
 * A resident agent process that:
 *   1. LISTENs on `a2a_msg_{identity}` (the same pg_notify channel msg_read uses)
 *   2. Passes each incoming message to `claude --print` for LLM processing
 *   3. Sends the LLM-generated reply back via PgMessagingHandlers.sendMessage()
 *      which enforces the trust gate, message_type_contract, correlation tracking,
 *      and fires pg_notify to the original sender.
 *
 * This is a proper A2A participant: it receives through the messaging system,
 * thinks with an LLM, and replies through the messaging system.
 *
 * Usage:
 *   AGENTHIVE_AGENT_IDENTITY=copilot/agency-gary \
 *   node --import jiti/register scripts/start-message-agent.ts
 */

import { spawn } from "node:child_process";
import { getPool, closePool } from "../src/infra/postgres/pool.ts";
import { PgMessagingHandlers } from "../src/apps/mcp-server/tools/messages/pg-handlers.ts";
import { pulseHeartbeat } from "../src/infra/pulse/heartbeat.ts";

const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? "copilot/agency-gary";

const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const pgChannel = `a2a_msg_${agentIdentity}`;

// McpServer arg is only used for server.addTool() — not needed for message ops.
const messaging = new PgMessagingHandlers(null as any, process.cwd());

interface NotifyPayload {
	message_id: number;
	correlation_id?: string;
	from_agent?: string;
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

/**
 * Run `claude --print <prompt>` and return stdout.
 * Inherits the process environment so auth from ~/.claude/settings.json applies.
 */
function runLlm(systemContext: string, userPrompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const fullPrompt =
			`${systemContext}\n\n---\nIncoming message:\n${userPrompt}`;

		const child = spawn(claudeBin, ["--print", fullPrompt], {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { err += d.toString(); });

		child.on("close", (code) => {
			if (code === 0) {
				resolve(out.trim());
			} else {
				reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
			}
		});
		child.on("error", reject);
	});
}

async function handleIncoming(payload: NotifyPayload) {
	const msg = await fetchMessage(payload.message_id);
	if (!msg) {
		console.warn(`[MessageAgent] Message ${payload.message_id} not found`);
		return;
	}

	// Loop guard and duplicate-notify guard
	if (msg.from_agent === agentIdentity) return;
	if (msg.read_at) return;

	console.log(
		`[MessageAgent] RECV [${msg.message_type}] id=${msg.id}` +
		` from=${msg.from_agent} corr=${msg.correlation_id ?? "none"}`,
	);
	console.log(`[MessageAgent]      "${msg.message_content}"`);

	// ── LLM processes the message ──────────────────────────────────────────────
	const systemContext =
		`You are ${agentIdentity}, an autonomous agent in the AgentHive system. ` +
		`You have received a ${msg.message_type} message from ${msg.from_agent}. ` +
		`Reply concisely and helpfully. If the message is a task, acknowledge it ` +
		`and outline how you would approach it. Keep your reply under 3 sentences.`;

	let replyContent: string;
	try {
		console.log(`[MessageAgent] Invoking LLM (${claudeBin} --print)...`);
		replyContent = await runLlm(systemContext, msg.message_content);
		console.log(`[MessageAgent] LLM replied: "${replyContent.slice(0, 120)}..."`);
	} catch (err) {
		console.error("[MessageAgent] LLM failed:", err);
		replyContent = `[${agentIdentity}] Unable to process message ${msg.id} — LLM call failed.`;
	}

	// ── Send reply through the messaging system (trust gate + contract + notify) ─
	const result = await messaging.sendMessage({
		from_agent: agentIdentity,
		to_agent: msg.from_agent,
		message_content: replyContent,
		message_type: "text",
	});

	const resultText =
		result.content[0]?.type === "text" ? result.content[0].text : "";

	if (resultText.startsWith("Message sent")) {
		console.log(`[MessageAgent] SENT reply → ${msg.from_agent}: ${resultText}`);
	} else {
		// Trust gate blocked, contract violation, or silent drop — log what the system decided
		console.warn(`[MessageAgent] Send result (gated/dropped): ${resultText}`);
	}

	// Mark original as read (same as msg_mark_read tool)
	await messaging.markRead({ message_id: msg.id, agent: agentIdentity });
}

async function main() {
	console.log(`[MessageAgent] Starting as: ${agentIdentity}`);
	console.log(`[MessageAgent] LISTEN channel: ${pgChannel}`);
	console.log(`[MessageAgent] LLM binary: ${claudeBin}`);

	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[MessageAgent] DB connected");

	// Dedicated LISTEN client — must stay checked-out for the lifetime of the process.
	// This is the same approach used by msg_read with wait_ms internally.
	const listenClient = await pool.connect();
	await listenClient.query(`LISTEN "${pgChannel}"`);
	console.log("[MessageAgent] LISTEN active — ready");

	listenClient.on("notification", (n) => {
		if (n.channel !== pgChannel || !n.payload) return;
		let parsed: NotifyPayload;
		try {
			parsed = JSON.parse(n.payload);
		} catch {
			console.warn("[MessageAgent] Bad notify payload:", n.payload);
			return;
		}
		handleIncoming(parsed).catch((err) =>
			console.error("[MessageAgent] Handler error:", err),
		);
	});

	listenClient.on("error", (err) => {
		console.error("[MessageAgent] LISTEN client error:", err);
		process.exit(1);
	});

	const startMs = Date.now();
	const hbTimer = setInterval(() => {
		pulseHeartbeat(agentIdentity, {
			currentTask: "listening",
			uptimeSeconds: Math.floor((Date.now() - startMs) / 1000),
		}).catch((e) => console.warn("[MessageAgent] Heartbeat failed:", e));
	}, 60_000);
	await pulseHeartbeat(agentIdentity, { currentTask: "starting" });

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, async () => {
			console.log(`[MessageAgent] ${sig} — shutting down`);
			clearInterval(hbTimer);
			try { listenClient.release(); } catch { /* ignore */ }
			const hardExit = setTimeout(() => process.exit(0), 3_000);
			hardExit.unref();
			await closePool();
			process.exit(0);
		});
	}

	console.log("[MessageAgent] Waiting for messages...");
}

main().catch((err) => {
	console.error("[MessageAgent] Fatal:", err);
	process.exit(1);
});
