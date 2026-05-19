import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	closePool,
	getPool,
	getPoolLifecycleMode,
	setPoolLifecycleMode,
} from "../../src/infra/postgres/pool.ts";

const PG_ENV_KEYS = [
	"PGUSER",
	"PGHOST",
	"PGPORT",
	"PGDATABASE",
	"PGPASSWORD",
	"DATABASE_URL",
	"__PGPASSWORD_FROM_CONFIG",
] as const;

function savePgEnv(): Record<(typeof PG_ENV_KEYS)[number], string | undefined> {
	const saved = {} as Record<(typeof PG_ENV_KEYS)[number], string | undefined>;
	for (const key of PG_ENV_KEYS) saved[key] = process.env[key];
	return saved;
}

function restorePgEnv(
	saved: Record<(typeof PG_ENV_KEYS)[number], string | undefined>,
): void {
	for (const key of PG_ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
}

describe("P1123 pool lifecycle sentinel", () => {
	let savedEnv: Record<(typeof PG_ENV_KEYS)[number], string | undefined>;
	let errors: string[];
	let originalError: typeof console.error;

	beforeEach(async () => {
		savedEnv = savePgEnv();
		process.env.PGUSER = "test_user";
		process.env.PGHOST = "127.0.0.1";
		process.env.PGDATABASE = "agenthive";
		process.env.PGPASSWORD = "test_password";
		delete process.env.DATABASE_URL;
		await closePool();
		errors = [];
		originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
	});

	afterEach(async () => {
		console.error = originalError;
		await closePool();
		setPoolLifecycleMode("one-shot");
		restorePgEnv(savedEnv);
	});

	test("long-running mode ignores accidental pool.end and keeps the pool reusable", async () => {
		setPoolLifecycleMode("long-running");
		const pool = getPool();

		await pool.end();

		assert.equal(getPoolLifecycleMode(), "long-running");
		assert.equal((pool as unknown as { ended?: boolean }).ended, false);
		assert.match(errors.join("\n"), /Ignored pool\.end\(\) in long-running/);
		assert.match(errors.join("\n"), /Error/);
		assert.strictEqual(getPool(), pool);
	});

	test("closePool bypasses the sentinel for real shutdown", async () => {
		setPoolLifecycleMode("long-running");
		const pool = getPool();

		await closePool();

		assert.equal((pool as unknown as { ended?: boolean }).ended, true);
	});
});
