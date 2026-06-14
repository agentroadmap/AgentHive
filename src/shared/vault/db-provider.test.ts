/**
 * P1072: DB-driven vault provider — pure data-access tests with a mocked pool.
 *
 * AC-1: fetchActiveProvider reads control_credential.vault_provider.
 * AC-2: fetchCredentialRef builds vault:// refs from v_active_credentials.
 * AC-3: withPrincipal sets app.current_principal_did via SET LOCAL and
 *        commits/rolls-back on one held client.
 *
 * No live DB — a spy pool records SQL + returns canned rows. Runs in the
 * default suite.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	fetchActiveProvider,
	fetchCredentialRef,
	withPrincipal,
	type QueryablePool,
	type TxnClient,
} from "./db-provider.ts";

/** A pool that returns queued rows and records every (sql, params). */
function spyPool(queue: Array<{ rows: unknown[] }>) {
	const calls: Array<{ sql: string; params?: unknown[] }> = [];
	let i = 0;
	const pool: QueryablePool = {
		async query(sql: string, params?: unknown[]) {
			calls.push({ sql, params });
			return (queue[i++] ?? { rows: [] }) as { rows: never[] };
		},
	};
	return { pool, calls };
}

describe("fetchActiveProvider (P1072 AC-1)", () => {
	test("returns the active provider row; filters by type when given", async () => {
		const { pool, calls } = spyPool([
			{ rows: [{ id: "1", slug: "default-file", provider_type: "file", config: {} }] },
		]);
		const p = await fetchActiveProvider(pool, "file");
		assert.equal(p?.provider_type, "file");
		assert.match(calls[0].sql, /control_credential\.vault_provider/);
		assert.match(calls[0].sql, /lifecycle_status = 'active'/);
		assert.deepEqual(calls[0].params, ["file"]);
	});

	test("returns null when no active provider", async () => {
		const { pool } = spyPool([{ rows: [] }]);
		assert.equal(await fetchActiveProvider(pool), null);
	});
});

describe("fetchCredentialRef (P1072 AC-2)", () => {
	test("file provider → vault://file/<path> SecretRef", async () => {
		const { pool, calls } = spyPool([
			{ rows: [{ vault_path: "project/audiobook/dsn", provider_type: "file" }] },
		]);
		const r = await fetchCredentialRef(pool, "audiobook_dsn");
		assert.equal(r?.ref, "vault://file/project/audiobook/dsn");
		assert.equal(r?.isVaultRef, true);
		assert.match(calls[0].sql, /v_active_credentials/);
		assert.deepEqual(calls[0].params, ["audiobook_dsn"]);
	});

	test("hcp_vault → vault://hcv/, aws_secrets → vault://aws/, leading slashes trimmed", async () => {
		const hcv = spyPool([
			{ rows: [{ vault_path: "/tenants/x/dsn", provider_type: "hcp_vault" }] },
		]);
		assert.equal(
			(await fetchCredentialRef(hcv.pool, "x"))?.ref,
			"vault://hcv/tenants/x/dsn",
		);
		const aws = spyPool([
			{ rows: [{ vault_path: "agentHive/x/dsn", provider_type: "aws_secrets" }] },
		]);
		assert.equal(
			(await fetchCredentialRef(aws.pool, "x"))?.ref,
			"vault://aws/agentHive/x/dsn",
		);
	});

	test("env provider → bare env var name, isVaultRef=false", async () => {
		const { pool } = spyPool([
			{ rows: [{ vault_path: "AUDIOBOOK_DSN", provider_type: "env" }] },
		]);
		const r = await fetchCredentialRef(pool, "audiobook_dsn");
		assert.equal(r?.ref, "AUDIOBOOK_DSN");
		assert.equal(r?.isVaultRef, false);
	});

	test("unknown/inactive credential → null", async () => {
		const { pool } = spyPool([{ rows: [] }]);
		assert.equal(await fetchCredentialRef(pool, "nope"), null);
	});
});

describe("withPrincipal (P1072 AC-3)", () => {
	function spyClient() {
		const sqls: string[] = [];
		let released = false;
		const client: TxnClient = {
			async query(sql: string) {
				sqls.push(sql);
				return { rows: [] };
			},
			release() {
				released = true;
			},
		};
		return { client, sqls, isReleased: () => released };
	}

	test("BEGIN → SET LOCAL did → fn → COMMIT, then release", async () => {
		const c = spyClient();
		const pool = { connect: async () => c.client };
		const out = await withPrincipal(pool, "did:agent:alan", async () => "ok");
		assert.equal(out, "ok");
		assert.equal(c.sqls[0], "BEGIN");
		assert.match(c.sqls[1], /set_config\('app\.current_principal_did'/);
		assert.equal(c.sqls[2], "COMMIT");
		assert.ok(c.isReleased(), "client released");
	});

	test("fn throws → ROLLBACK + release + rethrow", async () => {
		const c = spyClient();
		const pool = { connect: async () => c.client };
		await assert.rejects(
			() =>
				withPrincipal(pool, "did:agent:alan", async () => {
					throw new Error("boom");
				}),
			/boom/,
		);
		assert.ok(c.sqls.includes("ROLLBACK"), "rolled back");
		assert.ok(!c.sqls.includes("COMMIT"), "did not commit");
		assert.ok(c.isReleased(), "client released even on error");
	});
});
