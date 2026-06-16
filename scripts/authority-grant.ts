#!/usr/bin/env node
/**
 * P1391 AC-13: minimal grant-issuance CLI for delegated gate authority.
 *
 * A DELEGATED PERMANENT AGENT may originate a `reject` gate verdict (or a
 * prop_set_maturity('obsolete')) ONLY when it holds an ACTIVE row in
 * roadmap.authority_grant with scope_category IN ('gate_reject','proposal_obsolete').
 * This script lets a human operator issue / list / revoke those grants
 * out-of-band (the grant table starts empty; trust_tier alone is NOT sufficient).
 *
 * A5 (do-not-wedge): the live gate deciders run at trust_tier='restricted', so
 * the ONLY way they keep deciding reject is via these grants. Seed at least the
 * standing reject-capable gate identity once before enabling the flag, e.g.:
 *   npm run authority:grant -- issue \
 *     --grantee=<gate-agent-identity> --grantor=gary \
 *     --scope=gate_reject --level=authority --reason="standing D2/D4 reject seat"
 *
 * Usage:
 *   npm run authority:grant -- issue --grantee=ID --grantor=ID --scope=gate_reject [--level=authority] [--ref=...] [--expires=ISO] [--reason=...]
 *   npm run authority:grant -- list [--grantee=ID]
 *   npm run authority:grant -- revoke --id=N [--reason=...]
 */
import { query } from "../src/infra/postgres/pool.ts";

function arg(name: string): string | undefined {
	const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const idx = process.argv.indexOf(`--${name}`);
	if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
		return process.argv[idx + 1];
	}
	return undefined;
}

const VALID_SCOPES = ["gate_reject", "proposal_obsolete"];

async function issue() {
	const grantee = arg("grantee");
	const grantor = arg("grantor");
	const scope = arg("scope");
	if (!grantee || !grantor || !scope) {
		console.error("--grantee, --grantor and --scope are required");
		process.exit(2);
	}
	if (!VALID_SCOPES.includes(scope)) {
		console.error(`--scope must be one of: ${VALID_SCOPES.join(", ")}`);
		process.exit(2);
	}
	const level = arg("level") ?? "authority"; // ag_level_check: authority|trusted|known
	const ref = arg("ref") ?? null;
	const expires = arg("expires") ?? null;
	const reason = arg("reason") ?? null;
	const canOverride = arg("can-override") === "true";

	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap.authority_grant
		   (grantor_id, grantee_id, scope_category, scope_ref, authority_level,
		    can_override, reason, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id`,
		[grantor, grantee, scope, ref, level, canOverride, reason, expires],
	);
	console.log("issued authority_grant");
	console.log("  id            :", rows[0]?.id);
	console.log("  grantee_id    :", grantee);
	console.log("  grantor_id    :", grantor);
	console.log("  scope_category:", scope);
	console.log("  authority_lvl :", level);
	if (expires) console.log("  expires_at    :", expires);
	console.log("");
	console.log("  The grantee may now originate a delegated", scope, "(frontier model + structured reference still required for reject).");
}

async function list() {
	const grantee = arg("grantee");
	const { rows } = await query(
		`SELECT id, grantor_id, grantee_id, scope_category, scope_ref,
		        authority_level, can_override, reason, expires_at, revoked_at, created_at
		   FROM roadmap.authority_grant
		  ${grantee ? "WHERE grantee_id = $1" : ""}
		  ORDER BY id ASC`,
		grantee ? [grantee] : [],
	);
	if (rows.length === 0) {
		console.log("(no authority grants)");
		return;
	}
	for (const r of rows) {
		const status = r.revoked_at
			? "REVOKED"
			: r.expires_at && new Date(r.expires_at as string).getTime() <= Date.now()
				? "EXPIRED"
				: "active";
		console.log(
			`#${r.id}  ${r.grantee_id}  [${status}]  scope=${r.scope_category}  level=${r.authority_level}  by=${r.grantor_id}`,
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
	const { rows } = await query<{ id: number; grantee_id: string }>(
		`UPDATE roadmap.authority_grant
		    SET revoked_at = now(),
		        reason = COALESCE(reason, '') ||
		                 CASE WHEN $2::text IS NULL THEN '' ELSE E'\nrevoked: ' || $2::text END
		  WHERE id = $1 AND revoked_at IS NULL
		  RETURNING id, grantee_id`,
		[Number(id), reason],
	);
	if (rows.length === 0) {
		console.log(`grant #${id} not found or already revoked`);
		return;
	}
	console.log(`revoked grant #${rows[0].id} (grantee ${rows[0].grantee_id})`);
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
			console.error("usage: authority-grant.ts <issue|list|revoke> [--grantee=...] [--scope=gate_reject|proposal_obsolete]");
			process.exit(2);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
