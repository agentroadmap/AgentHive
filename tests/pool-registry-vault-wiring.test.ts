/**
 * P515 AC-6: pool-registry vault wiring tests.
 *
 * Exercises the REAL createBridgeAdapter / getVault / setVault exports from
 * src/postgres/pool-registry.ts (not a local re-implementation):
 *   1. vault:// scheme refs route to the shared vault chooser
 *   2. plain env var refs fall back to process.env (backward compatible)
 *   3. missing env var produces a clear error
 *   4. AC-6 graceful degradation: vault outage leaves plain env refs working,
 *      while vault:// refs surface the backend error
 *   5. getVault() lazily builds the bridge; setVault() overrides it
 *
 * Hermetic: no DB, no filesystem vault, no network.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createBridgeAdapter,
	getVault,
	setVault,
	type VaultInterface,
} from "../src/postgres/pool-registry.ts";

const ENV_KEY = "P515_TEST_DSN";

afterEach(() => {
	delete process.env[ENV_KEY];
});

describe("createBridgeAdapter (P515 AC-6)", () => {
	it("routes vault:// refs to the shared vault adapter", async () => {
		const calls: string[] = [];
		const stub: VaultInterface = {
			async read(ref: string) {
				calls.push(ref);
				return "postgresql://vault:pw@host/db";
			},
		};
		const bridge = createBridgeAdapter(stub);
		const dsn = await bridge.read("vault://file/project/test/dsn");
		assert.equal(dsn, "postgresql://vault:pw@host/db");
		assert.deepEqual(calls, ["vault://file/project/test/dsn"]);
	});

	it("reads plain refs from process.env without consulting the vault", async () => {
		process.env[ENV_KEY] = "postgresql://env:pw@host/envdb";
		let vaultTouched = false;
		const stub: VaultInterface = {
			async read() {
				vaultTouched = true;
				return "never";
			},
		};
		const bridge = createBridgeAdapter(stub);
		const dsn = await bridge.read(ENV_KEY);
		assert.equal(dsn, "postgresql://env:pw@host/envdb");
		assert.equal(vaultTouched, false);
	});

	it("throws a clear error for a missing plain env ref", async () => {
		const bridge = createBridgeAdapter({
			async read() {
				return "unused";
			},
		});
		await assert.rejects(
			() => bridge.read(ENV_KEY),
			(err: Error) => err.message.includes(ENV_KEY),
		);
	});

	it("AC-6: vault outage degrades gracefully — env refs work, vault:// refs surface the error", async () => {
		process.env[ENV_KEY] = "postgresql://legacy:pw@host/legacy";
		const downVault: VaultInterface = {
			async read() {
				throw new Error("vault backend unavailable");
			},
		};
		const bridge = createBridgeAdapter(downVault);

		// Plain env ref still resolves while the vault is down.
		assert.equal(await bridge.read(ENV_KEY), "postgresql://legacy:pw@host/legacy");

		// vault:// ref fails loudly with the backend error, not a silent fallback.
		await assert.rejects(
			() => bridge.read("vault://hcv/tenants/test/dsn"),
			/vault backend unavailable/,
		);
	});
});

describe("getVault / setVault wiring (P515 AC-6)", () => {
	it("setVault() override is returned by getVault()", async () => {
		const custom: VaultInterface = {
			async read() {
				return "postgresql://custom:pw@host/custom";
			},
		};
		setVault(custom);
		try {
			assert.equal(
				await getVault().read("vault://file/anything"),
				"postgresql://custom:pw@host/custom",
			);
		} finally {
			// Restore lazy default so other tests see production behavior.
			setVault(undefined as unknown as VaultInterface);
		}
	});

	it("getVault() lazily builds a bridge that reads plain refs from env", async () => {
		setVault(undefined as unknown as VaultInterface); // force lazy re-init
		process.env[ENV_KEY] = "postgresql://lazy:pw@host/lazydb";
		const vault = getVault();
		assert.equal(typeof vault.read, "function");
		assert.equal(await vault.read(ENV_KEY), "postgresql://lazy:pw@host/lazydb");
	});
});
