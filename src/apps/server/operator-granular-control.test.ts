/**
 * P4509 — integration tests for granular destructive-control authorization,
 * the backward-compat token backfill, and audit evidence.
 *
 * These exercise the LIVE local DB (roadmap.operator_token /
 * roadmap.operator_audit_log). Every row created is tagged with a unique
 * prefix and deleted in `after()`.
 *
 * Run (live):
 *   AGENTHIVE_ALLOW_LIVE_DB=1 PGPORT=5432 PGPASSWORD=... \
 *     node --import jiti/register --test src/apps/server/operator-granular-control.test.ts
 *
 * Skipped automatically unless AGENTHIVE_ALLOW_LIVE_DB=1.
 */

import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { strict as assert } from "assert";
import { query } from "../../infra/postgres/pool.ts";
import { GRANULAR_CONTROL_ACTIONS } from "./operator-actions.ts";
import { authorizeOperatorByToken } from "./operator-auth.ts";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";
const RUN = LIVE ? test : test.skip;

const PREFIX = `p4509-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sha256 = (s: string) =>
	createHash("sha256").update(s, "utf8").digest("hex");
const insertedTokenIds: number[] = [];

async function insertToken(opts: {
	label: string;
	allowedActions: string[];
	expiresAt?: string | null;
	revokedAt?: string | null;
	scopedProjectId?: number | null;
}): Promise<{ id: number; rawToken: string }> {
	const rawToken = `${PREFIX}-${opts.label}`;
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap.operator_token
		   (operator_name, token_sha256, allowed_actions, expires_at, revoked_at, scoped_project_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		[
			`${PREFIX}-${opts.label}`,
			sha256(rawToken),
			opts.allowedActions,
			opts.expiresAt ?? null,
			opts.revokedAt ?? null,
			opts.scopedProjectId ?? null,
		],
	);
	insertedTokenIds.push(rows[0].id);
	return { id: rows[0].id, rawToken };
}

async function latestAudit(tokenId: number): Promise<{
	decision: string;
	action: string;
	target_kind: string | null;
	response_status: number | null;
	failure_reason: string | null;
	request_summary: Record<string, unknown>;
} | null> {
	const { rows } = await query<{
		decision: string;
		action: string;
		target_kind: string | null;
		response_status: number | null;
		failure_reason: string | null;
		request_summary: Record<string, unknown>;
	}>(
		`SELECT decision, action, target_kind, response_status, failure_reason, request_summary
		   FROM roadmap.operator_audit_log
		  WHERE token_id = $1
		  ORDER BY id DESC LIMIT 1`,
		[tokenId],
	);
	return rows[0] ?? null;
}

after(async () => {
	// Clean up audit rows then tokens (FK is ON DELETE SET NULL but we created
	// these rows so we remove them too).
	if (insertedTokenIds.length > 0) {
		await query(
			`DELETE FROM roadmap.operator_audit_log WHERE token_id = ANY($1::bigint[])`,
			[insertedTokenIds],
		);
		await query(
			`DELETE FROM roadmap.operator_token WHERE id = ANY($1::bigint[])`,
			[insertedTokenIds],
		);
	}
	// Backfill-simulation rows created by the AC-3 test (operator_name prefix).
	await query(
		`DELETE FROM roadmap.operator_token WHERE operator_name LIKE $1`,
		[`${PREFIX}-bf-%`],
	);
	// Belt-and-braces: audit rows whose token_id was NULLed by the FK ON DELETE
	// SET NULL above still carry our operator_name prefix — sweep them by name so
	// no tagged test rows linger in the live DB.
	await query(
		`DELETE FROM roadmap.operator_audit_log WHERE operator_name LIKE $1`,
		[`${PREFIX}-%`],
	);
});

// ── AC-5: least-privilege matrix ─────────────────────────────────────────────
RUN(
	"AC-5: a single granular-action token allows only its matching action, denies the other four",
	async () => {
		for (const owned of GRANULAR_CONTROL_ACTIONS) {
			const { rawToken } = await insertToken({
				label: `lp-${owned}`,
				allowedActions: [owned],
			});
			// matching action → allow
			const allow = await authorizeOperatorByToken(rawToken, { action: owned });
			assert.equal(
				allow.decision,
				"allow",
				`${owned} token should allow ${owned}`,
			);
			// other four → deny 403
			for (const other of GRANULAR_CONTROL_ACTIONS) {
				if (other === owned) continue;
				const deny = await authorizeOperatorByToken(rawToken, {
					action: other,
				});
				assert.equal(
					deny.decision,
					"deny",
					`${owned} token must DENY ${other}`,
				);
				assert.equal(deny.httpStatus, 403);
			}
			// also denies generic control.stop
			const denyStop = await authorizeOperatorByToken(rawToken, {
				action: "control.stop",
			});
			assert.equal(
				denyStop.decision,
				"deny",
				`${owned} token must DENY control.stop`,
			);
		}
	},
);

// ── AC-4: backward compat — control.stop-only token reaches generic stop only ─
RUN(
	"AC-4: newly-issued control.stop-only token accesses generic stop only, not granular",
	async () => {
		const { rawToken } = await insertToken({
			label: "stop-only",
			allowedActions: ["control.stop"],
		});
		const stop = await authorizeOperatorByToken(rawToken, {
			action: "control.stop",
		});
		assert.equal(
			stop.decision,
			"allow",
			"control.stop token should allow generic stop",
		);
		for (const g of GRANULAR_CONTROL_ACTIONS) {
			const r = await authorizeOperatorByToken(rawToken, { action: g });
			assert.equal(
				r.decision,
				"deny",
				`control.stop-only token must DENY ${g}`,
			);
		}
	},
);

// ── AC-3/AC-4: backfill expands pre-existing control.stop tokens ──────────────
RUN(
	"AC-3: backfill is idempotent, additive, and preserves owner/expiry; expanded token then reaches all five",
	async () => {
		const granular = [...GRANULAR_CONTROL_ACTIONS];
		const expiry = "2999-01-01T00:00:00Z";
		// pre-migration token: control.stop + an unrelated scope, with an expiry + owner.
		const rawToken = `${PREFIX}-bf-pre`;
		const { rows: ins } = await query<{ id: number }>(
			`INSERT INTO roadmap.operator_token (operator_name, token_sha256, allowed_actions, expires_at)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
			[
				`${PREFIX}-bf-owner`,
				sha256(rawToken),
				["control.stop", "audit.read"],
				expiry,
			],
		);
		const id = ins[0].id;

		// Apply the backfill UPDATE EXACTLY as migration 316 does, scoped to our row.
		const runBackfill = async () =>
			query<{ id: number }>(
				`WITH updated AS (
			   UPDATE roadmap.operator_token t
			      SET allowed_actions = (
			            SELECT array_agg(DISTINCT a ORDER BY a)
			              FROM unnest(t.allowed_actions || $2::text[]) AS a)
			    WHERE t.id = $1
			      AND 'control.stop' = ANY(t.allowed_actions)
			      AND NOT ('*' = ANY(t.allowed_actions))
			      AND NOT (t.allowed_actions @> $2::text[])
			    RETURNING t.id)
			 SELECT id FROM updated`,
				[id, granular],
			);

		const first = await runBackfill();
		assert.equal(
			first.rows.length,
			1,
			"first backfill should expand exactly this row",
		);
		const second = await runBackfill();
		assert.equal(
			second.rows.length,
			0,
			"second backfill must be a no-op (idempotent)",
		);

		const { rows: after } = await query<{
			allowed_actions: string[];
			expires_at: string;
			operator_name: string;
		}>(
			`SELECT allowed_actions, expires_at, operator_name FROM roadmap.operator_token WHERE id = $1`,
			[id],
		);
		const row = after[0];
		for (const g of granular)
			assert.ok(row.allowed_actions.includes(g), `should contain ${g}`);
		assert.ok(
			row.allowed_actions.includes("control.stop"),
			"control.stop retained (additive)",
		);
		assert.ok(
			row.allowed_actions.includes("audit.read"),
			"unrelated scope retained (additive)",
		);
		assert.equal(row.operator_name, `${PREFIX}-bf-owner`, "owner unchanged");
		assert.equal(
			new Date(row.expires_at).getTime(),
			new Date(expiry).getTime(),
			"expiry unchanged",
		);

		// AC-4: the expanded pre-migration token now reaches all five endpoints.
		for (const action of [...granular, "control.stop"]) {
			const r = await authorizeOperatorByToken(rawToken, { action });
			assert.equal(
				r.decision,
				"allow",
				`expanded token should allow ${action}`,
			);
		}
	},
);

