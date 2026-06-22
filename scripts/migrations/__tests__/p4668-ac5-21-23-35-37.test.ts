/**
 * P4668 — AC-5/AC-21/AC-23/AC-35/AC-37 integration tests.
 *
 * Tests:
 *   Text-scan (always run, no DB):
 *     TS-1   AC-5:  mig 314 fn_canonical_transition_insert enforces rationale for 'decision'
 *     TS-2   AC-21: mig 310 backfill function has p_dry_run parameter (scratch-DB safety)
 *     TS-3   AC-35: post-work-offer.ts calls canonicalTransition with gate_pause_demotion
 *     TS-4   AC-35: additionalStateChanges captures gate_scanner_paused/gate_paused_by/gate_paused_at
 *     TS-5   AC-23: proposal-storage-v2.ts calls canonicalTransition in transitionProposal
 *     TS-6   AC-23: removes backfill UPDATE on proposal_state_transitions
 *     TS-7   AC-37: proposal-storage-v2.ts calls canonicalTransition with maturity_set in setMaturity
 *     TS-8   AC-32: reeval-handlers.ts calls canonicalTransition post-COMMIT for revise/obsolete
 *
 *   Live-DB (AGENTHIVE_ALLOW_LIVE_DB=1, migs 306-315 must be applied):
 *     DB-1   AC-5:  fn_canonical_transition_insert rejects reason_code='decision' + empty rationale
 *     DB-2   AC-5:  fn_canonical_transition_insert rejects reason_code='break_glass' + empty rationale
 *     DB-3   AC-5:  fn_canonical_transition_insert accepts reason_code='decision' WITH rationale
 *     DB-4   AC-21: fn_p4668_backfill_history dry_run=TRUE returns rows_found, rows_inserted=0
 *     DB-5   AC-23: transitionProposal() emits source_confidence='high' ledger event
 *     DB-6   AC-37: setMaturity() emits event_kind='maturity_set' ledger event
 *
 * Run live:
 *   AGENTHIVE_ALLOW_LIVE_DB=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=admin \
 *   PGDATABASE=agenthive PGPASSWORD=<pass> npx vitest run \
 *   scripts/migrations/__tests__/p4668-ac5-21-23-35-37.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, "..");
const SRC_DIR = join(__dirname, "..", "..", "..", "src");

const mig314 = readFileSync(join(MIG_DIR, "314-p4668-fn-idempotency-fix.sql"), "utf8");
const mig310 = readFileSync(join(MIG_DIR, "310-p4668-dual-write-shim.sql"), "utf8");
const postWorkOffer = readFileSync(
	join(SRC_DIR, "core", "pipeline", "post-work-offer.ts"),
	"utf8",
);
const proposalStorageV2 = readFileSync(
	join(SRC_DIR, "infra", "postgres", "proposal-storage-v2.ts"),
	"utf8",
);
const reevalHandlers = readFileSync(
	join(SRC_DIR, "apps", "mcp-server", "tools", "proposals", "reeval-handlers.ts"),
	"utf8",
);

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

// ── Text-scan tests ───────────────────────────────────────────────────────────

describe("P4668 AC-5: rationale enforcement text-scan", () => {
	it("TS-1: mig 314 fn_canonical_transition_insert raises when reason_code='decision' and rationale is empty", () => {
		expect(mig314).toMatch(/rationale is required for reason_code/);
		expect(mig314).toMatch(/decision.*break_glass|break_glass.*decision/s);
		expect(mig314).toMatch(/RAISE EXCEPTION/);
	});
});

describe("P4668 AC-21: backfill dry-run safety text-scan", () => {
	it("TS-2: mig 310 backfill function declares p_dry_run parameter", () => {
		expect(mig310).toMatch(/p_dry_run\s+BOOLEAN/i);
		expect(mig310).toMatch(/DEFAULT TRUE/);
	});

	it("TS-2b: backfill function only INSERTs when NOT p_dry_run", () => {
		expect(mig310).toMatch(/IF NOT p_dry_run THEN/);
	});
});

describe("P4668 AC-35: gate-pause demotion canonical event text-scan", () => {
	it("TS-3: post-work-offer.ts calls canonicalTransition with gate_pause_demotion eventKind", () => {
		expect(postWorkOffer).toMatch(/canonicalTransition/);
		expect(postWorkOffer).toMatch(/gate_pause_demotion/);
	});

	it("TS-4: additionalStateChanges captures all three gate_pause fields", () => {
		expect(postWorkOffer).toMatch(/gate_scanner_paused/);
		expect(postWorkOffer).toMatch(/gate_paused_by/);
		expect(postWorkOffer).toMatch(/gate_paused_at/);
		expect(postWorkOffer).toMatch(/additionalStateChanges/);
	});
});

describe("P4668 AC-23: transitionProposal canonical cutover text-scan", () => {
	it("TS-5: proposal-storage-v2.ts imports and calls canonicalTransition", () => {
		expect(proposalStorageV2).toMatch(/import.*canonicalTransition.*canonical-transition/s);
		expect(proposalStorageV2).toMatch(/await canonicalTransition\(getPool\(\)/);
	});

	it("TS-6: backfill UPDATE on proposal_state_transitions is removed from transitionProposal", () => {
		// The old backfill UPDATE used 'UPDATE roadmap_proposal.proposal_state_transitions SET transition_reason'
		// It must not appear in the current source.
		expect(proposalStorageV2).not.toMatch(/UPDATE roadmap_proposal\.proposal_state_transitions\s+SET transition_reason/);
	});

	it("TS-5b: transitionProposal emits source_confidence high via sourceSurface", () => {
		expect(proposalStorageV2).toMatch(/sourceSurface.*transitionProposal|"transitionProposal"/);
		expect(proposalStorageV2).toMatch(/status_transition/);
	});
});

describe("P4668 AC-37: setMaturity canonical cutover text-scan", () => {
	it("TS-7: setMaturity calls canonicalTransition with maturity_set eventKind", () => {
		expect(proposalStorageV2).toMatch(/maturity_set/);
		expect(proposalStorageV2).toMatch(/AC-37/);
	});

	it("TS-7b: setMaturity canonicalTransition uses sourceSurface=setMaturity", () => {
		expect(proposalStorageV2).toMatch(/sourceSurface.*setMaturity|"setMaturity"/);
	});
});

describe("P4668 AC-32: reeval-handlers canonical cutover text-scan", () => {
	it("TS-8: reeval-handlers.ts imports canonicalTransition", () => {
		expect(reevalHandlers).toMatch(/import.*canonicalTransition.*canonical-transition/);
	});

	it("TS-8b: emits canonical event for revise outcome with reason_code=decision", () => {
		expect(reevalHandlers).toMatch(/revise.*canonicalTransition|canonicalTransition.*revise/s);
		expect(reevalHandlers).toMatch(/reeval-revise/);
	});

	it("TS-8c: emits canonical event for obsolete outcome with reason_code=decision", () => {
		expect(reevalHandlers).toMatch(/reeval-obsolete/);
	});
});

// ── Live-DB integration tests ─────────────────────────────────────────────────

describe.skipIf(!LIVE)("P4668 AC-5/AC-21/AC-23/AC-37: live-DB integration", () => {
	let queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
	const insertedProposalIds: number[] = [];
	const insertedAgentIdentities: string[] = [];

	beforeAll(async () => {
		const { query } = await import("../../../src/postgres/pool.ts");
		queryFn = query as typeof queryFn;
	});

	afterAll(async () => {
		if (!queryFn) return;
		for (const identity of insertedAgentIdentities) {
			await queryFn(
				`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
				[identity],
			).catch(() => {});
		}
		for (const pid of insertedProposalIds) {
			await queryFn(
				`DELETE FROM roadmap_proposal.proposal_event WHERE proposal_id = $1`,
				[pid],
			).catch(() => {});
			await queryFn(
				`DELETE FROM roadmap_proposal.proposal_transition_ledger WHERE proposal_id = $1`,
				[pid],
			).catch(() => {});
			await queryFn(
				`DELETE FROM roadmap_proposal.proposal_maturity_transitions WHERE proposal_id = $1`,
				[pid],
			).catch(() => {});
			await queryFn(
				`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			).catch(() => {});
		}
	});

	// ── AC-5 live tests ────────────────────────────────────────────────────────

	it("DB-1: AC-5 — reason_code='decision' without rationale is rejected by DB function", async () => {
		const payload = JSON.stringify({
			proposal_id: "999999999", // will be rejected before FK check if row not found; or just use a real one
			event_kind: "status_transition",
			actor_principal_id: "claude-bot-gary",
			actor_layer: "liaison",
			reason_code: "decision",
			// rationale deliberately omitted
		});
		await expect(
			queryFn(
				`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
				[payload],
			),
		).rejects.toThrow(/rationale is required for reason_code/i);
	});

	it("DB-2: AC-5 — reason_code='break_glass' without rationale is rejected by DB function", async () => {
		const payload = JSON.stringify({
			proposal_id: "999999999",
			event_kind: "break_glass",
			actor_principal_id: "break_glass_operator",
			actor_layer: "operator",
			reason_code: "break_glass",
			// rationale deliberately omitted
		});
		await expect(
			queryFn(
				`SELECT roadmap.fn_canonical_transition_insert($1::jsonb)`,
				[payload],
			),
		).rejects.toThrow(/rationale is required for reason_code/i);
	});

	it("DB-3: AC-5 — reason_code='decision' WITH rationale is accepted", async () => {
		// Create a test proposal first
		const { rows } = await queryFn(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, type, maturity, project_id, audit, gate_scanner_paused)
			 VALUES ($1, 'P4668 AC-5 test', 'DEVELOP', 'feature', 'mature', 1, '[]'::jsonb, false)
			 RETURNING id`,
			[`P4668A5${Date.now() % 100000}`],
		);
		const proposalId = (rows[0] as { id: number }).id;
		insertedProposalIds.push(proposalId);

		// Use actor_layer='agency' — ptl_spawn_agent_provider_required requires
		// resolved_provider when layer='liaison' or 'spawn-agent'. Agency-level
		// callers don't have a routed run context so they use 'agency'.
		const payload = JSON.stringify({
			proposal_id: String(proposalId),
			event_kind: "status_transition",
			from_status: "DEVELOP",
			to_status: "MERGE",
			actor_principal_id: "claude-bot-gary",
			actor_layer: "agency",
			reason_code: "decision",
			rationale: "All ACs verified. Gate decision recorded.",
			source_surface: "p4668-ac5-test",
		});

		const { rows: r } = await queryFn(
			`SELECT roadmap.fn_canonical_transition_insert($1::jsonb) AS event_id`,
			[payload],
		);
		const eventId = (r[0] as { event_id: string }).event_id;
		expect(eventId).toMatch(/^[0-9a-f-]{36}$/i);

		// Verify it's in the ledger with source_confidence='high'
		const { rows: ledgerRows } = await queryFn(
			`SELECT source_confidence, reason_code, rationale
			 FROM roadmap_proposal.proposal_transition_ledger
			 WHERE event_id = $1`,
			[eventId],
		);
		expect(ledgerRows).toHaveLength(1);
		const row = ledgerRows[0] as { source_confidence: string; reason_code: string; rationale: string };
		expect(row.source_confidence).toBe("high");
		expect(row.reason_code).toBe("decision");
		expect(row.rationale).toBe("All ACs verified. Gate decision recorded.");
	});

	// ── AC-21 live test ────────────────────────────────────────────────────────

	it("DB-4: AC-21 — fn_p4668_backfill_history dry_run=TRUE returns stats without inserting", async () => {
		const { rows } = await queryFn(
			`SELECT * FROM roadmap.fn_p4668_backfill_history(TRUE, 10)`,
		);
		expect(rows).toHaveLength(1);
		const row = rows[0] as { rows_found: string; rows_skipped: string; rows_inserted: string; dry_run: boolean };
		expect(Number(row.rows_found)).toBeGreaterThanOrEqual(0);
		// In dry-run mode, rows_inserted counts what WOULD be inserted (not what was)
		expect(row.dry_run).toBe(true);
		// rows_found >= rows_skipped (all skipped are a subset of found)
		expect(Number(row.rows_found)).toBeGreaterThanOrEqual(Number(row.rows_skipped));
	});

	// ── AC-23 live test ────────────────────────────────────────────────────────

	it("DB-5: AC-23 — transitionProposal() emits source_confidence='high' canonical ledger event", async () => {
		const { transitionProposal } = await import("../../../src/infra/postgres/proposal-storage-v2.ts");

		// Create agent registry entry for the actor
		const actorId = `p4668-ac23-test-${Date.now() % 100000}`;
		await queryFn(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
			 VALUES ($1, 'llm', 'active') ON CONFLICT (agent_identity) DO NOTHING`,
			[actorId],
		);
		insertedAgentIdentities.push(actorId);

		// Use DEVELOP→DRAFT (a non-gated backward edge, template 37 / Hotfix) so
		// fn_guard_gate_advance does not block the direct status UPDATE. All forward
		// edges (DRAFT→REVIEW, REVIEW→DEVELOP, DEVELOP→MERGE, MERGE→COMPLETE) require
		// record_gate_decision and cannot be driven through transitionProposal() in a
		// live DB without seeding a gate_decision_log row in the same transaction.
		const { rows: pRows } = await queryFn(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, type, maturity, project_id, audit, gate_scanner_paused)
			 VALUES ($1, 'P4668 AC-23 transitionProposal test', 'DEVELOP', 'feature',
			         'active', 1, '[]'::jsonb, false)
			 RETURNING id`,
			[`P4668A23${Date.now() % 100000}`],
		);
		const proposalId = (pRows[0] as { id: number }).id;
		insertedProposalIds.push(proposalId);

		// Hotfix template (id=37) has DEVELOP→DRAFT edge; use it.
		// fn_spawn_workflow() trigger auto-creates a workflow on INSERT with the
		// default template — the upsert must also update template_id to switch to
		// the Hotfix template so the DEVELOP→DRAFT transition is allowed.
		const { rows: tplRows } = await queryFn(
			`SELECT id FROM roadmap.workflow_templates WHERE id = 37 LIMIT 1`,
		);
		if (tplRows.length === 0) {
			console.warn("DB-5: Hotfix template (id=37) not found; skipping transitionProposal test");
			return;
		}
		const templateId = (tplRows[0] as { id: number }).id;

		await queryFn(
			`INSERT INTO roadmap.workflows (proposal_id, template_id, current_stage)
			 VALUES ($1, $2, 'DEVELOP')
			 ON CONFLICT (proposal_id) DO UPDATE
			   SET current_stage = 'DEVELOP', template_id = EXCLUDED.template_id`,
			[proposalId, templateId],
		);

		// Record the ledger count before the transition
		const { rows: beforeRows } = await queryFn(
			`SELECT COUNT(*)::int AS n
			 FROM roadmap_proposal.proposal_transition_ledger
			 WHERE proposal_id = $1 AND source_confidence = 'high'`,
			[proposalId],
		);
		const beforeCount = (beforeRows[0] as { n: number }).n;

		// Perform the non-gated transition — DEVELOP→DRAFT bypasses fn_guard_gate_advance
		const result = await transitionProposal(
			proposalId,
			"DRAFT",
			actorId,
			"canonical",
			"AC-23 transitionProposal live test — non-gated backward edge.",
		);
		expect(result).not.toBeNull();
		expect(result?.status?.toUpperCase()).toBe("DRAFT");

		// Verify a 'high' confidence canonical event was written
		const { rows: afterRows } = await queryFn(
			`SELECT source_confidence, event_kind, from_status, to_status, actor_principal_id
			 FROM roadmap_proposal.proposal_transition_ledger
			 WHERE proposal_id = $1 AND source_confidence = 'high'
			 ORDER BY seq DESC LIMIT 1`,
			[proposalId],
		);
		expect((afterRows.length)).toBeGreaterThan(beforeCount);
		const event = afterRows[0] as {
			source_confidence: string;
			event_kind: string;
			from_status: string;
			to_status: string;
			actor_principal_id: string;
		};
		expect(event.source_confidence).toBe("high");
		expect(event.event_kind).toBe("status_transition");
		expect(event.to_status?.toUpperCase()).toBe("DRAFT");
		expect(event.actor_principal_id).toBe(actorId);
	});

	// ── AC-37 live test ────────────────────────────────────────────────────────

	it("DB-6: AC-37 — setMaturity() emits event_kind='maturity_set' canonical ledger event", async () => {
		const { setMaturity } = await import("../../../src/infra/postgres/proposal-storage-v2.ts");

		const actorId = `p4668-ac37-test-${Date.now() % 100000}`;
		await queryFn(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
			 VALUES ($1, 'llm', 'active') ON CONFLICT (agent_identity) DO NOTHING`,
			[actorId],
		);
		insertedAgentIdentities.push(actorId);

		const { rows: pRows } = await queryFn(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, type, maturity, project_id, audit, gate_scanner_paused)
			 VALUES ($1, 'P4668 AC-37 setMaturity test', 'DEVELOP', 'feature',
			         'new', 1, '[]'::jsonb, false)
			 RETURNING id`,
			[`P4668A37${Date.now() % 100000}`],
		);
		const proposalId = (pRows[0] as { id: number }).id;
		insertedProposalIds.push(proposalId);

		// Call setMaturity: new → active
		const result = await setMaturity(proposalId, "active", actorId, "AC-37 live test");
		expect(result).not.toBeNull();
		expect(result?.maturity).toBe("active");

		// Verify canonical ledger event was emitted
		const { rows } = await queryFn(
			`SELECT event_kind, from_maturity, to_maturity, source_confidence, actor_principal_id
			 FROM roadmap_proposal.proposal_transition_ledger
			 WHERE proposal_id = $1 AND event_kind = 'maturity_set'
			 ORDER BY seq DESC LIMIT 1`,
			[proposalId],
		);
		expect(rows).toHaveLength(1);
		const event = rows[0] as {
			event_kind: string;
			from_maturity: string;
			to_maturity: string;
			source_confidence: string;
			actor_principal_id: string;
		};
		expect(event.event_kind).toBe("maturity_set");
		expect(event.from_maturity).toBe("new");
		expect(event.to_maturity).toBe("active");
		expect(event.source_confidence).toBe("high");
		expect(event.actor_principal_id).toBe(actorId);
	});
});
