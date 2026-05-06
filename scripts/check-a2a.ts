/**
 * A2A end-to-end health check.
 *
 * Two MCP `Client` instances connect to the running SSE server with
 * distinct identities. The sender posts a DM via `msg_send`; the receiver
 * blocks on `msg_read(wait_ms=2000)`. The check passes only if:
 *
 *   1. The send succeeded (no ACL denial — both identities are seeded and
 *      a self-`*` ACL grant exists for the sender).
 *   2. The receiver's blocking read returns within 500ms (proves
 *      pg_notify wake — not the slow polling fallback).
 *   3. The exact message inserted is the message read (id round-trip).
 *
 * Exits non-zero on any failure. Safe to run from a systemd timer or cron.
 *
 * Replaces the previous in-process self-talk that had the same MCP
 * client send from `claude/one` and read from `claude/andy` — that
 * version validated only "INSERT then SELECT in the same SSE session"
 * and was the script the operator was trusting as "A2A green."
 *
 * Pre-requisite: migration 119 (P888) must be deployed. Without it the
 * trigger does not emit on a2a_msg_<id> and this check will fail at the
 * latency assertion.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client as PgClient } from "pg";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";

const STAMP = Date.now();
const SENDER = `system:a2a-health-sender-${STAMP}`;
const RECEIVER = `system:a2a-health-receiver-${STAMP}`;
const NOTIFY_BUDGET_MS = 500;
const WAIT_MS = 2000;

interface CheckResult {
	pass: boolean;
	stage: string;
	detail?: string;
	elapsedMs?: number;
}

function fmtResult(r: CheckResult): string {
	const status = r.pass ? "PASS" : "FAIL";
	const elapsed = r.elapsedMs !== undefined ? ` (${r.elapsedMs}ms)` : "";
	const detail = r.detail ? ` — ${r.detail}` : "";
	return `[${status}] ${r.stage}${elapsed}${detail}`;
}

function firstText(result: { content?: Array<{ type: string; text?: string }> }): string {
	const first = result.content?.[0];
	return first?.type === "text" && first.text ? first.text : "";
}

async function seedIdentitiesAndAcl(pg: PgClient): Promise<void> {
	for (const id of [SENDER, RECEIVER]) {
		await pg.query(
			`INSERT INTO roadmap_workforce.agent_registry
			   (agent_identity, agent_type, status)
			 VALUES ($1, 'tool', 'active')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[id],
		);
	}
	// ACL: SENDER → RECEIVER (dm grant). The MCP `msg_send` enforces this
	// for non-system senders. SENDER has prefix 'system:' but the trust gate
	// only bypasses exactly 'system' / 'orchestrator', so an ACL row is
	// required.
	await pg.query(
		`INSERT INTO roadmap.message_acl
		   (from_agent, to_agent, grant_type, granted_by)
		 VALUES ($1, $2, 'dm', 'system')
		 ON CONFLICT ON CONSTRAINT message_acl_pair_uq DO UPDATE
		   SET revoked_at = NULL, granted_at = now()`,
		[SENDER, RECEIVER],
	);
}

async function cleanup(pg: PgClient): Promise<void> {
	await pg.query(
		`DELETE FROM roadmap.message_ledger WHERE from_agent = $1 OR to_agent = $1 OR from_agent = $2 OR to_agent = $2`,
		[SENDER, RECEIVER],
	);
	await pg.query(
		`DELETE FROM roadmap.message_acl WHERE from_agent = $1 AND to_agent = $2`,
		[SENDER, RECEIVER],
	);
	// agent_registry rows intentionally left in place — same convention as
	// other test suites (cleanup risks FK violations).
}

async function newMcpClient(name: string): Promise<Client> {
	const transport = new SSEClientTransport(new URL(getMcpUrl()));
	const client = new Client({ name, version: "1.0.0" });
	await client.connect(transport);
	return client;
}

async function main(): Promise<number> {
	const results: CheckResult[] = [];
	const pg = new PgClient();
	let sender: Client | null = null;
	let receiver: Client | null = null;

	try {
		await pg.connect();
		await seedIdentitiesAndAcl(pg);
		results.push({ pass: true, stage: "seed identities + ACL" });

		sender = await newMcpClient(`a2a-health-${SENDER}`);
		receiver = await newMcpClient(`a2a-health-${RECEIVER}`);
		results.push({ pass: true, stage: "connect two MCP clients" });

		// Receiver kicks off the blocking read first so the listener is
		// registered before the sender's INSERT fires the trigger.
		const readP = (async () => {
			const t0 = Date.now();
			const out = await receiver!.callTool({
				name: "msg_read",
				arguments: {
					agent: RECEIVER,
					wait_ms: WAIT_MS,
					limit: 5,
				},
			}) as { content?: Array<{ type: string; text?: string }> };
			return { text: firstText(out), elapsedMs: Date.now() - t0 };
		})();

		// Tiny grace so receiver's LISTEN reaches the DB before INSERT.
		await new Promise((r) => setTimeout(r, 50));

		const sendOut = (await sender.callTool({
			name: "msg_send",
			arguments: {
				from_agent: SENDER,
				to_agent: RECEIVER,
				message_content: `health probe ${STAMP}`,
				message_type: "event",
			},
		})) as { content?: Array<{ type: string; text?: string }> };
		const sendText = firstText(sendOut);
		if (sendText.startsWith("⛔")) {
			results.push({ pass: false, stage: "msg_send", detail: sendText });
			throw new Error("send denied");
		}
		const sendIdMatch = sendText.match(/id[:=]\s*(\d+)/i);
		const sentId = sendIdMatch ? sendIdMatch[1] : null;
		results.push({
			pass: sentId !== null,
			stage: "msg_send",
			detail: sentId ? `id=${sentId}` : `unparseable response: ${sendText.slice(0, 80)}`,
		});

		const { text: readText, elapsedMs } = await readP;

		const arrivedViaWake = readText && !readText.startsWith("No new messages");
		if (arrivedViaWake) {
			results.push({
				pass: true,
				stage: "msg_read wake (any)",
				detail: readText.slice(0, 80),
				elapsedMs,
			});
			results.push({
				pass: elapsedMs <= NOTIFY_BUDGET_MS,
				stage: `msg_read pg_notify latency ≤ ${NOTIFY_BUDGET_MS}ms`,
				detail:
					elapsedMs > NOTIFY_BUDGET_MS
						? "fell back to polling — fn_a2a_message_notify trigger likely missing (see P888)"
						: undefined,
				elapsedMs,
			});
			if (sentId) {
				results.push({
					pass: readText.includes(sentId) || readText.includes(`health probe ${STAMP}`),
					stage: "round-trip identity match",
					detail: `sent id=${sentId}`,
				});
			}
		} else {
			// Wake path failed. Distinguish "message lost" from "notify broken"
			// by fetching directly with a non-blocking read.
			const fetchOut = (await receiver!.callTool({
				name: "msg_read",
				arguments: { agent: RECEIVER, limit: 5 },
			})) as { content?: Array<{ type: string; text?: string }> };
			const fetchText = firstText(fetchOut);
			const messageInLedger =
				sentId !== null &&
				(fetchText.includes(sentId) || fetchText.includes(`health probe ${STAMP}`));
			results.push({
				pass: false,
				stage: "msg_read wake",
				detail: messageInLedger
					? `notify path broken — message IS in ledger but listener never woke (apply migration 119 / P888)`
					: `message neither delivered via notify nor present in ledger (deeper issue)`,
				elapsedMs,
			});
		}
	} catch (err) {
		results.push({
			pass: false,
			stage: "fatal",
			detail: err instanceof Error ? err.message : String(err),
		});
	} finally {
		try {
			await sender?.close();
		} catch {}
		try {
			await receiver?.close();
		} catch {}
		try {
			await cleanup(pg);
		} catch {}
		await pg.end();
	}

	console.log("=== A2A Health Check ===");
	for (const r of results) console.log(fmtResult(r));
	const allPass = results.every((r) => r.pass);
	console.log(allPass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
	return allPass ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("uncaught:", err);
		process.exit(2);
	},
);