// ── AC-6: wildcard matrix + concentrated-credential audit ─────────────────────
RUN(
	"AC-6: wildcard token reaches all five AND emits concentrated-credential audit marker",
	async () => {
		const { id, rawToken } = await insertToken({
			label: "wildcard",
			allowedActions: ["*"],
		});
		for (const action of [...GRANULAR_CONTROL_ACTIONS, "control.stop"]) {
			const r = await authorizeOperatorByToken(rawToken, {
				action,
				targetKind: "host",
				targetIdentity: "h1",
			});
			assert.equal(r.decision, "allow", `wildcard should allow ${action}`);
			const audit = await latestAudit(id);
			assert.ok(audit, "audit row should exist");
			assert.equal(audit!.decision, "allow");
			assert.equal(
				audit!.request_summary?.wildcard_concentrated_credential,
				true,
				`wildcard use of ${action} should mark concentrated_credential`,
			);
			assert.equal(audit!.request_summary?.authorized_via, "wildcard");
		}
	},
);

RUN(
	"AC-6/AC-8: granular token records authorized_via=granular and target scope, no secret",
	async () => {
		const { id, rawToken } = await insertToken({
			label: "granular-audit",
			allowedActions: ["drain-host"],
		});
		const r = await authorizeOperatorByToken(rawToken, {
			action: "drain-host",
			targetKind: "host",
			targetIdentity: "host-xyz",
		});
		assert.equal(r.decision, "allow");
		const audit = await latestAudit(id);
		assert.equal(audit!.request_summary?.authorized_via, "granular");
		assert.ok(
			!("wildcard_concentrated_credential" in (audit!.request_summary ?? {})),
		);
		assert.equal(audit!.target_kind, "host");
		// secret never logged: the raw token must not appear anywhere in the audit row.
		const blob = JSON.stringify(audit);
		assert.ok(
			!blob.includes(rawToken),
			"audit row must not contain the token secret",
		);
	},
);

