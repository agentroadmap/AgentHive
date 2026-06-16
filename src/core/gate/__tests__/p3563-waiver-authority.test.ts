import assert from "node:assert";
import { describe, test, before, after } from "node:test";

/**
 * P3563 AC-7 (Pillar-4): checkWaiverAuthority against the test DB.
 *
 * Asserts that setting an AC to status='waived' is NOT a silent skip:
 *   - waive without reason            → rejected (WAIVE_REASON_REQUIRED)
 *   - waive without operator_token    → rejected (WAIVE_AUTHORITY_REQUIRED)
 *   - waive by unauthorized token     → rejected (WAIVE_TOKEN_NOT_AUTHORIZED)
 *   - waive with reason + authorized  → recorded (blocked:false)
 *   - flag OFF                        → any waive allowed (pre-P3563 unchanged)
 *
 * Auth mechanism REUSED: roadmap.operator_token via authorizeOperatorByToken
 * (P3508/P3565) — the same genuine, audited operator-token path used for
 * elevated gate actions. Self-asserted trust_tier is deliberately NOT trusted.
 *
 * Requires the throwaway DB (PGDATABASE=agenthive_p3563_test) with the
 * operator_token + operator_audit_log tables (DDL 022) present. Gated by
 * AGENTHIVE_RESOLVER_DB_TEST=1.
 *
 * Run:
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive_p3563_test \
 *     node --import jiti/register --test \
 *     src/core/gate/__tests__/p3563-waiver-authority.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

describe("P3563 AC-7: checkWaiverAuthority (verify_ac waive)", { skip: !DB_TEST }, () => {
	let query: any;
	let checkWaiverAuthority: any;
	let hashOperatorToken: any;

	// Distinct raw tokens for this test run.
	const TOK_WILDCARD = "p3563-ac7-wildcard-token";   // allowed_actions = {*}
	const TOK_SCOPED = "p3563-ac7-scoped-token";        // allowed_actions = {some_other_action}
	const TOK_REVOKED = "p3563-ac7-revoked-token";      // revoked

	const PID = 999999001; // synthetic audit target id (no FK on operator_audit_log target)

	before(async () => {
		({ query } = await import("../../../postgres/pool.ts"));
		({ checkWaiverAuthority } = await import("../verifier-independence.ts"));
		({ hashOperatorToken } = await import("../../../apps/server/operator-auth.ts"));

		// Seed operator tokens.
		await query(
			`INSERT INTO roadmap.operator_token (operator_name, token_sha256, allowed_actions)
			 VALUES ('p3563-ac7-op', $1, ARRAY['*']::text[])
			 ON CONFLICT (token_sha256) DO UPDATE SET allowed_actions = EXCLUDED.allowed_actions, revoked_at = NULL`,
			[hashOperatorToken(TOK_WILDCARD)],
		);
		await query(
			`INSERT INTO roadmap.operator_token (operator_name, token_sha256, allowed_actions)
			 VALUES ('p3563-ac7-op-scoped', $1, ARRAY['some_other_action']::text[])
			 ON CONFLICT (token_sha256) DO UPDATE SET allowed_actions = EXCLUDED.allowed_actions, revoked_at = NULL`,
			[hashOperatorToken(TOK_SCOPED)],
		);
		await query(
			`INSERT INTO roadmap.operator_token (operator_name, token_sha256, allowed_actions, revoked_at)
			 VALUES ('p3563-ac7-op-revoked', $1, ARRAY['*']::text[], now())
			 ON CONFLICT (token_sha256) DO UPDATE SET revoked_at = now()`,
			[hashOperatorToken(TOK_REVOKED)],
		);
	});

	after(async () => {
		try {
			await query(
				`DELETE FROM roadmap.operator_token WHERE operator_name LIKE 'p3563-ac7-op%'`,
			);
			await query(
				`DELETE FROM roadmap.operator_audit_log WHERE target_identity = $1`,
				[String(PID)],
			).catch(() => {});
		} catch { /* best-effort */ }
	});

	function args(over: Record<string, any> = {}) {
		return {
			reason: "operator-approved skip: covered by P9999 integration suite",
			operatorToken: TOK_WILDCARD,
			proposalId: PID,
			itemNumber: 3,
			verifier: "some-builder-agent",
			...over,
		};
	}

	// ── Flag ON cases ────────────────────────────────────────────────────────

	describe("flag ON", () => {
		before(() => {
			process.env.AGENTHIVE_GATE_AC_INVARIANT_ENABLED = "1";
		});

		test("AC-7 case 1: waive WITHOUT reason → rejected (WAIVE_REASON_REQUIRED)", async () => {
			const r = await checkWaiverAuthority(args({ reason: "   " }));
			assert.strictEqual(r.blocked, true, "empty reason must be rejected");
			assert.strictEqual(r.code, "WAIVE_REASON_REQUIRED");
		});

		test("AC-7 case 1b: waive with undefined reason → rejected", async () => {
			const r = await checkWaiverAuthority(args({ reason: undefined }));
			assert.strictEqual(r.blocked, true);
			assert.strictEqual(r.code, "WAIVE_REASON_REQUIRED");
		});

		test("AC-7 case 2: waive WITHOUT operator_token → rejected (WAIVE_AUTHORITY_REQUIRED)", async () => {
			const r = await checkWaiverAuthority(args({ operatorToken: undefined }));
			assert.strictEqual(r.blocked, true, "missing token must be rejected");
			assert.strictEqual(r.code, "WAIVE_AUTHORITY_REQUIRED");
		});

		test("AC-7 case 2b: waive by UNAUTHORIZED token (action not allowed) → rejected", async () => {
			const r = await checkWaiverAuthority(args({ operatorToken: TOK_SCOPED }));
			assert.strictEqual(r.blocked, true, "token lacking verify_ac_waive must be rejected");
			assert.strictEqual(r.code, "WAIVE_TOKEN_NOT_AUTHORIZED");
		});

		test("AC-7 case 2c: waive by REVOKED token → rejected", async () => {
			const r = await checkWaiverAuthority(args({ operatorToken: TOK_REVOKED }));
			assert.strictEqual(r.blocked, true, "revoked token must be rejected");
			assert.strictEqual(r.code, "WAIVE_TOKEN_NOT_AUTHORIZED");
		});

		test("AC-7 case 2d: waive by UNKNOWN token → rejected", async () => {
			const r = await checkWaiverAuthority(args({ operatorToken: "no-such-token-xyz" }));
			assert.strictEqual(r.blocked, true, "unknown token must be rejected");
			assert.strictEqual(r.code, "WAIVE_TOKEN_NOT_AUTHORIZED");
		});

		test("AC-7 case 3: waive with reason + AUTHORIZED token → recorded (blocked:false)", async () => {
			const r = await checkWaiverAuthority(args());
			assert.strictEqual(r.blocked, false, "reason + authorized token must be allowed");
			assert.ok(r.tokenId != null, "authorized waive should carry the operator token id");
		});

		test("AC-7 case 3b: reason via verification_notes path (handler maps it to reason) → recorded", async () => {
			// The handler passes (waive_reason ?? verification_notes) as `reason`.
			const r = await checkWaiverAuthority(args({ reason: "non-empty via notes" }));
			assert.strictEqual(r.blocked, false);
		});
	});

	// ── Flag OFF case ────────────────────────────────────────────────────────

	describe("flag OFF", () => {
		before(() => {
			process.env.AGENTHIVE_GATE_AC_INVARIANT_ENABLED = "0";
		});
		after(() => {
			delete process.env.AGENTHIVE_GATE_AC_INVARIANT_ENABLED;
		});

		test("AC-7 case 4: flag OFF → any waive allowed (no reason, no token) — pre-P3563 unchanged", async () => {
			const r = await checkWaiverAuthority({
				reason: undefined,
				operatorToken: undefined,
				proposalId: PID,
				itemNumber: 3,
				verifier: "some-builder-agent",
			});
			assert.strictEqual(r.blocked, false, "flag OFF must preserve permissive behavior");
		});
	});
});
