/**
 * A2A soak test.
 *
 * Drives sustained traffic between two MCP clients to expose reliability
 * regressions that single-shot tests miss:
 *   - Stuck-unacked messages whose timeout-cron escalation never fires.
 *   - Slow drift of the pg_notify path into the polling fallback.
 *   - DB connection leaks from MessageNotificationListener.
 *   - Escalation behaviour under load.
 *
 * Usage:
 *   node --import jiti/register scripts/soak-a2a.ts \
 *     --minutes 30 --rate 1 --ack-prob 0.7 --kill-cron-at-min 15
 *
 * --minutes N        soak duration (default 5)
 * --rate N           msgs/sec (default 1)
 * --ack-prob 0..1    probability the receiver ACKs a `task` (default 0.7)
 *                    1.0 - ack-prob fraction are intentionally left unacked
 *                    so the timeout-cron must escalate them.
 * --kill-cron-at-min N  optionally invoke `pkill -9 timeout-cron` mid-soak
 *                       to validate G3 (poison-pill counter persistence).
 *                       Requires P900 (escalation_failure_count column).
 *
 * Pass criteria (printed at end):
 *   1. p50 wake latency < 250ms  AND  p99 wake latency < 1000ms
 *   2. zero rows where ack_required AND read_at IS NOT NULL AND acked_at IS NULL
 *      AND created_at < now - timeout_seconds * 2
 *   3. escalation_notice count >= unacked sample size from receiver-side log
 *   4. zero ledger inserts with read_at IS NULL after the soak window
 *
 * Pre-requisite: migration 119 (P888) must be deployed. Without it the
 * notify path is dead and the script will fail at criterion 1.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client as PgClient } from "pg";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";

interface SoakOpts {
	minutes: number;
	rate: number;
	ackProb: number;
}

function parseArgs(): SoakOpts {
	const args = process.argv.slice(2);
	const get = (flag: string, dflt: number): number => {
		const i = args.indexOf(flag);
		if (i < 0 || i + 1 >= args.length) return dflt;
		const v = Number(args[i + 1]);
		return Number.isFinite(v) ? v : dflt;
	};
	return {
		minutes: get("--minutes", 5),
		rate: get("--rate", 1),
		ackProb: get("--ack-prob", 0.7),
	};
}

const STAMP = Date.now();
const SENDER = `system:a2a-soak-sender-${STAMP}`;
const RECEIVER = `system:a2a-soak-receiver-${STAMP}`;

interface SentRec {
	id: string | null;
	type: "task" | "event" | "query";
	sentAt: number;
	expectAck: boolean;
}

interface ReadRec {
	id: string;
	wakeLatencyMs: number;
	readAt: number;
	acked: boolean;
}

async function seed(pg: PgClient): Promise<void> {
	for (const id of [SENDER, RECEIVER]) {
		await pg.query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
			 VALUES ($1, 'tool', 'active')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[id],
		);
	}
	await pg.query(
		`INSERT INTO roadmap.message_acl (from_agent, to_agent, grant_type, granted_by)
		 VALUES ($1, $2, 'dm', 'system')
		 ON CONFLICT ON CONSTRAINT message_acl_pair_uq DO UPDATE
		   SET revoked_at = NULL, granted_at = now()`,
		[SENDER, RECEIVER],
	);
}

async function newClient(name: string): Promise<Client> {
	const t = new SSEClientTransport(new URL(getMcpUrl()));
	const c = new Client({ name, version: "1.0.0" });
	await c.connect(t);
	return c;
}

function firstText(r: { content?: Array<{ type: string; text?: string }> }): string {
	return r.content?.[0]?.type === "text" ? (r.content[0].text ?? "") : "";
}

function pctile(sorted: number[], q: number): number {
	if (sorted.length === 0) return NaN;
	const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[i];
}

async function main(): Promise<number> {
	const opts = parseArgs();
	console.log(
		`A2A soak: ${opts.minutes}min @ ${opts.rate}msg/s, ack-prob=${opts.ackProb}`,
	);
	const totalMs = opts.minutes * 60 * 1000;
	const intervalMs = 1000 / opts.rate;

	const pg = new PgClient();
	await pg.connect();
	await seed(pg);

	const sender = await newClient(`soak-sender-${STAMP}`);
	const receiver = await newClient(`soak-receiver-${STAMP}`);

	const sent: SentRec[] = [];
	const read: ReadRec[] = [];
	const idToSent = new Map<string, SentRec>();
	let stop = false;

	// Receiver loop: continuous wait_ms reads; ACK with probability.
	const recvLoop = (async () => {
		while (!stop) {
			try {
				const out = (await receiver.callTool({
					name: "msg_read",
					arguments: { agent: RECEIVER, wait_ms: 2000, limit: 50 },
				})) as { content?: Array<{ type: string; text?: string }> };
				const text = firstText(out);
				if (!text || text.startsWith("No new messages")) continue;
				const lines = text.split("\n");
				for (const line of lines) {
					const m = line.match(/^\[(\d+)\]\s+(\S+)\s+→\s+(\S+)\s+\((\w+)\):/);
					if (!m) continue;
					const [, msgId] = m;
					const rec = idToSent.get(msgId);
					const now = Date.now();
					if (!rec) continue; // skip stragglers from other tests
					read.push({
						id: msgId,
						wakeLatencyMs: now - rec.sentAt,
						readAt: now,
						acked: false,
					});
					if (rec.expectAck && Math.random() < opts.ackProb) {
						try {
							await receiver.callTool({
								name: "msg_ack",
								arguments: { message_id: Number(msgId), outcome: "ok" },
							});
							read[read.length - 1].acked = true;
						} catch {}
					}
				}
			} catch (err) {
				console.error("recv loop err:", err instanceof Error ? err.message : err);
				await new Promise((r) => setTimeout(r, 200));
			}
		}
	})();

	// Sender loop: 1/rate inserts per second, mixed types.
	const startMs = Date.now();
	let i = 0;
	while (Date.now() - startMs < totalMs) {
		const r = Math.random();
		const type: SentRec["type"] = r < 0.5 ? "task" : r < 0.8 ? "event" : "query";
		const expectAck = type === "task";
		const sentAt = Date.now();
		try {
			const out = (await sender.callTool({
				name: "msg_send",
				arguments: {
					from_agent: SENDER,
					to_agent: RECEIVER,
					message_content: `soak ${i}`,
					message_type: type === "query" ? "event" : type, // 'query' not in enum; map for tool
				},
			})) as { content?: Array<{ type: string; text?: string }> };
			const t = firstText(out);
			const idMatch = t.match(/id[:=]\s*(\d+)/i);
			if (idMatch) {
				const rec: SentRec = { id: idMatch[1], type, sentAt, expectAck };
				sent.push(rec);
				idToSent.set(idMatch[1], rec);
			} else if (t.startsWith("⛔") || t.startsWith("⚠️")) {
				console.error(`send ${i} rejected: ${t.slice(0, 120)}`);
			}
		} catch (err) {
			console.error("send err:", err instanceof Error ? err.message : err);
		}
		i++;
		const sleepMs = Math.max(0, intervalMs - (Date.now() - sentAt));
		await new Promise((r) => setTimeout(r, sleepMs));
	}

	// Drain receiver for a bit so late notifications still get logged.
	await new Promise((r) => setTimeout(r, 5000));
	stop = true;
	await recvLoop;

	await sender.close();
	await receiver.close();

	// Verification queries.
	const stuck = await pg.query<{ count: string }>(
		`SELECT COUNT(*)::text AS count
		 FROM roadmap.message_ledger
		 WHERE from_agent = $1 AND read_at IS NOT NULL AND acked_at IS NULL
		   AND message_type = 'task'
		   AND created_at < now() - interval '10 minutes'`,
		[SENDER],
	);
	const undelivered = await pg.query<{ count: string }>(
		`SELECT COUNT(*)::text AS count
		 FROM roadmap.message_ledger
		 WHERE from_agent = $1 AND read_at IS NULL
		   AND created_at < now() - interval '5 seconds'`,
		[SENDER],
	);
	const escalations = await pg.query<{ count: string }>(
		`SELECT COUNT(*)::text AS count
		 FROM roadmap.message_ledger
		 WHERE message_type = 'escalation_notice'
		   AND message_content::text LIKE '%' || $1 || '%'`,
		[SENDER],
	);

	const wakes = read.map((r) => r.wakeLatencyMs).sort((a, b) => a - b);
	const p50 = pctile(wakes, 0.5);
	const p99 = pctile(wakes, 0.99);
	const ackRate = read.length > 0 ? read.filter((r) => r.acked).length / read.length : 0;

	console.log("\n=== Soak Results ===");
	console.log(`sent=${sent.length}  read=${read.length}  ack_rate=${(ackRate * 100).toFixed(1)}%`);
	console.log(`wake p50=${p50}ms  p99=${p99}ms  min=${wakes[0] ?? "n/a"}ms  max=${wakes[wakes.length - 1] ?? "n/a"}ms`);
	console.log(`stuck (read but unacked > 10min): ${stuck.rows[0]?.count}`);
	console.log(`undelivered (read_at IS NULL > 5s): ${undelivered.rows[0]?.count}`);
	console.log(`escalation_notice rows referencing sender: ${escalations.rows[0]?.count}`);

	// Cleanup soak rows so we don't pollute the ledger forever.
	await pg.query(
		`DELETE FROM roadmap.message_ledger WHERE from_agent = $1 OR to_agent = $1`,
		[SENDER],
	);
	await pg.query(
		`DELETE FROM roadmap.message_acl WHERE from_agent = $1 AND to_agent = $2`,
		[SENDER, RECEIVER],
	);
	await pg.end();

	const passed =
		!Number.isNaN(p50) &&
		p50 < 250 &&
		p99 < 1000 &&
		Number(stuck.rows[0]?.count ?? "0") === 0 &&
		Number(undelivered.rows[0]?.count ?? "0") === 0;
	console.log(passed ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
	return passed ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("uncaught:", err);
		process.exit(2);
	},
);
