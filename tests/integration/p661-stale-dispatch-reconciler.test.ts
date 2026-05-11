/**
 * P661 Integration Smoke Test — Stale Dispatch Reconciler
 *
 * AC-12 (AC-23): given a squad_dispatch with dispatch_status='active' and a paired
 * agent_runs row with status='failed' and completed_at 6 minutes ago, the reconciler
 * UPDATE closes the dispatch and sets reconciled metadata.
 *
 * Uses BEGIN/ROLLBACK isolation; does not leave permanent data.
 * Requires a live agenthive DB via PG* env.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";

// P992 (COMPLETE, no active lease) — safe anchor for FK-satisfying test rows.
const TEST_PROPOSAL_ID = 992;
const TEST_AGENT = "test/p661-smoke";

// The reconciler UPDATE — kept in sync with scripts/orchestrator.ts reconcileStaleDispatches()
const RECONCILER_SQL = `
  UPDATE roadmap_workforce.squad_dispatch sd
  SET dispatch_status = 'cancelled',
      completed_at    = now(),
      metadata = COALESCE(sd.metadata, '{}'::jsonb)
                 || jsonb_build_object(
                      'reconciled_by',  'stale-dispatch-reconciler',
                      'reconciled_at',  now()::text,
                      'reason',         'agent_run terminal but dispatch left active',
                      'terminal_ar_id', ar.id::text,
                      'terminal_status', ar.status
                    )
  FROM roadmap_workforce.agent_runs ar
  WHERE sd.proposal_id      = ar.proposal_id
    AND sd.agent_identity   = ar.agent_identity
    AND sd.dispatch_status IN ('assigned', 'active')
    AND ar.status          IN ('failed', 'cancelled')
    AND ar.completed_at     < now() - interval '5 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM roadmap_workforce.agent_runs ar2
      WHERE ar2.proposal_id    = sd.proposal_id
        AND ar2.agent_identity = sd.agent_identity
        AND ar2.status         = 'running'
        AND ar2.started_at    >= sd.assigned_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM roadmap.liaison_poke_attempt lpa
      WHERE lpa.agency_id = sd.agent_identity
        AND lpa.outcome IS NULL
    )
  RETURNING sd.id, sd.proposal_id, sd.dispatch_status, sd.completed_at, sd.metadata
`;

async function withTx<T>(
	fn: (tx: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		try {
			return await fn(client);
		} finally {
			await client.query("ROLLBACK").catch(() => undefined);
		}
	} finally {
		client.release();
	}
}

describe("P661 — Stale Dispatch Reconciler", () => {
	beforeAll(async () => {
		await getPool().query("SELECT 1");
		await getPool().query(
			`INSERT INTO roadmap_workforce.agent_registry
			    (agent_identity, agent_type, trust_tier, status)
			 VALUES ($1, 'tool', 'restricted', 'active')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[TEST_AGENT],
		);
	});

	afterAll(async () => {
		await getPool().query(
			`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[TEST_AGENT],
		);
		await closePool();
	});

	it("AC-23 happy path: closes a stale active dispatch whose agent_run failed 6+ minutes ago", async () => {
		await withTx(async (tx) => {
			// Insert active dispatch with no completed_at (open)
			const sdRes = await tx.query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status, assigned_at, completed_at, metadata, required_capabilities)
				 VALUES ($1, $2, 'P661-smoke', 'developer', 'active', now() - interval '10 minutes', NULL, '{}', '["developer"]')
				 RETURNING id`,
				[TEST_PROPOSAL_ID, TEST_AGENT],
			);
			const dispatchId = sdRes.rows[0].id;

			// Insert terminal agent_run completed 6 minutes ago
			await tx.query(
				`INSERT INTO roadmap_workforce.agent_runs
				    (proposal_id, agent_identity, stage, model_used, status, started_at, completed_at)
				 VALUES ($1, $2, 'develop', 'claude-sonnet-4-6', 'failed', now() - interval '9 minutes', now() - interval '6 minutes')`,
				[TEST_PROPOSAL_ID, TEST_AGENT],
			);

			const result = await tx.query(RECONCILER_SQL);

			expect(result.rowCount).toBe(1);
			const row = result.rows[0];
			expect(row.dispatch_status).toBe("cancelled");
			expect(row.completed_at).toBeTruthy();
			expect(row.metadata.reconciled_by).toBe("stale-dispatch-reconciler");
			expect(row.metadata.reconciled_at).toBeTruthy();
			expect(row.metadata.terminal_status).toBe("failed");
			expect(row.metadata.terminal_ar_id).toBeTruthy();
			expect(String(row.id)).toBe(String(dispatchId));
		});
	});

	it("AC-23 successor guard: does NOT close dispatch when a newer running agent_run exists", async () => {
		await withTx(async (tx) => {
			await tx.query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status, assigned_at, completed_at, metadata, required_capabilities)
				 VALUES ($1, $2, 'P661-smoke', 'developer', 'active', now() - interval '10 minutes', NULL, '{}', '["developer"]')`,
				[TEST_PROPOSAL_ID, TEST_AGENT],
			);

			// Terminal run (would trigger close in isolation)
			await tx.query(
				`INSERT INTO roadmap_workforce.agent_runs
				    (proposal_id, agent_identity, stage, model_used, status, started_at, completed_at)
				 VALUES ($1, $2, 'develop', 'claude-sonnet-4-6', 'failed', now() - interval '9 minutes', now() - interval '6 minutes')`,
				[TEST_PROPOSAL_ID, TEST_AGENT],
			);

			// Successor running run — blocks closure
			await tx.query(
				`INSERT INTO roadmap_workforce.agent_runs
				    (proposal_id, agent_identity, stage, model_used, status, started_at, completed_at)
				 VALUES ($1, $2, 'develop', 'claude-sonnet-4-6', 'running', now() - interval '3 minutes', NULL)`,
				[TEST_PROPOSAL_ID, TEST_AGENT],
			);

			const result = await tx.query(RECONCILER_SQL);
			expect(result.rowCount).toBe(0);
		});
	});
});
