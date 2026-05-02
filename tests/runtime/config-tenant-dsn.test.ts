/**
 * Tests for P498: tenant_dsn class and CONTROL_DSN resolution.
 *
 * Acceptance Criteria:
 * 1. tenant_dsn class added to ConfigClass; get()/getOptional() throw RuntimeConfigInvalidSource
 * 2. CONTROL_DSN env-first: env var wins over yaml; yaml fallback assembles from databases.control.*
 * 3. CONTROL_DB_PASSWORD_REF is structural string; resolver does NOT call vault
 * 4. getProjectDb(slug) exports from config module; accesses recorded in audit under tenant_dsn:<slug>
 * 5. getControlDsn() re-reads env on every call; logs metric on DSN change
 * 6. All 13 new keys declared with correct class, source, default, yamlPath
 * 7. Type-checked and clean
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	initConfig,
	clearCache,
	cleanup,
	get,
	getOptional,
	getAudit,
	getTenantDsnAudit,
	getProjectDb,
	getControlDsn,
	RuntimeConfigMissing,
	RuntimeConfigInvalidSource,
	type ConfigKey,
} from "../../src/shared/runtime/config";
import {
	StructuralKeys,
} from "../../src/shared/runtime/config-keys";

const originalEnv = { ...process.env };

function resetEnv() {
	Object.keys(process.env).forEach((key) => {
		if (!(key in originalEnv)) {
			delete process.env[key];
		}
	});
	Object.assign(process.env, originalEnv);
}

describe("Config Resolver P498 (tenant_dsn & CONTROL_DSN)", () => {
	beforeEach(() => {
		clearCache();
		resetEnv();
	});

	afterEach(async () => {
		await cleanup();
		resetEnv();
	});

	describe("AC1: tenant_dsn class enforcement", () => {
		it("should throw RuntimeConfigInvalidSource when get() called on tenant_dsn key", async () => {
			await initConfig({});

			// Create a fake tenant_dsn key for testing
			const fakeKey: ConfigKey<string> = {
				name: "TEST_TENANT_DSN",
				class: "tenant_dsn",
				parse: (v: string) => v,
				required: true,
			};

			let thrown = false;
			let error: Error | null = null;
			try {
				await get(fakeKey);
			} catch (err) {
				thrown = true;
				error = err as Error;
			}

			assert.strictEqual(thrown, true);
			assert.strictEqual(error?.name, "RuntimeConfigInvalidSource");
			assert.match(error?.message || "", /getProjectDb\(\)/);
		});

		it("should throw RuntimeConfigInvalidSource when getOptional() called on tenant_dsn key", async () => {
			await initConfig({});

			const fakeKey: ConfigKey<string | undefined> = {
				name: "TEST_TENANT_DSN",
				class: "tenant_dsn",
				parse: (v: string) => v,
				required: false,
			};

			let thrown = false;
			let error: Error | null = null;
			try {
				await getOptional(fakeKey);
			} catch (err) {
				thrown = true;
				error = err as Error;
			}

			assert.strictEqual(thrown, true);
			assert.strictEqual(error?.name, "RuntimeConfigInvalidSource");
		});
	});

	describe("AC2: CONTROL_DSN env-first resolution", () => {
		it("should read CONTROL_DSN from env when set", async () => {
			await initConfig({});
			const envDsn = "postgresql://user@host:5432/hiveControl";
			process.env.AGENTHIVE_CONTROL_DSN = envDsn;

			const dsn = getControlDsn();
			assert.strictEqual(dsn, envDsn);
		});

		it("should assemble CONTROL_DSN from yaml when env not set", async () => {
			await initConfig({
				yamlConfig: {
					databases: {
						control: {
							host: "yaml-host",
							port: 6432,
							name: "yaml-db",
							role: "yaml-role",
							password_ref: "vault://file/yaml-password",
						},
					},
				},
			});
			delete process.env.AGENTHIVE_CONTROL_DSN;

			const dsn = getControlDsn();
			assert.match(dsn, /yaml-host/);
			assert.match(dsn, /6432/);
			assert.match(dsn, /yaml-db/);
			assert.match(dsn, /yaml-role/);
		});

		it("should use default values in yaml assembly when fields omitted", async () => {
			await initConfig({
				yamlConfig: {
					databases: {
						control: {
							host: "custom-host",
							// port, name, role omitted -> use defaults
						},
					},
				},
			});
			delete process.env.AGENTHIVE_CONTROL_DSN;

			const dsn = getControlDsn();
			assert.match(dsn, /custom-host/);
			assert.match(dsn, /6432/); // default port
			assert.match(dsn, /hiveControl/); // default name
			assert.match(dsn, /agenthive_admin/); // default role
		});

		it("should throw when both env and yaml are absent", async () => {
			await initConfig({});
			delete process.env.AGENTHIVE_CONTROL_DSN;

			let thrown = false;
			try {
				getControlDsn();
			} catch (err) {
				thrown = true;
				assert.strictEqual((err as Error).name, "RuntimeConfigMissing");
			}
			assert.strictEqual(thrown, true);
		});

		it("should prioritize env over yaml when both are present", async () => {
			const envDsn = "postgresql://env@env-host:5432/env-db";
			await initConfig({
				yamlConfig: {
					databases: {
						control: {
							host: "yaml-host",
							port: 6432,
							name: "yaml-db",
							role: "yaml-role",
						},
					},
				},
			});
			process.env.AGENTHIVE_CONTROL_DSN = envDsn;

			const dsn = getControlDsn();
			assert.strictEqual(dsn, envDsn);
		});
	});

	describe("AC3: CONTROL_DB_PASSWORD_REF is structural string", () => {
		it("should read password_ref from env", async () => {
			await initConfig({});
			process.env.CONTROL_DB_PASSWORD_REF = "vault://aws/prod/db-password";

			const ref = await get(StructuralKeys.CONTROL_DB_PASSWORD_REF);
			assert.strictEqual(ref, "vault://aws/prod/db-password");
		});

		it("should read password_ref from yaml fallback", async () => {
			await initConfig({
				yamlConfig: {
					databases: {
						control: {
							password_ref: "vault://file/control/db_password",
						},
					},
				},
			});
			delete process.env.CONTROL_DB_PASSWORD_REF;

			const ref = await get(StructuralKeys.CONTROL_DB_PASSWORD_REF);
			assert.strictEqual(ref, "vault://file/control/db_password");
		});

		it("should use default password_ref when both absent", async () => {
			await initConfig({});
			delete process.env.CONTROL_DB_PASSWORD_REF;

			const ref = await get(StructuralKeys.CONTROL_DB_PASSWORD_REF);
			assert.strictEqual(ref, "vault://file/control/db_password");
		});
	});

	describe("AC4: getProjectDb(slug) access audit", () => {
		it("should export getProjectDb function", async () => {
			await initConfig({});
			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://localhost/hiveControl";

			assert.strictEqual(typeof getProjectDb, "function");
		});

		it("should record tenant_dsn access in audit log", async () => {
			await initConfig({});
			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://localhost/hiveControl";

			await getProjectDb("test-slug-1");

			const audit = getTenantDsnAudit();
			const entry = audit.find((a) => a.slug === "test-slug-1");
			assert.strictEqual(entry !== undefined, true);
			assert.strictEqual(entry?.accessor, "config.getProjectDb");
			assert.strictEqual(entry?.accessCount, 1);
		});

		it("should increment access count on repeated calls", async () => {
			await initConfig({});
			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://localhost/hiveControl";

			await getProjectDb("test-slug-2");
			await getProjectDb("test-slug-2");
			await getProjectDb("test-slug-2");

			const audit = getTenantDsnAudit();
			const entry = audit.find((a) => a.slug === "test-slug-2");
			assert.strictEqual(entry?.accessCount, 3);
		});

		it("should track multiple slug accesses separately", async () => {
			await initConfig({});
			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://localhost/hiveControl";

			await getProjectDb("slug-a");
			await getProjectDb("slug-b");
			await getProjectDb("slug-a");

			const audit = getTenantDsnAudit();
			const entryA = audit.find((a) => a.slug === "slug-a");
			const entryB = audit.find((a) => a.slug === "slug-b");

			assert.strictEqual(entryA?.accessCount, 2);
			assert.strictEqual(entryB?.accessCount, 1);
		});
	});

	describe("AC5: getControlDsn() re-reads env on every call", () => {
		it("should re-read env var on each call", async () => {
			await initConfig({});

			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://host1/db1";
			let dsn = getControlDsn();
			assert.match(dsn, /host1/);

			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://host2/db2";
			dsn = getControlDsn();
			assert.match(dsn, /host2/);
		});
	});

	describe("AC6: All 13 new keys declared correctly", () => {
		it("should declare AGENTHIVE_CONTROL_DSN as structural", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_CONTROL_DSN.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_CONTROL_DSN.name, "AGENTHIVE_CONTROL_DSN");
		});

		it("should declare CONTROL_DB_HOST as structural with defaults", () => {
			assert.strictEqual(StructuralKeys.CONTROL_DB_HOST.class, "structural");
			assert.strictEqual(StructuralKeys.CONTROL_DB_HOST.defaultValue, "127.0.0.1");
		});

		it("should declare CONTROL_DB_PORT with validation", () => {
			assert.strictEqual(StructuralKeys.CONTROL_DB_PORT.class, "structural");
			assert.strictEqual(StructuralKeys.CONTROL_DB_PORT.defaultValue, 6432);

			// Test parser
			const parsed = StructuralKeys.CONTROL_DB_PORT.parse("8080");
			assert.strictEqual(parsed, 8080);

			let thrown = false;
			try {
				StructuralKeys.CONTROL_DB_PORT.parse("invalid");
			} catch {
				thrown = true;
			}
			assert.strictEqual(thrown, true);
		});

		it("should declare CONTROL_DB_NAME with default", () => {
			assert.strictEqual(StructuralKeys.CONTROL_DB_NAME.class, "structural");
			assert.strictEqual(StructuralKeys.CONTROL_DB_NAME.defaultValue, "hiveControl");
		});

		it("should declare CONTROL_DB_ROLE with default", () => {
			assert.strictEqual(StructuralKeys.CONTROL_DB_ROLE.class, "structural");
			assert.strictEqual(StructuralKeys.CONTROL_DB_ROLE.defaultValue, "agenthive_admin");
		});

		it("should declare CONTROL_DB_PASSWORD_REF with vault path default", () => {
			assert.strictEqual(StructuralKeys.CONTROL_DB_PASSWORD_REF.class, "structural");
			assert.strictEqual(StructuralKeys.CONTROL_DB_PASSWORD_REF.defaultValue, "vault://file/control/db_password");
		});

		it("should declare AGENTHIVE_VAULT_ROOT with default", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_VAULT_ROOT.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_VAULT_ROOT.defaultValue, "/etc/agenthive/secrets");
		});

		it("should declare AGENTHIVE_VAULT_KIND with validation", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_VAULT_KIND.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_VAULT_KIND.defaultValue, "file");

			const parsed = StructuralKeys.AGENTHIVE_VAULT_KIND.parse("aws");
			assert.strictEqual(parsed, "aws");

			let thrown = false;
			try {
				StructuralKeys.AGENTHIVE_VAULT_KIND.parse("invalid-kind");
			} catch {
				thrown = true;
			}
			assert.strictEqual(thrown, true);
		});

		it("should declare AGENTHIVE_TENANT_POOL_LRU_MAX with default", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_TENANT_POOL_LRU_MAX.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_TENANT_POOL_LRU_MAX.defaultValue, 16);
		});

		it("should declare AGENTHIVE_TENANT_POOL_MAX with default", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_TENANT_POOL_MAX.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_TENANT_POOL_MAX.defaultValue, 8);
		});

		it("should declare AGENTHIVE_DRAIN_TIMEOUT_MS with default", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_DRAIN_TIMEOUT_MS.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_DRAIN_TIMEOUT_MS.defaultValue, 30000);
		});

		it("should declare AGENTHIVE_PG_PORT with default", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_PG_PORT.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_PG_PORT.defaultValue, 6432);
		});

		it("should declare AGENTHIVE_LISTEN_PORT with default", () => {
			assert.strictEqual(StructuralKeys.AGENTHIVE_LISTEN_PORT.class, "structural");
			assert.strictEqual(StructuralKeys.AGENTHIVE_LISTEN_PORT.defaultValue, 5432);
		});
	});

	describe("AC7: Class enforcement preserved from P474", () => {
		it("should enforce structural keys env-over-yaml", async () => {
			await initConfig({
				yamlConfig: {
					databases: {
						control: {
							host: "yaml-host",
						},
					},
				},
			});
			process.env.CONTROL_DB_HOST = "env-host";

			const host = await get(StructuralKeys.CONTROL_DB_HOST);
			assert.strictEqual(host, "env-host");
		});

		it("should enforce structural keys yaml fallback", async () => {
			await initConfig({
				yamlConfig: {
					databases: {
						control: {
							port: 9999,
						},
					},
				},
			});
			delete process.env.CONTROL_DB_PORT;

			const port = await get(StructuralKeys.CONTROL_DB_PORT);
			assert.strictEqual(port, 9999);
		});
	});

	describe("Cache clearing and hot reload", () => {
		it("should reflect CONTROL_DSN changes after cache clear", async () => {
			await initConfig({});
			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://host1/db1";

			let dsn = getControlDsn();
			assert.match(dsn, /host1/);

			// Change env and clear cache
			process.env.AGENTHIVE_CONTROL_DSN = "postgresql://host2/db2";
			clearCache();

			dsn = getControlDsn();
			assert.match(dsn, /host2/);
		});
	});
});
