/**
 * P1072: sync→async getVault() cutover + DB-driven provider selection.
 *
 * Covers the LIVE-WIRING ACs against a mocked control pool (no live DB):
 *   AC-19  initVaultFromDb() honours AGENTHIVE_VAULT_KIND as a hard override.
 *   AC-1   initVaultFromDb() selects the active provider row from DB.
 *   AC-10  DB ready → functional adapter; AC-24 DB error → file fallback, warn.
 *   AC-18  idempotent + concurrency-safe (memoized promise).
 *   AC-20  getVaultSync() returns a functional adapter without init.
 *   AC-21  buildSecretRef() pure mapping.
 *   AC-22  mapProviderTypeToKind() pure mapping.
 *
 * The control pool is a spy: query() returns canned vault_provider rows. We
 * never import pool-registry, so no real DB connection is attempted — the
 * getControlPool getter is injected.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	buildSecretRef,
	mapProviderTypeToKind,
	getVault,
	getVaultSync,
	initVaultFromDb,
	__resetVaultInitForTest,
} from "./index.ts";
import type { QueryablePool } from "./db-provider.ts";

/** A control pool that returns one vault_provider row (or none / throws). */
function providerPool(
	row: { id: string; slug: string; provider_type: string; config?: unknown } | null,
	opts: { throwOnQuery?: boolean } = {},
): QueryablePool {
	return {
		async query<R>() {
			if (opts.throwOnQuery) throw new Error("control pool down");
			return { rows: (row ? [row] : []) as R[] };
		},
	};
}

const ENV_KEY = "AGENTHIVE_VAULT_KIND";
let savedKind: string | undefined;
let savedRoot: string | undefined;

beforeEach(() => {
	savedKind = process.env[ENV_KEY];
	savedRoot = process.env.AGENTHIVE_VAULT_ROOT;
	// Keep file-vault from touching real paths during build.
	process.env.AGENTHIVE_VAULT_ROOT = "/tmp/p1072-vault-test-root";
	delete process.env[ENV_KEY];
	__resetVaultInitForTest();
});

afterEach(() => {
	if (savedKind === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedKind;
	if (savedRoot === undefined) delete process.env.AGENTHIVE_VAULT_ROOT;
	else process.env.AGENTHIVE_VAULT_ROOT = savedRoot;
	__resetVaultInitForTest();
});

describe("mapProviderTypeToKind (AC-22)", () => {
	test("file→file, hcp_vault→hcv, aws_secrets→aws, env→env", () => {
		assert.equal(mapProviderTypeToKind("file"), "file");
		assert.equal(mapProviderTypeToKind("hcp_vault"), "hcv");
		assert.equal(mapProviderTypeToKind("aws_secrets"), "aws");
		assert.equal(mapProviderTypeToKind("env"), "env");
	});
});

describe("buildSecretRef (AC-21)", () => {
	test("scheme mapping + leading-slash trim; env→null", () => {
		assert.equal(buildSecretRef("file", "project/x/dsn"), "vault://file/project/x/dsn");
		assert.equal(buildSecretRef("hcp_vault", "/tenants/x/dsn"), "vault://hcv/tenants/x/dsn");
		assert.equal(buildSecretRef("aws_secrets", "agentHive/x"), "vault://aws/agentHive/x");
		assert.equal(buildSecretRef("env", "AUDIOBOOK_DSN"), null);
	});
});

describe("getVaultSync (AC-20)", () => {
	test("returns a functional adapter without init; does not throw", () => {
		const v = getVaultSync();
		assert.equal(typeof v.read, "function");
		assert.equal(typeof v.write, "function");
		assert.equal(typeof v.exists, "function");
	});
});

describe("initVaultFromDb env override (AC-19)", () => {
	test("AGENTHIVE_VAULT_KIND set → skips DB lookup entirely", async () => {
		process.env[ENV_KEY] = "file";
		let queried = false;
		const pool: QueryablePool = {
			async query<R>() {
				queried = true;
				return { rows: [] as R[] };
			},
		};
		const v = await initVaultFromDb(() => pool);
		assert.equal(queried, false, "DB must NOT be queried when env override set");
		assert.equal(typeof v.read, "function");
	});
});

describe("initVaultFromDb DB selection (AC-1, AC-10)", () => {
	test("active file provider → functional adapter, no throw", async () => {
		const pool = providerPool({ id: "1", slug: "default-file", provider_type: "file" });
		const v = await initVaultFromDb(() => pool);
		assert.equal(typeof v.read, "function");
		// getVaultSync now reflects the DB-selected adapter.
		assert.strictEqual(getVaultSync(), v);
	});

	test("no active provider row → env/file fallback, non-fatal", async () => {
		const v = await initVaultFromDb(() => providerPool(null));
		assert.equal(typeof v.read, "function");
	});
});

describe("initVaultFromDb error fallback (AC-24)", () => {
	test("control pool throws → returns file fallback, no uncaught", async () => {
		const v = await initVaultFromDb(() => providerPool(null, { throwOnQuery: true }));
		assert.equal(typeof v.read, "function");
	});

	test("getControlPool getter itself throws → fallback", async () => {
		const v = await initVaultFromDb(() => {
			throw new Error("PGPASSWORD missing");
		});
		assert.equal(typeof v.read, "function");
	});
});

describe("initVaultFromDb idempotency + concurrency (AC-18)", () => {
	test("concurrent calls await the same promise; DB queried once", async () => {
		let queryCount = 0;
		const pool: QueryablePool = {
			async query<R>() {
				queryCount++;
				return { rows: [{ id: "1", slug: "f", provider_type: "file" }] as R[] };
			},
		};
		const [a, b] = await Promise.all([
			initVaultFromDb(() => pool),
			initVaultFromDb(() => pool),
		]);
		assert.strictEqual(a, b, "same adapter instance");
		// Second + third call after settle are no-ops.
		const c = await initVaultFromDb(() => pool);
		assert.strictEqual(a, c);
		assert.equal(queryCount, 1, "DB queried exactly once");
	});
});

describe("getVault async accessor (cutover)", () => {
	test("getVault() returns a Promise resolving to a functional adapter", async () => {
		const p = getVault();
		assert.equal(typeof (p as Promise<unknown>).then, "function", "getVault() is async");
		const v = await p;
		assert.equal(typeof v.read, "function");
	});

	test("getVault() reuses the init promise started by initVaultFromDb", async () => {
		const pool = providerPool({ id: "1", slug: "f", provider_type: "file" });
		const a = await initVaultFromDb(() => pool);
		const b = await getVault();
		assert.strictEqual(a, b);
	});
});
