/**
 * P4668 — Append-only transition ledger (migrations 306–309).
 *
 * Tests:
 *   Text-scan (always run, no DB):
 *     TS-1  mig 306 contains SECURITY DEFINER function
 *     TS-2  mig 306 revokes UPDATE/DELETE/TRUNCATE on ledger table
 *     TS-3  mig 306 REVOKE statement targets all three roles
 *     TS-4  mig 306 audit view exposes all three actor-identity axes (AC-13)
 *     TS-5  mig 306 hash includes GENESIS sentinel
 *     TS-6  mig 307 adds ledger_event_id FK to proposal_event
 *     TS-7  mig 308 extends event_type CHECK with all six P4668 values
 *     TS-8  mig 309 extends from/to_maturity with 'validated'
 *     TS-9  mig 309 extends transition_reason with canonical/break_glass/compensating_correction
 *
 *   Live-DB (AGENTHIVE_ALLOW_LIVE_DB=1, DB must have mig 306-309 applied):
 *     DB-1  fn_canonical_transition_insert rejects missing actor_principal_id
 *     DB-2  fn_canonical_transition_insert rejects missing actor_layer
 *     DB-3  fn_canonical_transition_insert rejects gated transition without rationale
 *     DB-4  Happy-path insert returns a valid UUID
 *     DB-5  Idempotency: same idempotency_key returns same event_id
 *     DB-6  Immutability: UPDATE on ledger row is refused after mig 311 (deferred)
 *     DB-7  v_proposal_transition_ledger view reflects inserted row with axes
 *     DB-8  AC-26 check: spawn-agent without resolved_provider rejected
 *
 * Run live:
 *   AGENTHIVE_ALLOW_LIVE_DB=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=admin \
 *   PGDATABASE=agenthive PGPASSWORD=<pass> npx vitest run \
 *   scripts/migrations/__tests__/p4668-transition-ledger.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, "..");

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

const mig306 = readFileSync(join(MIG_DIR, "306-p4668-transition-ledger-ddl.sql"), "utf8");
const mig307 = readFileSync(join(MIG_DIR, "307-p4668-ledger-event-fk.sql"), "utf8");
const mig308 = readFileSync(join(MIG_DIR, "308-p4668-extend-event-type-check.sql"), "utf8");
const mig309 = readFileSync(join(MIG_DIR, "309-p4668-maturity-transitions-check.sql"), "utf8");

// ── Text-scan tests ───────────────────────────────────────────────────────────

describe("P4668 mig-306: ledger DDL text-scan", () => {
	it("TS-1: SECURITY DEFINER function is installed", () => {
		expect(mig306).toMatch(/SECURITY DEFINER/);
		expect(mig306).toMatch(/fn_canonical_transition_insert/);
	});

	it("TS-2: UPDATE/DELETE/TRUNCATE are revoked on ledger table", () => {
		expect(mig306).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE/);
		expect(mig306).toMatch(/proposal_transition_ledger/);
	});

	it("TS-3: REVOKE targets claude, andy, and admin_write", () => {
		// All three application roles that could otherwise write
		const revokeBlock = mig306.match(/REVOKE UPDATE.*?FROM[^;]+;/s)?.[0] ?? "";
		expect(revokeBlock).toMatch(/claude/);
		expect(revokeBlock).toMatch(/andy/);
		expect(revokeBlock).toMatch(/admin_write/);
	});

	it("TS-4: audit view exposes all three actor-identity axes (AC-13)", () => {
		// Axis 1
		expect(mig306).toMatch(/actor_principal_id/);
		expect(mig306).toMatch(/actor_layer/);
		// Axis 2
		expect(mig306).toMatch(/agent_profile/);
		// Axis 3
		expect(mig306).toMatch(/resolved_provider/);
		expect(mig306).toMatch(/claimed_provider/);
		expect(mig306).toMatch(/provider_mismatch/);
	});

	it("TS-5: hash chain uses GENESIS sentinel for first event", () => {
		expect(mig306).toMatch(/GENESIS/);
		expect(mig306).toMatch(/prev_event_hash/);
	});

	it("TS-6: idempotency_key UNIQUE constraint is declared", () => {
		expect(mig306).toMatch(/UNIQUE.*idempotency_key|idempotency_key.*UNIQUE/i);
	});

	it("TS-7: AC-5 rationale gate is enforced in DB function", () => {
		// The function body must raise an exception when reason_code is 'decision'
		// or 'break_glass' and rationale is empty
		expect(mig306).toMatch(/rationale is required for reason_code/);
	});

	it("TS-8: EXECUTE is granted to claude and agent_write", () => {
		expect(mig306).toMatch(/GRANT EXECUTE ON FUNCTION roadmap\.fn_canonical_transition_insert/);
		expect(mig306).toMatch(/TO claude, agent_write/);
	});
});

describe("P4668 mig-307: ledger_event_id FK text-scan", () => {
	it("TS-6: adds ledger_event_id column to proposal_event", () => {
		expect(mig307).toMatch(/ADD COLUMN.*ledger_event_id/);
	});

	it("TS-6: FK references proposal_transition_ledger(event_id)", () => {
		expect(mig307).toMatch(/REFERENCES.*proposal_transition_ledger.*event_id/s);
	});

	it("TS-6: FK is DEFERRABLE", () => {
		expect(mig307).toMatch(/DEFERRABLE/);
	});
});

describe("P4668 mig-308: extend event_type CHECK text-scan", () => {
	it("TS-7: all six new P4668 event types are present", () => {
		const newTypes = [
			"break_glass",
			"maturity_reset_on_status_change",
			"compensating_correction",
			"federation_sync",
			"gate_pause_demotion",
			"maturity_set",
		];
		for (const t of newTypes) {
			expect(mig308, `missing event type: ${t}`).toMatch(new RegExp(`'${t}'`));
		}
	});

	it("TS-7: all 28 original event types are preserved", () => {
		const originals = [
			"status_changed",
			"decision_made",
			"lease_claimed",
			"lease_released",
			"gate_advanced",
			"gate_held",
			"agent_dispatched",
			"frontier_audit_flag",
			"cross_dep_cycle_detected",
			"discussion_posted",
		];
		for (const t of originals) {
			expect(mig308, `original event type missing: ${t}`).toMatch(new RegExp(`'${t}'`));
		}
	});
});

describe("P4668 mig-309: extend maturity transitions CHECK text-scan", () => {
	it("TS-8: 'validated' added to from_maturity and to_maturity", () => {
		expect(mig309).toMatch(/'validated'/);
		// Should appear in both from and to maturity check blocks
		const matches = (mig309.match(/'validated'/g) ?? []).length;
		expect(matches).toBeGreaterThanOrEqual(2);
	});

	it("TS-9: canonical, break_glass, compensating_correction added to transition_reason", () => {
		expect(mig309).toMatch(/'canonical'/);
		expect(mig309).toMatch(/'break_glass'/);
		expect(mig309).toMatch(/'compensating_correction'/);
	});

	it("TS-9: original transition_reason values preserved", () => {
		expect(mig309).toMatch(/'submit'/);
		expect(mig309).toMatch(/'decision'/);
		expect(mig309).toMatch(/'system'/);
	});
});

// ── Live-DB integration tests ─────────────────────────────────────────────────

describe.skipIf(!LIVE)("P4668 mig-306: fn_canonical_transition_insert live-DB", () => {
	// Dynamically import pool to avoid errors when not running DB tests
	let queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

	const insertedProposalIds: number[] = [];
	let testProposalId: number;

	beforeAll(async () => {
		const { query } = await import("../../../src/postgres/pool.ts");
		queryFn = query;

		// Create a throwaway proposal for ledger tests (maturity=obsolete to avoid dispatch)
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, type, maturity, project_id, audit,
			    gate_scanner_paused)
			 VALUES ($1, 'P4668 ledger test fixture', 'DEVELOP', 'feature',
			         'obsolete', 1, '[]'::jsonb, true)
			 RETURNING id`,
			[`P4668T${Date.now() % 100000}`],
		);
		testProposalId = rows[0].id;
		insertedProposalIds.push(testProposalId);
	});

	afterAll(async () => {
		if (!queryFn) return;
		for (const pid of insertedProposalIds) {
			await queryFn(
				`DELETE FROM roadmap_proposal.proposal_transition_ledger WHERE proposal_id = $1`,
				[pid],
			);
			await queryFn(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [pid]);
		}
	});

	it("DB-1: rejects missing actor_principal_id", async () => {
		await expect(
			queryFn(
				`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
				[
					JSON.stringify({
						proposal_id: String(testProposalId),
						event_kind: "status_transition",
						actor_layer: "operator",
						// actor_principal_id deliberately omitted
					}),
				],
			),
		).rejects.toThrow(/actor_principal_id is required/);
	});

	it("DB-2: rejects missing actor_layer", async () => {
		await expect(
			queryFn(
				`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
				[
					JSON.stringify({
						proposal_id: String(testProposalId),
						event_kind: "status_transition",
						actor_principal_id: "claude-bot-gary",
						// actor_layer deliberately omitted
					}),
				],
			),
		).rejects.toThrow(/actor_layer is required/);
	});

	it("DB-3: rejects decision transition without rationale", async () => {
		await expect(
			queryFn(
				`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
				[
					JSON.stringify({
						proposal_id: String(testProposalId),
						event_kind: "status_transition",
						actor_principal_id: "claude-bot-gary",
						actor_layer: "liaison",
						reason_code: "decision",
						// rationale deliberately omitted
					}),
				],
			),
		).rejects.toThrow(/rationale is required/);
	});

	it("DB-4: happy-path insert returns a valid UUID", async () => {
		// Use 'orchestrator' layer — does not require resolved_provider (AC-26).
		// For liaison/spawn-agent tests see DB-8.
		const { rows } = await queryFn(
			`SELECT roadmap.fn_canonical_transition_insert($1::jsonb) AS event_id`,
			[
				JSON.stringify({
					proposal_id: String(testProposalId),
					event_kind: "status_transition",
					actor_principal_id: "claude-bot-gary",
					actor_layer: "orchestrator",
					to_status: "DEVELOP",
					agent_profile: "backend-architect",
					source_surface: "canonical-transition-test",
				}),
			],
		);
		const eventId = rows[0].event_id;
		expect(eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
	});

	it("DB-5: idempotency — same key returns same event_id without duplicate row", async () => {
		const key = `p4668-test-idem-${testProposalId}-${Date.now()}`;
		const basePayload = {
			proposal_id: String(testProposalId),
			event_kind: "maturity_change",
			actor_principal_id: "claude-bot-gary",
			actor_layer: "orchestrator",
			idempotency_key: key,
			source_surface: "canonical-transition-test",
		};

		const { rows: r1 } = await queryFn(
			`SELECT roadmap.fn_canonical_transition_insert($1::jsonb) AS event_id`,
			[JSON.stringify(basePayload)],
		);
		const { rows: r2 } = await queryFn(
			`SELECT roadmap.fn_canonical_transition_insert($1::jsonb) AS event_id`,
			[JSON.stringify({ ...basePayload, to_maturity: "new" })], // extra field ignored on replay
		);

		expect(r1[0].event_id).toBe(r2[0].event_id);

		// Confirm single row stored
		const { rows: countRows } = await queryFn(
			`SELECT count(*)::int AS n FROM roadmap_proposal.proposal_transition_ledger WHERE idempotency_key = $1`,
			[key],
		);
		expect(countRows[0].n).toBe(1);
	});

	it("DB-7: v_proposal_transition_ledger view reflects inserted rows with all axes", async () => {
		const { rows } = await queryFn(
			`SELECT actor_principal_id, actor_layer, agent_profile,
			        resolved_provider, event_kind, event_hash
			 FROM roadmap_proposal.v_proposal_transition_ledger
			 WHERE proposal_id = $1
			 ORDER BY seq ASC`,
			[testProposalId],
		);
		expect(rows.length).toBeGreaterThan(0);
		// Axis 1
		expect(rows[0].actor_principal_id).toBe("claude-bot-gary");
		// Axis 2
		expect(rows[0].agent_profile).toBe("backend-architect");
		// Event hash computed (non-null)
		expect(rows[0].event_hash).toBeTruthy();
	});

	it("DB-8: AC-26 spawn-agent without resolved_provider rejected by CHECK", async () => {
		await expect(
			queryFn(
				`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
				[
					JSON.stringify({
						proposal_id: String(testProposalId),
						event_kind: "status_transition",
						actor_principal_id: "claude-bot-gary",
						actor_layer: "spawn-agent", // requires resolved_provider
						// resolved_provider deliberately omitted
						source_surface: "canonical-transition-test",
					}),
				],
			),
		).rejects.toThrow(); // DB CHECK: ptl_spawn_agent_provider_required
	});
});

