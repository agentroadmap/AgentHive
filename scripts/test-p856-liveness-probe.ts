/**
 * P856 AC-3 canary: end-to-end liveness probe against a live liaison.
 *
 * Requires a running claude/claude-code agency (or any agent that responds
 * to protocol_ping with protocol_pong). Run with:
 *
 *   AGENTHIVE_TARGET_AGENT=claude/claude-code \
 *   node --import jiti/register scripts/test-p856-liveness-probe.ts
 *
 * Exit 0 = probe returned signal='pong' (agent alive).
 * Exit 1 = probe returned signal='silent' or 'unaddressable' (AC-3 failed).
 * Exit 2 = environment/DB error.
 */

import { getPool, closePool } from "../src/infra/postgres/pool.ts";
import { probeAgentLiveness } from "../src/core/orchestration/probes/agent-liveness.ts";
import { runStaleLeaseProbeSweep } from "../src/core/orchestration/maintenance.ts";

const targetAgent = process.env.AGENTHIVE_TARGET_AGENT ?? "claude/claude-code";
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? "8000");

async function main() {
	const pool = getPool();
	await pool.query("SELECT 1"); // verify DB connectivity
	console.log(`[P856-Canary] DB connected`);
	console.log(`[P856-Canary] Target agent: ${targetAgent}`);
	console.log(`[P856-Canary] Timeout: ${timeoutMs}ms`);

	// ── Test 1: Direct probeAgentLiveness ────────────────────────────────────
	console.log(`\n[P856-Canary] Test 1: direct probeAgentLiveness`);
	const result = await probeAgentLiveness(targetAgent, {
		timeoutMs,
		cheapOnly: false,
		probeFromAgent: "p856-canary",
	});

	console.log(
		`[P856-Canary] signal=${result.signal} alive=${result.alive}` +
		(result.latency_ms !== undefined ? ` latency=${result.latency_ms}ms` : "") +
		(result.reason ? ` reason="${result.reason}"` : ""),
	);

	if (!result.alive) {
		console.error(
			`[P856-Canary] FAIL: agent ${targetAgent} returned signal='${result.signal}'` +
			` — is the liaison running?`,
		);
		await closePool();
		process.exit(1);
	}

	// ── Test 2: Stale-lease sweep (0 or 1 stale dispatches expected) ─────────
	console.log(`\n[P856-Canary] Test 2: runStaleLeaseProbeSweep (dry-run)`);
	const sweepResult = await runStaleLeaseProbeSweep(
		{
			renewalThresholdSec: 10, // low threshold to catch anything recent
			stormCap: 3,
			probeTimeoutMs: timeoutMs,
			probeFromAgent: "p856-canary",
			// onSilent intentionally omitted — read-only / observation only
		},
		undefined, // use real pool.query
		undefined, // use real probeAgentLiveness
		console,
		"P856-Canary",
	);

	console.log(
		`[P856-Canary] Sweep: probed=${sweepResult.probed.length}` +
		` alive=${sweepResult.aliveCount}` +
		` silent=${sweepResult.silentCount}` +
		` unaddressable=${sweepResult.unaddressableCount}`,
	);

	console.log(`\n[P856-Canary] PASS — protocol_ping round-trip verified`);
	await closePool();
	process.exit(0);
}

main().catch((err) => {
	console.error("[P856-Canary] Fatal:", err);
	closePool().catch(() => {});
	process.exit(2);
});
