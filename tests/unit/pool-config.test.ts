/**
 * P448 — pool.ts: AgentHiveConfigError when PGUSER+PGHOST are unset (AC#103).
 *
 * Tests that getPool() and initPoolFromConfig() fail with a clear
 * AgentHiveConfigError when both PGUSER and PGHOST are absent from the
 * environment, with an error message pointing at /etc/agenthive/env.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AgentHiveConfigError } from "../../src/shared/runtime/endpoints.ts";
import {
	closePool,
	getPool,
	initPoolFromConfig,
} from "../../src/infra/postgres/pool.ts";

/** Save, clear, and restore PG-related env vars around each test. */
function pgEnvGuard() {
	const vars = [
		"PGUSER",
		"PGHOST",
		"PGPORT",
		"PGDATABASE",
		"PGPASSWORD",
		"DATABASE_URL",
		"__PGPASSWORD_FROM_CONFIG",
	] as const;
	const saved: Record<string, string | undefined> = {};

	return {
		beforeEach() {
			for (const v of vars) saved[v] = process.env[v];
			for (const v of vars) delete process.env[v];
			// Provide a password so the pool doesn't fail on password check first
			process.env.PGPASSWORD = "test_pool_password";
		},
		afterEach() {
			for (const v of vars) {
				if (saved[v] !== undefined) process.env[v] = saved[v];
				else delete process.env[v];
			}
		},
	};
}

describe("pool.ts — P448 double-unset guard (AC#103)", () => {
	const guard = pgEnvGuard();

	beforeEach(async () => {
		guard.beforeEach();
		// Close any singleton pool from prior tests so resolvePoolConfig runs fresh
		await closePool();
	});

	afterEach(async () => {
		await closePool();
		guard.afterEach();
	});

	test("getPool throws AgentHiveConfigError when PGUSER and PGHOST are both unset", () => {
		// PGUSER and PGHOST are deleted by the guard; only PGPASSWORD is set
		assert.throws(
			() => getPool(),
			(err: unknown) => {
				assert.ok(
					err instanceof AgentHiveConfigError,
					`Expected AgentHiveConfigError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
				);
				assert.ok(
					(err as AgentHiveConfigError).message.includes("/etc/agenthive/env"),
					`Error message must reference /etc/agenthive/env, got: ${(err as AgentHiveConfigError).message}`,
				);
				return true;
			},
		);
	});

	test("initPoolFromConfig throws AgentHiveConfigError when PGUSER unset and dbConfig has no user", () => {
		// dbConfig provides no user; PGUSER is not set
		assert.throws(
			() =>
				initPoolFromConfig({
					host: "127.0.0.1",
					port: 5432,
					name: "test_db",
					password: "test_pool_password",
					// intentionally no `user` key
				}),
			(err: unknown) => {
				assert.ok(
					err instanceof AgentHiveConfigError,
					`Expected AgentHiveConfigError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
				);
				assert.ok(
					(err as AgentHiveConfigError).message.includes("/etc/agenthive/env"),
					`Error message must reference /etc/agenthive/env, got: ${(err as AgentHiveConfigError).message}`,
				);
				return true;
			},
		);
	});

	test("getPool succeeds when PGUSER is set", () => {
		process.env.PGUSER = "test_user";
		process.env.PGHOST = "127.0.0.1";
		process.env.PGDATABASE = "test_db";
		// Should not throw — pool is constructed (not connected yet)
		assert.doesNotThrow(() => getPool());
	});
});
