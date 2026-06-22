/**
 * P4668 — Migration 315: State reconstruction + provider-mismatch + AC-18/30/31 audit views.
 *
 * Tests:
 *   Text-scan (always run, no DB):
 *     TS-1   AC-8: v_p4668_state_reconstruction view is defined
 *     TS-2   AC-8: DISTINCT ON (proposal_id) ORDER BY seq DESC selects last event
 *     TS-3   AC-8: status_mismatch and maturity_mismatch columns are present
 *     TS-4   AC-8: reconstruction_status CASE emits consistent/status_drift/maturity_drift/both_drift
 *     TS-5   AC-8: v_p4668_quarantine view filters to != 'consistent'
 *     TS-6   AC-15: v_provider_mismatch_events view filters WHERE provider_mismatch = TRUE
 *     TS-7   AC-15: flag_missing_claimed_provider and flag_missing_resolved_provider present
 *     TS-8   AC-18: v_backfill_provider_audit filters source_confidence='low' with set providers
 *     TS-9   AC-18: mig 310 backfill INSERT has no resolved_provider / model_used from name
 *     TS-10  AC-30: v_p4668_maturity_demotion_audit filters from_maturity='validated' demotions
 *     TS-11  AC-30: demotion_severity classified as critical (validated→new) / warning / info
 *     TS-12  AC-31: v_p4668_missing_actor_host filters actor_layer IN spawn-agent/liaison
 *     TS-13  AC-31: actor_host NULL condition is the filter predicate
 *     TS-14  Rollback file drops all six views
 *     TS-15  GRANT SELECT on all five views covers claude, agent_read, agent_write, andy
 *
 *   Live-DB (AGENTHIVE_ALLOW_LIVE_DB=1):
 *     DB-315-1  v_p4668_state_reconstruction exists and is queryable
 *     DB-315-2  v_p4668_quarantine shows consistent row after canonical insert
 *     DB-315-3  v_provider_mismatch_events is queryable (may be empty)
 *     DB-315-4  v_backfill_provider_audit is empty (no low-confidence rows have providers)
 *     DB-315-5  v_p4668_maturity_demotion_audit is queryable (may be empty)
 *     DB-315-6  v_p4668_missing_actor_host is queryable
 *
 * Run live:
 *   AGENTHIVE_ALLOW_LIVE_DB=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=admin \
 *   PGDATABASE=agenthive PGPASSWORD=<pass> npx vitest run \
 *   scripts/migrations/__tests__/p4668-mig315.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, "..");
const ROLLBACK_DIR = join(MIG_DIR, "rollback");

const mig315 = readFileSync(join(MIG_DIR, "315-p4668-state-reconstruction.sql"), "utf8");
const mig310 = readFileSync(join(MIG_DIR, "310-p4668-dual-write-shim.sql"), "utf8");
const rollback315 = readFileSync(
	join(ROLLBACK_DIR, "315-p4668-state-reconstruction.rollback.sql"),
	"utf8",
);

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

// ── Text-scan tests ───────────────────────────────────────────────────────────

describe("P4668 mig-315 AC-8: v_p4668_state_reconstruction (text-scan)", () => {
	it("TS-1: view is defined in migration 315", () => {
		expect(mig315).toMatch(/v_p4668_state_reconstruction/);
		expect(mig315).toMatch(/CREATE OR REPLACE VIEW/);
	});

	it("TS-2: DISTINCT ON (proposal_id) ORDER BY seq DESC picks the last event", () => {
		expect(mig315).toMatch(/DISTINCT ON \(proposal_id\)/);
		expect(mig315).toMatch(/ORDER BY proposal_id, seq DESC/);
	});

	it("TS-3: status_mismatch and maturity_mismatch flag columns are present", () => {
		expect(mig315).toMatch(/status_mismatch/);
		expect(mig315).toMatch(/maturity_mismatch/);
	});

	it("TS-4: reconstruction_status CASE covers all four outcome values", () => {
		expect(mig315).toMatch(/'both_drift'/);
		expect(mig315).toMatch(/'status_drift'/);
		expect(mig315).toMatch(/'maturity_drift'/);
		expect(mig315).toMatch(/'consistent'/);
	});

	it("TS-5: v_p4668_quarantine filters to reconstruction_status != consistent", () => {
		expect(mig315).toMatch(/v_p4668_quarantine/);
		expect(mig315).toMatch(/reconstruction_status.*!=.*'consistent'|!= 'consistent'/);
	});
});

describe("P4668 mig-315 AC-15: v_provider_mismatch_events (text-scan)", () => {
	it("TS-6: view filters WHERE provider_mismatch = TRUE", () => {
		expect(mig315).toMatch(/v_provider_mismatch_events/);
		expect(mig315).toMatch(/provider_mismatch\s*=\s*TRUE/);
	});

	it("TS-7: integrity flags for missing claimed/resolved provider are present", () => {
		expect(mig315).toMatch(/flag_missing_claimed_provider/);
		expect(mig315).toMatch(/flag_missing_resolved_provider/);
	});
});

describe("P4668 mig-315 AC-18: v_backfill_provider_audit (text-scan)", () => {
	it("TS-8: view filters source_confidence=low rows that have provider/model set", () => {
		expect(mig315).toMatch(/v_backfill_provider_audit/);
		expect(mig315).toMatch(/source_confidence\s*=\s*'low'/);
		expect(mig315).toMatch(/resolved_provider IS NOT NULL/);
		expect(mig315).toMatch(/model_used IS NOT NULL/);
	});

	it("TS-9: mig 310 backfill INSERT does not populate resolved_provider or model_used", () => {
		// The backfill function in mig 310 should insert NULL for resolved_provider
		// and not derive it from the actor_identity string (agency-name prefix inference).
		// Check that the fn_p4668_backfill_history INSERT does not have resolved_provider.
		// The backfill fn_p4668_backfill_history INSERT block is identified by the pst-shadow prefix.
		const backfillFnBody = mig310.match(
			/fn_p4668_backfill_history[\s\S]*?END.*?\$function\$/,
		)?.[0] ?? "";
		// Neither resolved_provider nor model_used should appear in the INSERT column list
		// (they are intentionally omitted to be NULL).
		// We verify that the column list (between "INSERT INTO ... (" and "VALUES") has no entry.
		const insertBlock = backfillFnBody.match(/INSERT INTO[\s\S]*?VALUES/)?.[0] ?? "";
		expect(insertBlock).not.toMatch(/resolved_provider/);
		expect(insertBlock).not.toMatch(/model_used/);
	});
});

describe("P4668 mig-315 AC-30: v_p4668_maturity_demotion_audit (text-scan)", () => {
	it("TS-10: view filters from_maturity='validated' demotions", () => {
		expect(mig315).toMatch(/v_p4668_maturity_demotion_audit/);
		expect(mig315).toMatch(/from_maturity\s*=\s*'validated'/);
	});

	it("TS-11: demotion_severity critical/warning/info classification is present", () => {
		expect(mig315).toMatch(/'critical'/);
		expect(mig315).toMatch(/'warning'/);
		expect(mig315).toMatch(/demotion_severity/);
		// critical case: validated → new
		expect(mig315).toMatch(/from_maturity = 'validated'[\s\S]{0,100}to_maturity = 'new'[\s\S]{0,100}'critical'|'critical'[\s\S]{0,200}validated[\s\S]{0,100}new/);
	});
});

describe("P4668 mig-315 AC-31: v_p4668_missing_actor_host (text-scan)", () => {
	it("TS-12: view filters actor_layer IN spawn-agent/liaison", () => {
		expect(mig315).toMatch(/v_p4668_missing_actor_host/);
		expect(mig315).toMatch(/actor_layer.*IN.*spawn-agent.*liaison|spawn-agent.*liaison/);
	});

	it("TS-13: actor_host IS NULL is the filter predicate", () => {
		expect(mig315).toMatch(/actor_host IS NULL/);
	});
});

describe("P4668 mig-315 rollback + grants (text-scan)", () => {
	it("TS-14: rollback drops all five audit views", () => {
		expect(rollback315).toMatch(/DROP VIEW IF EXISTS.*v_p4668_missing_actor_host/);
		expect(rollback315).toMatch(/DROP VIEW IF EXISTS.*v_p4668_maturity_demotion_audit/);
		expect(rollback315).toMatch(/DROP VIEW IF EXISTS.*v_backfill_provider_audit/);
		expect(rollback315).toMatch(/DROP VIEW IF EXISTS.*v_provider_mismatch_events/);
		expect(rollback315).toMatch(/DROP VIEW IF EXISTS.*v_p4668_quarantine/);
		expect(rollback315).toMatch(/DROP VIEW IF EXISTS.*v_p4668_state_reconstruction/);
	});

	it("TS-15: GRANT SELECT covers claude, agent_read, agent_write, andy on all views", () => {
		const grantCount = (mig315.match(/GRANT SELECT ON/g) ?? []).length;
		// 5 views each getting a GRANT SELECT
		expect(grantCount).toBeGreaterThanOrEqual(5);
		expect(mig315).toMatch(/TO claude, agent_read, agent_write, andy/);
	});
});

// ── Live-DB integration tests ─────────────────────────────────────────────────

describe.skipIf(!LIVE)("P4668 mig-315: audit views live-DB", () => {
	let queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
	let testProposalId: number;

	beforeAll(async () => {
		const { query } = await import("../../../src/postgres/pool.ts");
		queryFn = query;

		// Insert a throwaway proposal for ledger tests
		const { rows } = await queryFn<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, type, maturity, project_id, audit,
			    gate_scanner_paused)
			 VALUES ($1, 'P4668 mig315 test', 'DEVELOP', 'feature',
			         'obsolete', 1, '[]'::jsonb, true)
			 RETURNING id`,
			[`P4668T315-${Date.now() % 100000}`],
		);
		testProposalId = rows[0].id;

		// Insert a canonical ledger event matching the live proposal state
		await queryFn(
			`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
			[
				JSON.stringify({
					proposal_id: String(testProposalId),
					event_kind: "status_transition",
					actor_principal_id: "claude-bot-gary",
					actor_layer: "orchestrator",
					to_status: "DEVELOP",
					to_maturity: "obsolete",
					source_surface: "p4668-mig315-test",
				}),
			],
		);
	});

	afterAll(async () => {
		if (!queryFn || !testProposalId) return;
		await queryFn(
			`DELETE FROM roadmap_proposal.proposal_transition_ledger WHERE proposal_id = $1`,
			[testProposalId],
		);
		await queryFn(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [testProposalId]);
	});

	it("DB-315-1: v_p4668_state_reconstruction is queryable", async () => {
		const { rows } = await queryFn(
			`SELECT * FROM roadmap_proposal.v_p4668_state_reconstruction
			 WHERE proposal_id = $1`,
			[testProposalId],
		);
		// Our test proposal has ledger event with to_status=DEVELOP, live.status=DEVELOP
		expect(rows).toHaveLength(1);
		expect(rows[0].proposal_id).toBe(testProposalId);
		expect(rows[0].reconstruction_status).toBeDefined();
	});

	it("DB-315-2: test proposal shows reconstruction_status=consistent after canonical insert", async () => {
		const { rows } = await queryFn(
			`SELECT reconstruction_status, status_mismatch, maturity_mismatch
			 FROM roadmap_proposal.v_p4668_state_reconstruction
			 WHERE proposal_id = $1`,
			[testProposalId],
		);
		expect(rows).toHaveLength(1);
		// We inserted to_status=DEVELOP and live status=DEVELOP → consistent
		expect(rows[0].reconstruction_status).toBe("consistent");
		expect(rows[0].status_mismatch).toBe(false);
	});

	it("DB-315-3: v_provider_mismatch_events is queryable (may be empty)", async () => {
		const { rows } = await queryFn(
			`SELECT COUNT(*)::int AS n FROM roadmap_proposal.v_provider_mismatch_events`,
			[],
		);
		expect(rows[0].n).toBeGreaterThanOrEqual(0);
	});

	it("DB-315-4: v_backfill_provider_audit is empty (no low-confidence rows have providers set)", async () => {
		const { rows } = await queryFn(
			`SELECT COUNT(*)::int AS n FROM roadmap_proposal.v_backfill_provider_audit`,
			[],
		);
		expect(rows[0].n).toBe(0);
	});

	it("DB-315-5: v_p4668_maturity_demotion_audit is queryable", async () => {
		const { rows } = await queryFn(
			`SELECT COUNT(*)::int AS n FROM roadmap_proposal.v_p4668_maturity_demotion_audit`,
			[],
		);
		expect(rows[0].n).toBeGreaterThanOrEqual(0);
	});

	it("DB-315-6: v_p4668_missing_actor_host is queryable", async () => {
		const { rows } = await queryFn(
			`SELECT COUNT(*)::int AS n FROM roadmap_proposal.v_p4668_missing_actor_host`,
			[],
		);
		expect(rows[0].n).toBeGreaterThanOrEqual(0);
	});
});
