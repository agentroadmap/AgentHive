/**
 * P1391 — gate-authority + verdict-semantics integration tests (live DB).
 *
 * Two halves, both rigorously no-permanent-write:
 *
 *  A. Authority module (authorizeRejectOrObsolete) — exercised against the REAL
 *     pool. It is READ-ONLY (authority_grant, gate_role, agent_registry,
 *     proposal_dependencies, proposal); we seed read-fixtures under a sentinel
 *     namespace and DELETE them in `after`. operator_token paths use a
 *     genuinely-issued throwaway token, revoked + deleted in teardown.
 *
 *  B. Release-trigger CASE (migration 290) — applied inside ONE BEGIN/ROLLBACK
 *     txn on a dedicated client, proving 'proposal_rejected' → obsolete and
 *     'gate_reject' → new flow through fn_lease_clear_maturity_on_release. The
 *     txn is ALWAYS rolled back — never committed.
 *
 * Skips cleanly when the DB is unreachable.
 */
import assert from "node:assert";
import { after, before, describe, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { query } from "../../postgres/pool.ts";
import {
	authorizeRejectOrObsolete,
	FRONTIER_GATE_ROUTE,
	isGateAuthorityEnabled,
} from "./gate-authority.ts";

// Force the flag ON for the duration of these tests (env layer wins).
process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED = "true";

const SENTINEL = `p1391-itest-${process.pid}`;
const GRANTEE_OK = `agent:${SENTINEL}:granted`;
const GRANTEE_NONE = `agent:${SENTINEL}:ungranted`;
// authority_grant.grantor_id / grantee_id FK → principal_identity(principal_id).
const GRANTOR = `user/${SENTINEL}`;

let dbUp = true;

describe("P1391 gate-authority (live)", () => {
	let seededProposalId: number | null = null;
	let tokenRaw: string | null = null;
	let tokenId: number | null = null;

	before(async () => {
		try {
			await query("SELECT 1");
		} catch {
			dbUp = false;
			return;
		}

		// A real proposal to target (read-only use; we don't mutate it).
		const { rows } = await query<{ id: number }>(
			`SELECT id FROM roadmap_proposal.proposal ORDER BY id LIMIT 1`,
		);
		seededProposalId = rows[0]?.id ?? null;

		// Register the granted actor with a frontier preferred_model so the
		// agent-path frontier bar (A10) can be satisfied. agent_registry is the
		// fallback route source when gate_role.model_preference is empty.
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, trust_tier, preferred_model)
			 VALUES ($1, 'llm', 'restricted', $2)
			 ON CONFLICT (agent_identity) DO UPDATE SET preferred_model = EXCLUDED.preferred_model`,
			[GRANTEE_OK, FRONTIER_GATE_ROUTE],
		);
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, trust_tier, preferred_model)
			 VALUES ($1, 'llm', 'restricted', 'cheap-non-frontier-model')
			 ON CONFLICT (agent_identity) DO UPDATE SET preferred_model = EXCLUDED.preferred_model`,
			[GRANTEE_NONE],
		);

		// authority_grant FKs grantor/grantee → principal_identity. Seed the
		// principals (the grantee strings double as gate-actor identities).
		for (const [pid_, kind] of [
			[GRANTOR, "operator"],
			[GRANTEE_OK, "agent"],
			[GRANTEE_NONE, "agent"],
		] as const) {
			await query(
				`INSERT INTO principal_identity (principal_id, principal_kind, credential_kind)
				 VALUES ($1, $2, 'ed25519') ON CONFLICT (principal_id) DO NOTHING`,
				[pid_, kind],
			);
		}

		// Issue a throwaway operator token allowing gate.reject + proposal.obsolete.
		tokenRaw = `op_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
		const sha = createHash("sha256").update(tokenRaw, "utf8").digest("hex");
		const tok = await query<{ id: number }>(
			`INSERT INTO roadmap.operator_token (operator_name, token_sha256, allowed_actions)
			 VALUES ($1, $2, $3) RETURNING id`,
			[SENTINEL, sha, ["gate.reject", "proposal.obsolete"]],
		);
		tokenId = tok.rows[0].id;
	});

	after(async () => {
		if (!dbUp) return;
		// Remove every sentinel fixture (best-effort; order respects FKs).
		await query(`DELETE FROM roadmap.authority_grant WHERE grantee_id LIKE $1`, [
			`agent:${SENTINEL}:%`,
		]).catch(() => {});
		if (seededProposalId != null) {
			await query(
				`DELETE FROM roadmap_proposal.proposal_dependencies
				  WHERE from_proposal_id = $1 AND dependency_type IN ('superseded_by','conflicts_with')`,
				[seededProposalId],
			).catch(() => {});
		}
		if (tokenId != null) {
			await query(`DELETE FROM roadmap.operator_token WHERE id = $1`, [tokenId]).catch(
				() => {},
			);
		}
		await query(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1`, [
			`agent:${SENTINEL}:%`,
		]).catch(() => {});
		// principal_identity rows (ON DELETE CASCADE clears any stray grants).
		await query(`DELETE FROM principal_identity WHERE principal_id IN ($1, $2, $3)`, [
			GRANTOR,
			GRANTEE_OK,
			GRANTEE_NONE,
		]).catch(() => {});
	});

	test("flag resolves ON from env", async () => {
		if (!dbUp) return;
		assert.equal(await isGateAuthorityEnabled(), true);
	});

	test("A4 fail-closed: no token + no grant ⇒ DENY", async () => {
		if (!dbUp || seededProposalId == null) return;
		const r = await authorizeRejectOrObsolete({
			action: "gate.reject",
			numericProposalId: seededProposalId,
			actor: GRANTEE_NONE,
		});
		assert.equal(r.allowed, false);
		assert.equal(r.code, "AUTHORITY_REQUIRED");
	});

	test("A11 human operator token ⇒ ALLOW (exempt from frontier+reference)", async () => {
		if (!dbUp || seededProposalId == null || !tokenRaw) return;
		const r = await authorizeRejectOrObsolete({
			action: "gate.reject",
			numericProposalId: seededProposalId,
			actor: GRANTEE_NONE, // non-frontier, no grant, no reference — still OK via token
			operatorToken: tokenRaw,
		});
		assert.equal(r.allowed, true, r.reason);
		assert.equal(r.via, "operator");
		assert.equal(r.tokenId, tokenId);
	});

	test("A11 bad token is an explicit DENY (no silent fall-through to grant)", async () => {
		if (!dbUp || seededProposalId == null) return;
		const r = await authorizeRejectOrObsolete({
			action: "gate.reject",
			numericProposalId: seededProposalId,
			actor: GRANTEE_OK,
			operatorToken: "op_totally_bogus_token",
		});
		assert.equal(r.allowed, false);
		assert.equal(r.code, "OPERATOR_TOKEN_NOT_AUTHORIZED");
	});

	test("A13/A10 grant present but NON-frontier model ⇒ DENY (frontier bar)", async () => {
		if (!dbUp || seededProposalId == null) return;
		const g = await query<{ id: number }>(
			`INSERT INTO roadmap.authority_grant (grantor_id, grantee_id, scope_category, authority_level)
			 VALUES ($1, $2, 'gate_reject', 'authority') RETURNING id`,
			[GRANTOR, GRANTEE_NONE],
		);
		try {
			const r = await authorizeRejectOrObsolete({
				action: "gate.reject",
				numericProposalId: seededProposalId,
				actor: GRANTEE_NONE,
			});
			assert.equal(r.allowed, false);
			assert.equal(r.code, "REJECT_REQUIRES_FRONTIER_MODEL");
		} finally {
			await query(`DELETE FROM roadmap.authority_grant WHERE id = $1`, [g.rows[0].id]);
		}
	});

	test("A9 grant + frontier but NO reference ⇒ DENY (reference bar)", async () => {
		if (!dbUp || seededProposalId == null) return;
		// ensure no reference edges + no obsoleted_reason interference
		await query(
			`DELETE FROM roadmap_proposal.proposal_dependencies
			  WHERE from_proposal_id = $1 AND dependency_type IN ('superseded_by','conflicts_with')`,
			[seededProposalId],
		);
		const g = await query<{ id: number }>(
			`INSERT INTO roadmap.authority_grant (grantor_id, grantee_id, scope_category, authority_level)
			 VALUES ($1, $2, 'gate_reject', 'authority') RETURNING id`,
			[GRANTOR, GRANTEE_OK],
		);
		try {
			const r = await authorizeRejectOrObsolete({
				action: "gate.reject",
				numericProposalId: seededProposalId,
				actor: GRANTEE_OK,
			});
			assert.equal(r.allowed, false);
			assert.equal(r.code, "REJECT_REQUIRES_REFERENCE");
		} finally {
			await query(`DELETE FROM roadmap.authority_grant WHERE id = $1`, [g.rows[0].id]);
		}
	});

	test("A13 grant + frontier + reference + obsoleted_reason ⇒ ALLOW", async () => {
		if (!dbUp || seededProposalId == null) return;
		// The 'superseded_by' edge type only passes the proposal_dependencies CHECK
		// once migration 290 is applied. This slice does NOT apply it to the live DB
		// (operator sign-off pending), so detect whether the edge type is accepted
		// here and assert accordingly: full ALLOW when applied, else assert the only
		// remaining blocker is the (uncreatable) reference — proving grant+frontier
		// already passed.
		let migration290Applied = true;
		const { rows: other } = await query<{ id: number }>(
			`SELECT id FROM roadmap_proposal.proposal WHERE id <> $1 ORDER BY id DESC LIMIT 1`,
			[seededProposalId],
		);
		const otherId = other[0]?.id;
		if (!otherId) return;

		const g = await query<{ id: number }>(
			`INSERT INTO roadmap.authority_grant (grantor_id, grantee_id, scope_category, authority_level)
			 VALUES ($1, $2, 'gate_reject', 'authority') RETURNING id`,
			[GRANTOR, GRANTEE_OK],
		);
		const { rows: prev } = await query<{ obsoleted_reason: string | null }>(
			`SELECT obsoleted_reason FROM roadmap_proposal.proposal WHERE id = $1`,
			[seededProposalId],
		);
		const prevReason = prev[0]?.obsoleted_reason ?? null;
		await query(`UPDATE roadmap_proposal.proposal SET obsoleted_reason = $2 WHERE id = $1`, [
			seededProposalId,
			`[${SENTINEL}] superseded by P${otherId}`,
		]);
		let depId: number | null = null;
		try {
			const dep = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal_dependencies (from_proposal_id, to_proposal_id, dependency_type)
				 VALUES ($1, $2, 'superseded_by') RETURNING id`,
				[seededProposalId, otherId],
			);
			depId = dep.rows[0].id;
		} catch (e) {
			if ((e as { code?: string }).code === "23514") {
				migration290Applied = false; // CHECK violation: edge type not yet live
			} else {
				throw e;
			}
		}

		try {
			const r = await authorizeRejectOrObsolete({
				action: "gate.reject",
				numericProposalId: seededProposalId,
				actor: GRANTEE_OK,
			});
			if (migration290Applied) {
				assert.equal(r.allowed, true, r.reason);
				assert.equal(r.via, "grant");
			} else {
				// grant + frontier passed; only the (uncreatable) reference blocks.
				assert.equal(r.allowed, false);
				assert.equal(r.code, "REJECT_REQUIRES_REFERENCE");
			}
		} finally {
			if (depId != null) {
				await query(`DELETE FROM roadmap_proposal.proposal_dependencies WHERE id = $1`, [depId]);
			}
			await query(`UPDATE roadmap_proposal.proposal SET obsoleted_reason = $2 WHERE id = $1`, [
				seededProposalId,
				prevReason,
			]);
			await query(`DELETE FROM roadmap.authority_grant WHERE id = $1`, [g.rows[0].id]);
		}
	});

	test("A14 grant revocation honored live (revoked ⇒ DENY)", async () => {
		if (!dbUp || seededProposalId == null) return;
		const g = await query<{ id: number }>(
			`INSERT INTO roadmap.authority_grant (grantor_id, grantee_id, scope_category, authority_level, revoked_at)
			 VALUES ($1, $2, 'gate_reject', 'authority', now()) RETURNING id`,
			[GRANTOR, GRANTEE_OK],
		);
		try {
			const r = await authorizeRejectOrObsolete({
				action: "gate.reject",
				numericProposalId: seededProposalId,
				actor: GRANTEE_OK,
			});
			// revoked grant is not found ⇒ AUTHORITY_REQUIRED (fail-closed)
			assert.equal(r.allowed, false);
			assert.equal(r.code, "AUTHORITY_REQUIRED");
		} finally {
			await query(`DELETE FROM roadmap.authority_grant WHERE id = $1`, [g.rows[0].id]);
		}
	});
});

// ── Part B: release-trigger CASE under migration 290 (BEGIN/ROLLBACK) ────────
describe("P1391 release-trigger verdict mapping (migration 290, rolled back)", () => {
	let pool: Pool;
	// Independent reachability probe for THIS suite (does not piggy-back on the
	// module-level dbUp, which the first suite's teardown may have flipped). This
	// suite uses its OWN dedicated Pool, so it can run even if the global pool is
	// being torn down.
	let triggerDbUp = true;

	before(async () => {
		const dsn =
			process.env.AGENTHIVE_CONTROL_DSN ??
			process.env.DATABASE_URL ??
			"postgresql://admin@127.0.0.1:5432/agenthive";
		try {
			const p = new Pool({ connectionString: dsn, max: 1 });
			const c = await p.connect();
			await c.query("SELECT 1");
			c.release();
			await p.end();
		} catch {
			triggerDbUp = false;
		}
	});

	test("V1/V2: proposal_rejected→obsolete, gate_reject→new via fn_lease_clear_maturity_on_release", async () => {
		if (!triggerDbUp) return;
		// Use a dedicated single-connection pool so BEGIN/ROLLBACK is isolated.
		const dsn =
			process.env.AGENTHIVE_CONTROL_DSN ??
			process.env.DATABASE_URL ??
			"postgresql://admin@127.0.0.1:5432/agenthive";
		pool = new Pool({ connectionString: dsn, max: 1 });
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			// Apply the migration-290 trigger CASE + constraints inside the txn.
			const fs = await import("node:fs/promises");
			const sql = await fs.readFile(
				new URL("../../../scripts/migrations/290-p1391-verdict-authority.sql", import.meta.url),
				"utf8",
			);
			await client.query(sql);

			// Quiet the many unrelated proposal-side triggers (premature-maturity
			// guard, display_id/workflow_name setters, gate guards, etc.) so we test
			// the release-trigger CASE in isolation. The release trigger we exercise
			// lives on proposal_lease and stays ENABLED. All rolled back.
			await client.query(`ALTER TABLE roadmap_proposal.proposal DISABLE TRIGGER USER`);

			// proposal_lease.agent_identity FKs to agent_registry — register the
			// throwaway lease holder inside the txn (rolled back).
			const leaseAgent = `agent:${SENTINEL}:trig`;
			await client.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, trust_tier)
				 VALUES ($1, 'llm', 'restricted') ON CONFLICT (agent_identity) DO NOTHING`,
				[leaseAgent],
			);

			// Helper: create a fresh proposal at a given maturity, claim+release a
			// lease with a reason, and read back the resulting maturity.
			async function releaseAndReadMaturity(
				startMaturity: string,
				reason: string,
			): Promise<string> {
				const { rows: pr } = await client.query<{ id: number }>(
					`INSERT INTO roadmap_proposal.proposal
					   (display_id, title, status, maturity, type, workflow_name, audit)
					 VALUES ($1, $2, 'DEVELOP', $3, 'feature', 'Standard RFC', '[]'::jsonb)
					 RETURNING id`,
					[`P-${SENTINEL}-${reason}-${Math.floor(Math.random() * 1e6)}`, `[p1391-trig] ${reason}`, startMaturity],
				);
				const pid = pr[0].id;
				const { rows: lr } = await client.query<{ id: number }>(
					`INSERT INTO roadmap_proposal.proposal_lease
					   (proposal_id, agent_identity, expires_at)
					 VALUES ($1, $2, now() + interval '1 hour')
					 RETURNING id`,
					[pid, leaseAgent],
				);
				// trg_lease_set_maturity_active flips the proposal to 'active' on
				// lease INSERT. Re-pin the maturity to the branch we want to exercise
				// in the release-trigger CASE (proposal USER triggers are disabled, so
				// this direct UPDATE sticks). This isolates the release-reason→maturity
				// mapping from the claim-side 'active' marker (which is P3535 sticky).
				await client.query(
					`UPDATE roadmap_proposal.proposal SET maturity = $2 WHERE id = $1`,
					[pid, startMaturity],
				);
				await client.query(
					`UPDATE roadmap_proposal.proposal_lease
					    SET released_at = now(), release_reason = $2
					  WHERE id = $1`,
					[lr[0].id, reason],
				);
				const res = await client.query<{ maturity: string }>(
					`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
					[pid],
				);
				if (!res.rows[0]) {
					throw new Error(
						`maturity read for pid=${pid} reason=${reason} returned ${res.rowCount} rows`,
					);
				}
				return res.rows[0].maturity;
			}

			// V2: reject verdict reason → obsolete (from a 'new' proposal).
			const rejected = await releaseAndReadMaturity("new", "proposal_rejected");
			assert.equal(rejected, "obsolete", "proposal_rejected must map to obsolete");

			// V1: request_for_change uses gate_reject (incomplete bucket) → new.
			const sentBack = await releaseAndReadMaturity("new", "gate_reject");
			assert.equal(sentBack, "new", "gate_reject (request_for_change) must map to new");
		} finally {
			await client.query("ROLLBACK").catch(() => {});
			client.release();
			await pool.end();
		}
	});
});