// ── AC-8: deny calls are audited too ─────────────────────────────────────────
RUN(
	"AC-8: denied call writes an audit row with decision=deny and the canonical action",
	async () => {
		const { id, rawToken } = await insertToken({
			label: "deny-audit",
			allowedActions: ["suspend-agency"],
		});
		const r = await authorizeOperatorByToken(rawToken, {
			action: "terminate-worker",
			targetKind: "worker",
			targetIdentity: "w9",
		});
		assert.equal(r.decision, "deny");
		const audit = await latestAudit(id);
		assert.equal(audit!.decision, "deny");
		assert.equal(audit!.action, "terminate-worker");
		assert.equal(audit!.target_kind, "worker");
		assert.ok((audit!.response_status ?? 0) === 403);
	},
);

// ── AC-11: expired / revoked / scope mismatch ────────────────────────────────
RUN("AC-11: expired token is denied", async () => {
	const { rawToken } = await insertToken({
		label: "expired",
		allowedActions: ["drain-host"],
		expiresAt: "2000-01-01T00:00:00Z",
	});
	const r = await authorizeOperatorByToken(rawToken, { action: "drain-host" });
	assert.equal(r.decision, "deny");
	assert.ok(r.failureReason?.toLowerCase().includes("expired"));
});

RUN("AC-11: revoked token is denied", async () => {
	const { rawToken } = await insertToken({
		label: "revoked",
		allowedActions: ["drain-host"],
		revokedAt: "2020-01-01T00:00:00Z",
	});
	const r = await authorizeOperatorByToken(rawToken, { action: "drain-host" });
	assert.equal(r.decision, "deny");
	assert.ok(r.failureReason?.toLowerCase().includes("revoked"));
});

RUN("AC-11: unrecognized token is denied (401), not allowed", async () => {
	const r = await authorizeOperatorByToken(`${PREFIX}-does-not-exist`, {
		action: "drain-host",
	});
	assert.equal(r.decision, "deny");
	assert.equal(r.httpStatus, 401);
});

RUN(
	"AC-11: project-scope mismatch denies even with matching granular action",
	async () => {
		const { rawToken } = await insertToken({
			label: "scoped",
			allowedActions: ["cancel-dispatch"],
			scopedProjectId: 1,
		});
		const r = await authorizeOperatorByToken(rawToken, {
			action: "cancel-dispatch",
			targetProjectId: 999999,
		});
		assert.equal(r.decision, "deny");
		assert.ok(r.failureReason?.toLowerCase().includes("project scope"));
	},
);
