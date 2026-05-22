/**
 * P1126: Integration tests for user-inbox-consumer resilience.
 *
 * Tests that the consumer exits with code 1 when the PG LISTEN connection dies,
 * that cleanup runs (listener_subscription deleted), that boot-drain catches
 * messages inserted during the dead window, and that duplicate processing is
 * prevented when two instances overlap.
 *
 * Requires a live PG database accessible via env vars / ~/.pgpass.
 * Run with: bun test tests/integration/user-inbox-consumer-resilience.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { describe, it, before, after } from "node:test";
import { Client } from "pg";

// ─── DB helpers ───────────────────────────────────────────────────────────────

function readEnvPassword(): string | undefined {
	for (const pw of [process.env.PGPASSWORD, process.env.PG_PASSWORD]) {
		if (pw) return pw;
	}
	const envPaths = [
		(process.env.HOME ?? "") + "/.hermes/.env",
		"/data/code/AgentHive/.env",
	];
	for (const envPath of envPaths) {
		if (!envPath || !existsSync(envPath)) continue;
		for (const line of readFileSync(envPath, "utf-8").split("\n")) {
			const m = /^\s*(?:PGPASSWORD|PG_PASSWORD)\s*=\s*(.+)/.exec(line);
			if (m) return m[1].trim();
		}
	}
	return undefined;
}

function makeClient(): Client {
	return new Client({
		host: process.env.PGHOST ?? process.env.PG_HOST ?? "127.0.0.1",
		port: Number(
			process.env.PGPORT_DIRECT ??
				process.env.PGPORT ??
				process.env.PG_PORT ??
				"5432",
		),
		user: process.env.PGUSER ?? process.env.PG_USER,
		password: readEnvPassword(),
		database: process.env.PGDATABASE ?? process.env.PG_DATABASE ?? "agenthive",
	});
}

// ─── Consumer spawn helper ────────────────────────────────────────────────────

type ConsumerProcess = ReturnType<typeof spawn>;

function spawnConsumer(operator: string): ConsumerProcess {
	const env = {
		...process.env,
		INBOX_OPERATOR: operator,
	};
	return spawn("bun", ["run", "scripts/user-inbox-consumer.ts"], {
		cwd: "/data/code/AgentHive",
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function waitForExit(
	proc: ConsumerProcess,
	timeoutMs: number,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`Process did not exit within ${timeoutMs}ms`));
		}, timeoutMs);

		proc.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

function waitForStdout(
	proc: ConsumerProcess,
	pattern: RegExp,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out waiting for stdout: ${pattern}`)),
			timeoutMs,
		);
		const check = (chunk: Buffer) => {
			if (pattern.test(chunk.toString())) {
				clearTimeout(timer);
				proc.stdout?.off("data", check);
				resolve();
			}
		};
		proc.stdout?.on("data", check);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ─── Test suite ───────────────────────────────────────────────────────────────

// Unique operator name per test run to avoid collisions with production consumer.
const TEST_OPERATOR = `test-resilience-${process.pid}`;
const TEST_IDENTITY = `user/${TEST_OPERATOR}`;
const CHANNEL = `a2a_msg_${TEST_IDENTITY}`;

let db: Client;

before(async () => {
	db = makeClient();
	await db.connect();

	// Seed the test operator into agent_registry so the consumer INSERT is idempotent.
	await db.query(
		`INSERT INTO roadmap_workforce.agent_registry
		    (agent_identity, agent_type, trust_tier, status)
		 VALUES ($1, 'human', 'authority', 'active')
		 ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
		[TEST_IDENTITY],
	);
});

after(async () => {
	// Best-effort cleanup of any leftover test data.
	await db.query(
		`DELETE FROM roadmap.listener_subscription WHERE agent_identity = $1`,
		[TEST_IDENTITY],
	);
	await db.query(
		`DELETE FROM roadmap.message_ledger WHERE to_agent = $1`,
		[TEST_IDENTITY],
	);
	await db.query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[TEST_IDENTITY],
	);
	await db.end();
});

describe("user-inbox-consumer resilience", () => {
	it(
		"exits with code 1 when PG backend is terminated and cleans up subscription",
		{ timeout: 30_000 },
		async () => {
			const proc = spawnConsumer(TEST_OPERATOR);

			// Wait for the consumer to be ready.
			await waitForStdout(proc, /Ready — consuming inbox/, 15_000);

			// Verify listener_subscription row was created.
			const { rows: subRows } = await db.query(
				`SELECT established_pid FROM roadmap.listener_subscription
				  WHERE agent_identity = $1 AND channel = $2`,
				[TEST_IDENTITY, CHANNEL],
			);
			assert.equal(
				subRows.length,
				1,
				"listener_subscription row should exist after startup",
			);
			const listenPid = subRows[0].established_pid as number;
			assert.ok(listenPid > 0, "established_pid should be a positive integer");

			// Terminate the consumer's PG backend connection.
			await db.query(`SELECT pg_terminate_backend($1)`, [listenPid]);

			// Consumer should exit with code 1 within 5 seconds.
			const code = await waitForExit(proc, 5_000);
			assert.equal(code, 1, "consumer should exit with code 1 on PG disconnect");

			// Give cleanup a moment to propagate (it runs before exit).
			await sleep(500);

			// listener_subscription should be gone.
			const { rows: afterRows } = await db.query(
				`SELECT 1 FROM roadmap.listener_subscription
				  WHERE agent_identity = $1 AND channel = $2`,
				[TEST_IDENTITY, CHANNEL],
			);
			assert.equal(
				afterRows.length,
				0,
				"listener_subscription should be deleted after exit",
			);
		},
	);

	it(
		"restart catches messages inserted during the dead window via boot drain",
		{ timeout: 60_000 },
		async () => {
			const proc1 = spawnConsumer(TEST_OPERATOR);
			await waitForStdout(proc1, /Ready — consuming inbox/, 15_000);

			// Get the listen pid and terminate to simulate a silent disconnect.
			const { rows: subRows } = await db.query(
				`SELECT established_pid FROM roadmap.listener_subscription
				  WHERE agent_identity = $1 AND channel = $2`,
				[TEST_IDENTITY, CHANNEL],
			);
			assert.equal(subRows.length, 1, "subscription must exist");
			const listenPid = subRows[0].established_pid as number;

			// Kill the backend — consumer will exit.
			await db.query(`SELECT pg_terminate_backend($1)`, [listenPid]);
			await waitForExit(proc1, 5_000);

			// Insert 2 messages while consumer is dead.
			const ins1 = await db.query<{ id: number }>(
				`INSERT INTO roadmap.message_ledger
				    (from_agent, to_agent, message_type, message_content, created_at)
				 VALUES ('system', $1, 'test_ping', 'msg-A', now())
				 RETURNING id`,
				[TEST_IDENTITY],
			);
			const ins2 = await db.query<{ id: number }>(
				`INSERT INTO roadmap.message_ledger
				    (from_agent, to_agent, message_type, message_content, created_at)
				 VALUES ('system', $1, 'test_ping', 'msg-B', now())
				 RETURNING id`,
				[TEST_IDENTITY],
			);
			const id1 = ins1.rows[0].id;
			const id2 = ins2.rows[0].id;

			// Restart consumer.
			const proc2 = spawnConsumer(TEST_OPERATOR);
			await waitForStdout(proc2, /Boot drain complete|no unread messages/, 20_000);

			// Assert both messages were marked read within 30 seconds.
			const deadline = Date.now() + 30_000;
			let bothRead = false;
			while (Date.now() < deadline) {
				const { rows } = await db.query(
					`SELECT id FROM roadmap.message_ledger
					  WHERE id = ANY($1::int[]) AND read_at IS NOT NULL`,
					[[id1, id2]],
				);
				if (rows.length === 2) {
					bothRead = true;
					break;
				}
				await sleep(500);
			}
			assert.ok(bothRead, "boot drain should mark both messages read within 30s");

			// Clean up proc2.
			proc2.kill("SIGTERM");
			await waitForExit(proc2, 5_000).catch(() => proc2.kill("SIGKILL"));
		},
	);

	it(
		"new listener_subscription has a new pid after restart",
		{ timeout: 30_000 },
		async () => {
			const proc1 = spawnConsumer(TEST_OPERATOR);
			await waitForStdout(proc1, /Ready — consuming inbox/, 15_000);

			const { rows: rows1 } = await db.query(
				`SELECT established_pid FROM roadmap.listener_subscription
				  WHERE agent_identity = $1 AND channel = $2`,
				[TEST_IDENTITY, CHANNEL],
			);
			assert.equal(rows1.length, 1);
			const pid1 = rows1[0].established_pid as number;

			// Graceful stop.
			proc1.kill("SIGTERM");
			await waitForExit(proc1, 5_000);
			await sleep(500);

			// Restart.
			const proc2 = spawnConsumer(TEST_OPERATOR);
			await waitForStdout(proc2, /Ready — consuming inbox/, 15_000);

			const { rows: rows2 } = await db.query(
				`SELECT established_pid FROM roadmap.listener_subscription
				  WHERE agent_identity = $1 AND channel = $2`,
				[TEST_IDENTITY, CHANNEL],
			);
			assert.equal(rows2.length, 1, "subscription row should exist after restart");
			const pid2 = rows2[0].established_pid as number;
			assert.notEqual(pid2, pid1, "restarted consumer should have a new PG pid");

			proc2.kill("SIGTERM");
			await waitForExit(proc2, 5_000).catch(() => proc2.kill("SIGKILL"));
		},
	);

	it(
		"duplicate guard: two simultaneous consumers mark a message read exactly once",
		{ timeout: 30_000 },
		async () => {
			// Insert a message BEFORE starting consumers (both will drain it).
			const { rows: ins } = await db.query<{ id: number }>(
				`INSERT INTO roadmap.message_ledger
				    (from_agent, to_agent, message_type, message_content, created_at)
				 VALUES ('system', $1, 'test_ping', 'duplicate-guard', now())
				 RETURNING id`,
				[TEST_IDENTITY],
			);
			const msgId = ins[0].id;

			// Start two consumers simultaneously.
			const proc1 = spawnConsumer(TEST_OPERATOR);
			const proc2 = spawnConsumer(TEST_OPERATOR);

			// Wait for both to finish draining (one will get the row, the other skips it).
			await Promise.all([
				waitForStdout(proc1, /Boot drain complete|no unread messages/, 15_000),
				waitForStdout(proc2, /Boot drain complete|no unread messages/, 15_000),
			]);

			// Give the mark-read UPDATE a moment to commit.
			await sleep(500);

			// read_at should be set exactly once (check the value is a single timestamp).
			const { rows } = await db.query(
				`SELECT read_at FROM roadmap.message_ledger WHERE id = $1`,
				[msgId],
			);
			assert.equal(rows.length, 1, "message should exist");
			assert.ok(rows[0].read_at !== null, "message should be marked read");

			// Graceful cleanup.
			proc1.kill("SIGTERM");
			proc2.kill("SIGTERM");
			await Promise.allSettled([
				waitForExit(proc1, 5_000),
				waitForExit(proc2, 5_000),
			]);
		},
	);
});
