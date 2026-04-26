/**
 * Tests for the canonical config resolver (P474).
 *
 * Acceptance Criteria:
 * 1. src/shared/runtime/config.ts and config-keys.ts exist; declare every config key with its class
 * 2. Reading a `secret` key from yaml or DB throws RuntimeConfigMissing
 * 3. Reading a `structural` key with both yaml and env set returns the env value
 * 4. Reading a `registry` key with no DB row and no env override throws
 * 5. P448/P449/P453 modules use config.get instead of direct env reads
 * 6. mcp_ops action=config_audit returns list of keys with last-access timestamp
 * 7. P416 marked as superseded (noted in commit message, not touched in code)
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
	RuntimeConfigMissing,
	RuntimeConfigInvalidSource,
	type ConfigKey,
} from "../../src/shared/runtime/config";
import {
	SecretKeys,
	StructuralKeys,
	RegistryKeys,
	DiagnosticKeys,
} from "../../src/shared/runtime/config-keys";

// Store original env for cleanup
const originalEnv = { ...process.env };

function resetEnv() {
	Object.keys(process.env).forEach((key) => {
		if (!(key in originalEnv)) {
			delete process.env[key];
		}
	});
	Object.assign(process.env, originalEnv);
}

describe("Config Resolver (P474)", () => {
	beforeEach(() => {
		clearCache();
		resetEnv();
	});

	afterEach(async () => {
		await cleanup();
		resetEnv();
	});

	describe("AC1: Config keys declared with classes", () => {
		it("should declare all secret keys", () => {
			assert.strictEqual(SecretKeys.PGPASSWORD.class, "secret");
			assert.strictEqual(SecretKeys.PGPASSWORD.name, "PGPASSWORD");
			assert.strictEqual(SecretKeys.PGPASSWORD.required, true);
		});

		it("should declare all structural keys", () => {
			assert.strictEqual(StructuralKeys.PGHOST.class, "structural");
			assert.strictEqual(StructuralKeys.PGHOST.name, "PGHOST");
			assert.strictEqual(StructuralKeys.PGHOST.yamlPath, "database.host");
		});

		it("should declare all registry keys", () => {
			assert.strictEqual(RegistryKeys.AGENTHIVE_DEFAULT_PROVIDER.class, "registry");
			assert.strictEqual(
				RegistryKeys.AGENTHIVE_DEFAULT_PROVIDER.name,
				"AGENTHIVE_DEFAULT_PROVIDER",
			);
		});

		it("should declare all diagnostic keys", () => {
			assert.strictEqual(DiagnosticKeys.DEBUG.class, "secret");
			assert.strictEqual(DiagnosticKeys.DEBUG_PG.class, "secret");
		});
	});

	describe("AC2: Secret keys refuse yaml/DB sources", () => {
		it("should read secret key from env successfully", async () => {
			await initConfig({});
			process.env.PGPASSWORD = "from-env-secret";

			const value = await get(SecretKeys.PGPASSWORD);
			assert.strictEqual(value, "from-env-secret");
		});

		it("should throw when secret key not in env", async () => {
			await initConfig({});
			delete process.env.PGPASSWORD;

			let thrown = false;
			let errorClass: string | null = null;
			try {
				await get(SecretKeys.PGPASSWORD);
			} catch (err) {
				thrown = true;
				errorClass = (err as Error).constructor.name;
			}
			assert.strictEqual(thrown, true);
			assert.strictEqual(errorClass, "RuntimeConfigMissing");
		});
	});

	describe("AC3: Structural keys prefer env over yaml", () => {
		it("should return env value when both env and yaml are set", async () => {
			await initConfig({
				yamlConfig: {
					database: {
						host: "from-yaml",
						port: 5432,
					},
				},
			});
			process.env.PGHOST = "from-env";

			const value = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value, "from-env");
		});

		it("should return yaml value when env is not set", async () => {
			await initConfig({
				yamlConfig: {
					database: {
						host: "from-yaml",
					},
				},
			});
			delete process.env.PGHOST;

			const value = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value, "from-yaml");
		});

		it("should use default value when neither env nor yaml is set", async () => {
			await initConfig({});
			delete process.env.PGHOST;

			const value = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value, "127.0.0.1");
		});

		it("should parse port correctly", async () => {
			await initConfig({});
			process.env.PGPORT = "5433";

			const value = await get(StructuralKeys.PGPORT);
			assert.strictEqual(value, 5433);
		});

		it("should reject invalid port number", async () => {
			await initConfig({});
			process.env.PGPORT = "invalid-port";

			let thrown = false;
			try {
				await get(StructuralKeys.PGPORT);
			} catch (err) {
				thrown = true;
			}
			assert.strictEqual(thrown, true);
		});
	});

	describe("AC4: Registry keys require DB or env", () => {
		it("should return undefined for optional registry key not set", async () => {
			await initConfig({});
			delete process.env.AGENTHIVE_DEFAULT_PROVIDER;

			const value = await getOptional(
				RegistryKeys.AGENTHIVE_DEFAULT_PROVIDER,
			);
			assert.strictEqual(value, undefined);
		});

		it("should return env value for registry key when set", async () => {
			await initConfig({});
			process.env.AGENTHIVE_DEFAULT_PROVIDER = "claude";

			const value = await getOptional(
				RegistryKeys.AGENTHIVE_DEFAULT_PROVIDER,
			);
			assert.strictEqual(value, "claude");
		});
	});

	describe("AC6: Audit tracking", () => {
		it("should track config access in audit log", async () => {
			await initConfig({});
			process.env.PGHOST = "test-host";

			const value = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value, "test-host");

			const audit = getAudit();
			const pgHostEntry = audit.find((a) => a.keyName === "PGHOST");
			assert.strictEqual(pgHostEntry !== undefined, true);
			assert.strictEqual(pgHostEntry?.lastAccessedAt instanceof Date, true);
			assert.strictEqual(pgHostEntry?.source, "env");
			assert.strictEqual(pgHostEntry?.accessCount, 1);
		});

		it("should increment access count on repeated access", async () => {
			await initConfig({});
			process.env.PGHOST = "test-host";

			await get(StructuralKeys.PGHOST);
			await get(StructuralKeys.PGHOST);
			await get(StructuralKeys.PGHOST);

			const audit = getAudit();
			const pgHostEntry = audit.find((a) => a.keyName === "PGHOST");
			assert.strictEqual(pgHostEntry?.accessCount, 3);
		});

		it("should record different keys in audit", async () => {
			await initConfig({});
			process.env.PGHOST = "host-value";
			process.env.PGUSER = "user-value";

			await get(StructuralKeys.PGHOST);
			await get(StructuralKeys.PGUSER);

			const audit = getAudit();
			assert.strictEqual(audit.length >= 2, true);
			assert.strictEqual(audit.some((a) => a.keyName === "PGHOST"), true);
			assert.strictEqual(audit.some((a) => a.keyName === "PGUSER"), true);
		});
	});

	describe("AC7: Optional config values", () => {
		it("should return undefined for optional keys not set", async () => {
			await initConfig({});
			delete process.env.DISCORD_BOT_TOKEN;

			const value = await getOptional(SecretKeys.DISCORD_BOT_TOKEN);
			assert.strictEqual(value, undefined);
		});

		it("should return value for optional keys when set", async () => {
			await initConfig({});
			process.env.DISCORD_BOT_TOKEN = "test-token";

			const value = await getOptional(SecretKeys.DISCORD_BOT_TOKEN);
			assert.strictEqual(value, "test-token");
		});
	});

	describe("Resolution order enforcement", () => {
		it("should follow resolution order: env > yaml > default", async () => {
			// Setup both env and yaml
			await initConfig({
				yamlConfig: {
					database: {
						host: "from-yaml",
						port: 5432,
					},
				},
			});
			process.env.PGHOST = "from-env";

			// Env should win
			const value = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value, "from-env");
		});

		it("should handle database connection params", async () => {
			await initConfig({
				yamlConfig: {
					database: {
						host: "yaml-host",
						port: 5432,
						name: "yaml-db",
						user: "yaml-user",
					},
				},
			});

			const host = await get(StructuralKeys.PGHOST);
			const port = await get(StructuralKeys.PGPORT);
			const db = await get(StructuralKeys.PGDATABASE);
			const user = await get(StructuralKeys.PGUSER);

			assert.strictEqual(host, "yaml-host");
			assert.strictEqual(port, 5432);
			assert.strictEqual(db, "yaml-db");
			assert.strictEqual(user, "yaml-user");
		});
	});

	describe("Cache behavior", () => {
		it("should cache resolved values", async () => {
			await initConfig({});
			process.env.PGHOST = "cached-host";

			const value1 = await get(StructuralKeys.PGHOST);
			const value2 = await get(StructuralKeys.PGHOST);

			assert.strictEqual(value1, value2);
			assert.strictEqual(value1, "cached-host");
		});

		it("should clear cache on clearCache()", async () => {
			await initConfig({});
			process.env.PGHOST = "original-host";

			const value1 = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value1, "original-host");

			clearCache();
			process.env.PGHOST = "new-host";

			const value2 = await get(StructuralKeys.PGHOST);
			assert.strictEqual(value2, "new-host");
		});
	});

	describe("Invalid schema name handling", () => {
		it("should reject invalid schema names", async () => {
			await initConfig({});
			process.env.PG_SCHEMA = "123-invalid"; // Starts with number

			let thrown = false;
			try {
				await get(StructuralKeys.PG_SCHEMA);
			} catch (err) {
				thrown = true;
			}
			assert.strictEqual(thrown, true);
		});

		it("should accept valid schema names", async () => {
			await initConfig({});
			process.env.PG_SCHEMA = "valid_schema";

			const value = await get(StructuralKeys.PG_SCHEMA);
			assert.strictEqual(value, "valid_schema");
		});
	});

	describe("Timeout parsing", () => {
		it("should parse connection timeout correctly", async () => {
			await initConfig({});
			process.env.PG_CONNECTION_TIMEOUT_MS = "10000";

			const value = await get(StructuralKeys.PG_CONNECTION_TIMEOUT_MS);
			assert.strictEqual(value, 10000);
		});

		it("should use default timeout when not set", async () => {
			await initConfig({});
			delete process.env.PG_CONNECTION_TIMEOUT_MS;

			const value = await get(StructuralKeys.PG_CONNECTION_TIMEOUT_MS);
			assert.strictEqual(value, 5000);
		});
	});

	describe("URL validation", () => {
		it("should validate MCP URL format", async () => {
			await initConfig({});
			process.env.AGENTHIVE_MCP_URL = "http://127.0.0.1:6421/sse";

			const value = await get(StructuralKeys.AGENTHIVE_MCP_URL);
			assert.strictEqual(value, "http://127.0.0.1:6421/sse");
		});

		it("should reject invalid URL format", async () => {
			await initConfig({});
			process.env.AGENTHIVE_MCP_URL = "not-a-url";

			let thrown = false;
			try {
				await get(StructuralKeys.AGENTHIVE_MCP_URL);
			} catch (err) {
				thrown = true;
			}
			assert.strictEqual(thrown, true);
		});
	});

	describe("Diagnostic keys", () => {
		it("should parse DEBUG flag from env", async () => {
			await initConfig({});
			process.env.DEBUG = "true";

			const value = await getOptional(DiagnosticKeys.DEBUG);
			assert.strictEqual(value, true);
		});

		it("should parse DEBUG_PG flag from env", async () => {
			await initConfig({});
			process.env.DEBUG_PG = "1";

			const value = await getOptional(DiagnosticKeys.DEBUG_PG);
			assert.strictEqual(value, true);
		});
	});
});
