#!/usr/bin/env node
/**
 * P477 AC-7: bootstrap script for control-plane operator tokens.
 *
 * The web endpoint POST /api/operator/tokens is itself locked behind
 * requireOperator(action='token.issue'), so the first token must be
 * issued out-of-band. This script does that: it talks directly to
 * Postgres using the standard pool (env or ~/.agenthive.env), prints
 * the plaintext token once, and stores only its sha256.
 *
 * Usage:
 *   npm run operator:issue -- --name=gary
 *   npm run operator:issue -- --name=gary --allowed='*'
 *   npm run operator:issue -- --name=ops-bot --allowed=agent.message,audit.read
 *   npm run operator:list
 *   npm run operator:revoke -- --id=3 --reason="rotation"
 *
 * P4509 — granular destructive-control scopes (least privilege):
 *   suspend-agency    POST /api/operator/control/suspend-agency
 *   drain-host        POST /api/operator/control/drain-host
 *   cancel-dispatch   POST /api/operator/control/cancel-dispatch
 *   terminate-worker  POST /api/operator/control/terminate-worker
 *   control.stop      POST /api/operator/control/stop (generic stop ONLY)
 * `control.stop` is NOT a parent scope: an exact-match control.stop grant no
 * longer reaches the four granular endpoints. Grant exactly what is needed, or
 * use '*' for full powers (audited as a concentrated credential). Pre-P4509
 * control.stop tokens are expanded to also carry the four granular actions by
 * migration 316-p4509-operator-granular-control-backfill.sql. To move a token
 * to least privilege, re-issue it with only the granular scope(s) it needs.
 *   e.g.  npm run operator:issue -- --name=drain-bot --allowed=drain-host
 */
import { createHash, randomUUID } from "node:crypto";
import {
	GRANULAR_CONTROL_ACTIONS,
	validateAllowedActions,
} from "../src/apps/server/operator-actions.ts";
import { query } from "../src/infra/postgres/pool.ts";

function arg(name: string): string | undefined {
	const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const idx = process.argv.indexOf(`--${name}`);
	if (
		idx >= 0 &&
		process.argv[idx + 1] &&
		!process.argv[idx + 1].startsWith("--")
	) {
		return process.argv[idx + 1];
	}
	return undefined;
}

async function issue() {
	const name = arg("name");
	if (!name) {
		console.error("--name is required");
		process.exit(2);
	}
	const allowedRaw = arg("allowed") ?? "*";
	const allowedList = allowedRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// P4509 AC-2: same shared validator the API uses — reject typos at issue time.
	const validation = validateAllowedActions(allowedList);
	if (!validation.ok) {
		console.error(validation.message);
		console.error(
			`granular control actions: ${GRANULAR_CONTROL_ACTIONS.join(", ")}`,
		);
		process.exit(2);
	}
	const allowed = validation.actions;
	const expires = arg("expires") ?? null;
	const notes = arg("notes") ?? null;

	const raw = `op_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
	const sha = createHash("sha256").update(raw, "utf8").digest("hex");
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap.operator_token
		   (operator_name, token_sha256, allowed_actions, expires_at, notes)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[name, sha, allowed, expires, notes],
	);
	console.log("issued operator token");
	console.log("  id            :", rows[0]?.id);
	console.log("  operator_name :", name);
	console.log("  allowed       :", allowed.join(","));
	if (expires) console.log("  expires_at    :", expires);
	console.log("");
	console.log("  TOKEN (shown once, store securely):");
	console.log("    " + raw);
	console.log("");
	console.log("  Use as:  Authorization: Bearer " + raw);
}

async function list() {
	const { rows } = await query(
		`SELECT id, operator_name, allowed_actions, expires_at, revoked_at,
		        created_at, last_used_at, notes
		   FROM roadmap.operator_token
		  ORDER BY id ASC`,
	);
	if (rows.length === 0) {
		console.log("(no operator tokens)");
		return;
	}
	for (const r of rows) {
		const status = r.revoked_at
			? "REVOKED"
			: r.expires_at && new Date(r.expires_at as string).getTime() <= Date.now()
				? "EXPIRED"
				: "active";
		console.log(
			`#${r.id}  ${r.operator_name}  [${status}]  allowed=${(r.allowed_actions as string[]).join(",")}  last_used=${r.last_used_at ?? "-"}`,
		);
	}
}

async function revoke() {
	const id = arg("id");
	if (!id) {
		console.error("--id is required");
		process.exit(2);
	}
	const reason = arg("reason") ?? null;
	const { rows } = await query<{ id: number; operator_name: string }>(
		`UPDATE roadmap.operator_token
		    SET revoked_at = now(),
		        notes = COALESCE(notes, '') ||
		                CASE WHEN $2::text IS NULL THEN '' ELSE E'\nrevoked: ' || $2::text END
		  WHERE id = $1 AND revoked_at IS NULL
		  RETURNING id, operator_name`,
		[Number(id), reason],
	);
	if (rows.length === 0) {
		console.log(`token #${id} not found or already revoked`);
		return;
	}
	console.log(`revoked token #${rows[0].id} (${rows[0].operator_name})`);
}

async function main() {
	const cmd = process.argv[2];
	switch (cmd) {
		case "issue":
			await issue();
			break;
		case "list":
			await list();
			break;
		case "revoke":
			await revoke();
			break;
		default:
			console.error(
				"usage: operator-token.ts <issue|list|revoke> [--name=...]",
			);
			process.exit(2);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
