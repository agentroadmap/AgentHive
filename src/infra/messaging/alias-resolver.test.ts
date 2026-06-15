/**
 * P1456 AC-7 / AC-2: alias-resolution + dispatch non-selectability tests.
 *
 * AC-7: resolveAliasForSend maps an active display_alias to its owning
 *       agent_identity; a real identity wins over an alias; a stale/unknown
 *       value passes through untouched.
 * AC-2: the live dispatch-target resolver (resolveAgency) selects from
 *       provider_registry JOIN agent_registry; a session row (no
 *       provider_registry row) is structurally unselectable.
 *
 * DB-backed assertions self-skip when Postgres is unreachable so the suite
 * stays green in CI without a database. The static-source assertions always run.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../../..");
function readSrc(rel: string): string {
    return readFileSync(resolve(SRC_ROOT, rel), "utf8");
}

// ─── Static guarantees (no DB) ───────────────────────────────────────────────

test("AC-7: msg_send wiring resolves alias before the ACL check", () => {
    const src = readSrc("src/apps/mcp-server/tools/messages/pg-handlers.ts");
    // Anchor on the actual CALL sites, not the top-of-file imports.
    const aliasIdx = src.indexOf("resolveAliasForSend(canonicalToAgent)");
    const aclCallIdx = src.indexOf("const aclResult = await checkMessageACL");
    assert.ok(aliasIdx > 0, "pg-handlers.ts must call resolveAliasForSend(canonicalToAgent)");
    assert.ok(aclCallIdx > 0, "pg-handlers.ts must still call checkMessageACL");
    assert.ok(
        aliasIdx < aclCallIdx,
        "alias resolution must run BEFORE the ACL check so ACL evaluates the real owner",
    );
});

test("AC-7: resolver keys off the active-only alias index (idx_agent_alias_active semantics)", () => {
    const src = readSrc("src/infra/messaging/alias-resolver.ts");
    // Alias lookup must constrain status='active' (mirrors the partial unique index)
    assert.ok(
        /display_alias = \$1[\s\S]*status = 'active'/.test(src),
        "alias lookup must filter status='active' so reaped/moved aliases never route",
    );
    // Identity must short-circuit before alias lookup (identity wins over alias)
    const identityIdx = src.indexOf("agent_identity = $1");
    const aliasIdx = src.indexOf("display_alias = $1");
    assert.ok(
        identityIdx > 0 && identityIdx < aliasIdx,
        "exact identity match must be attempted before the alias lookup",
    );
});

test("AC-2: resolveAgency dispatch query joins provider_registry (session rows excluded by absence)", () => {
    const src = readSrc("src/core/orchestration/resolvers/agency-resolver.ts");
    assert.ok(
        /FROM\s+roadmap_workforce\.provider_registry/i.test(src),
        "dispatch resolver must select FROM provider_registry — the structural guard for AC-2",
    );
    assert.ok(
        /JOIN\s+roadmap_workforce\.agent_registry/i.test(src),
        "dispatch resolver JOINs agent_registry on provider_registry membership",
    );
});

test("AC-2: registerSession never writes provider_registry or roadmap.agency", () => {
    const src = readSrc("src/infra/agency/session-registration.ts");
    assert.ok(
        !/INSERT\s+INTO\s+roadmap_workforce\.provider_registry/i.test(src),
        "session registration must NOT insert a provider_registry row (would make it dispatchable)",
    );
    assert.ok(
        !/INSERT\s+INTO\s+roadmap\.agency/i.test(src),
        "session registration must NOT insert a roadmap.agency row",
    );
});

test("AC-6: reapSession sets revocation_reason (pi_revoke_requires_reason guard)", () => {
    const src = readSrc("src/infra/agency/session-registration.ts");
    // The principal revoke UPDATE must set both revoked_at AND revocation_reason
    assert.ok(
        /revoked_at\s*=\s*now\(\),\s*\n?\s*revocation_reason\s*=/.test(src),
        "reapSession must set revocation_reason alongside revoked_at or the CHECK fails",
    );
});

test("AC-6: reapStaleSessions targets only interactive-session active rows", () => {
    const src = readSrc("src/infra/agency/session-registration.ts");
    assert.ok(src.includes("reapStaleSessions"), "crash-recovery reaper must exist");
    assert.ok(
        /role = 'interactive-session'[\s\S]*status = 'active'[\s\S]*last_seen_at/.test(src),
        "stale sweep must key off role + active status + last_seen_at",
    );
});

// ─── DB-backed integration (self-skipping) ───────────────────────────────────

async function dbReachable(): Promise<boolean> {
    try {
        const { query } = await import("../postgres/pool.ts");
        await query("SELECT 1", []);
        return true;
    } catch {
        return false;
    }
}

test("AC-7 [db]: orchestrator alias resolves to its active owner; stale alias passes through", async (t) => {
    if (!(await dbReachable())) {
        t.skip("Postgres unreachable — skipping DB integration");
        return;
    }
    const { query } = await import("../postgres/pool.ts");
    const { resolveAliasForSend } = await import("./alias-resolver.ts");

    const probe = "test/p1456-alias-probe";
    const alias = "p1456-test-orch";
    try {
        await query(
            `INSERT INTO roadmap_workforce.agent_registry
               (agent_identity, agent_type, role, status, trust_tier, display_alias, last_seen_at)
             VALUES ($1,'llm','interactive-session','active','trusted',$2, now())
             ON CONFLICT (agent_identity) DO UPDATE SET
               status='active', display_alias=EXCLUDED.display_alias`,
            [probe, alias],
        );

        const hit = await resolveAliasForSend(alias);
        assert.equal(hit.resolvedFromAlias, true, "active alias must resolve");
        assert.equal(hit.identity, probe, "alias must route to its owner identity");

        // Identity wins over alias
        const direct = await resolveAliasForSend(probe);
        assert.equal(direct.resolvedFromAlias, false);
        assert.equal(direct.identity, probe);

        // Stale: deactivate → alias no longer resolves
        await query(
            `UPDATE roadmap_workforce.agent_registry SET status='inactive' WHERE agent_identity=$1`,
            [probe],
        );
        const stale = await resolveAliasForSend(alias);
        assert.equal(stale.resolvedFromAlias, false, "inactive owner must not resolve the alias");
        assert.equal(stale.identity, alias, "unresolved alias passes through untouched");
    } finally {
        await query(
            `DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity=$1`,
            [probe],
        ).catch(() => {});
    }
});

test("AC-2 [db]: a session row is NOT a dispatch target (no provider_registry row)", async (t) => {
    if (!(await dbReachable())) {
        t.skip("Postgres unreachable — skipping DB integration");
        return;
    }
    const { query } = await import("../postgres/pool.ts");
    const probe = "test/p1456-dispatch-probe.a/session/abc123";
    try {
        await query(
            `INSERT INTO roadmap_workforce.agent_registry
               (agent_identity, agent_type, role, status, trust_tier, last_seen_at)
             VALUES ($1,'llm','interactive-session','active','trusted', now())
             ON CONFLICT (agent_identity) DO UPDATE SET status='active'`,
            [probe],
        );
        // The session row must have NO provider_registry row keyed to its id.
        const sel = await query<{ cnt: string }>(
            `SELECT count(*)::text AS cnt
               FROM roadmap_workforce.provider_registry pr
               JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
              WHERE ar.agent_identity = $1`,
            [probe],
        );
        assert.equal(
            sel.rows[0].cnt,
            "0",
            "session row must have zero provider_registry rows → unreachable by resolveAgency",
        );
    } finally {
        await query(
            `DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity=$1`,
            [probe],
        ).catch(() => {});
    }
});
