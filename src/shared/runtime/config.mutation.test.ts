import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import {
	agentContextStorage,
	type VerifiedPrincipal,
} from "../identity/agent-context.ts";
import { ConfigResolver, RuntimeConfigMutationForbidden } from "./config.ts";
import {
	FlagKeys,
	RegistryKeys,
	SecretKeys,
	StructuralKeys,
} from "./config-keys.ts";

/**
 * P828: ConfigResolver.set()/reload() authorization gates. These are pure-logic
 * unit tests — they assert the fail-fast deny order runs BEFORE any DB query
 * (pool.query call-count == 0 on every pre-DB rejection). The DB write half
 * (runtime_flag upsert + config_mutation_log append + DID lookup) targets
 * hiveCentral and is covered by integration tests, not here.
 */

/** A pool whose query() counts calls — a pre-DB rejection must never call it. */
function spyPool() {
	const calls: string[] = [];
	return {
		calls,
		query: async (sql: string) => {
			calls.push(sql);
			return { rows: [] };
		},
		connect: async () => ({
			query: async () => ({ rows: [] }),
			on: () => {},
			release: () => {},
		}),
		options: {},
	} as never;
}

function principal(
	kind: VerifiedPrincipal["principal_kind"],
): VerifiedPrincipal {
	return { principal_id: "1", principal_kind: kind, parent_principal_id: null };
}

/** Run fn with a verified principal in async context. */
function withPrincipal<T>(
	kind: VerifiedPrincipal["principal_kind"],
	fn: () => Promise<T>,
): Promise<T> {
	return agentContextStorage.run({ verified: principal(kind) }, fn);
}

let resolvers: ConfigResolver[] = [];
afterEach(async () => {
	await Promise.all(resolvers.map((r) => r.cleanup().catch(() => {})));
	resolvers = [];
});

async function freshResolver(pool: ReturnType<typeof spyPool>) {
	const r = new ConfigResolver();
	resolvers.push(r);
	await r.init({ pool: pool as never });
	return r;
}

describe("resolveAuthority mapping (P828 AC-4/AC-27)", () => {
	test("operator→operator, agency→system, agent→agent_read_only", () => {
		assert.equal(ConfigResolver.resolveAuthority("operator"), "operator");
		assert.equal(ConfigResolver.resolveAuthority("agency"), "system");
		assert.equal(ConfigResolver.resolveAuthority("agent"), "agent_read_only");
	});
});

describe("ConfigResolver.set() authorization gates (P828)", () => {
	test("AC-3: no identity context → NO_IDENTITY_CONTEXT, zero DB calls", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await assert.rejects(
			() => r.set(FlagKeys.USE_OFFER_DISPATCH, true),
			(e: unknown) => {
				assert.ok(e instanceof RuntimeConfigMutationForbidden);
				assert.equal(e.reason, "NO_IDENTITY_CONTEXT");
				assert.equal(e.authority, null);
				return true;
			},
		);
		assert.equal(pool.calls.length, 0, "no DB query before identity check");
	});

	test("AC-5: agent kind → AGENT_READ_ONLY, zero DB calls", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("agent", async () => {
			await assert.rejects(
				() => r.set(FlagKeys.USE_OFFER_DISPATCH, true),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "AGENT_READ_ONLY",
			);
		});
		assert.equal(pool.calls.length, 0);
	});

	test("AC-6: secret class → IMMUTABLE_CLASS even for operator, zero DB calls", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await assert.rejects(
				() => r.set(SecretKeys.PGPASSWORD, "x"),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "IMMUTABLE_CLASS",
			);
		});
		assert.equal(pool.calls.length, 0);
	});

	test("AC-7: agency (system) on registry class → SYSTEM_REGISTRY_DENIED, zero DB", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("agency", async () => {
			await assert.rejects(
				() => r.set(RegistryKeys.PROJECT_TOKEN_BUDGET, 100),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "SYSTEM_REGISTRY_DENIED" &&
					e.authority === "system",
			);
		});
		assert.equal(pool.calls.length, 0);
	});

	test("structural class + non-operator (agency) → SYSTEM_STRUCTURAL_DENIED, zero DB", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("agency", async () => {
			await assert.rejects(
				() => r.set(StructuralKeys.PGHOST, "127.0.0.2"),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "SYSTEM_STRUCTURAL_DENIED",
			);
		});
		assert.equal(pool.calls.length, 0);
	});

	test("AC-30: 10 concurrent secret writes all denied IMMUTABLE_CLASS, zero DB", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			const results = await Promise.allSettled(
				Array.from({ length: 10 }, () => r.set(SecretKeys.PGPASSWORD, "y")),
			);
			assert.ok(
				results.every(
					(x) =>
						x.status === "rejected" &&
						x.reason instanceof RuntimeConfigMutationForbidden &&
						x.reason.reason === "IMMUTABLE_CLASS",
				),
			);
		});
		assert.equal(pool.calls.length, 0, "no race opens a DB write");
	});
});

/**
 * A pool that simulates hiveCentral for the persistMutation DB half:
 *  - SELECT ... control_identity.principal → returns `principalRow` (or none).
 *  - INSERT ... config_mutation_log → recorded into `mutationRows`.
 *  - all other queries → empty result.
 * Used to exercise AC-14 (validation-failure audit), AC-29 (human deny),
 * AC-49 (emergency override) without a live DB.
 */
function dbPool(
	principalRow: { id: string; did: string; principal_type: string } | null,
) {
	const mutationRows: any[][] = [];
	const calls: string[] = [];
	async function query(sql: string, params?: any[]) {
		calls.push(sql);
		if (sql.includes("control_identity.principal")) {
			return { rows: principalRow ? [principalRow] : [] };
		}
		if (sql.includes("config_mutation_log")) {
			mutationRows.push(params ?? []);
			return { rows: [] };
		}
		return { rows: [] };
	}
	const client = { query, release: () => {}, on: () => {} };
	return {
		mutationRows,
		calls,
		query,
		connect: async () => client,
		options: {},
	} as never;
}

describe("ConfigResolver.persistMutation DB half (P828 AC-14/29/43/49)", () => {
	test("AC-29: principal_type='human' → denied (AGENT_READ_ONLY), no write", async () => {
		const pool = dbPool({
			id: "5",
			did: "did:hive:human",
			principal_type: "human",
		});
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await assert.rejects(
				() => r.set(FlagKeys.USE_OFFER_DISPATCH, true),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "AGENT_READ_ONLY",
			);
		});
		assert.equal(
			(pool as any).mutationRows.length,
			0,
			"human principal writes no audit row",
		);
	});

	test("AC-43: unknown principal_id → PRINCIPAL_LOOKUP_FAILED, no write", async () => {
		const pool = dbPool(null);
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await assert.rejects(
				() => r.set(FlagKeys.USE_OFFER_DISPATCH, true),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "PRINCIPAL_LOOKUP_FAILED",
			);
		});
		assert.equal((pool as any).mutationRows.length, 0);
	});

	test("AC-14/35: parse failure writes ONE failed-audit row, re-throws", async () => {
		const pool = dbPool({
			id: "7",
			did: "did:hive:op",
			principal_type: "operator",
		});
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			// PROJECT_TOKEN_BUDGET.parse rejects negative numbers.
			await assert.rejects(() =>
				r.set(RegistryKeys.PROJECT_TOKEN_BUDGET, -1 as never),
			);
		});
		assert.equal(
			(pool as any).mutationRows.length,
			1,
			"exactly one failed-audit row",
		);
		const row = (pool as any).mutationRows[0];
		// params: key_name, key_class, scope, old_value, caller_did, principal_id,
		//         mutation_authority, validation_error  (new_value is literal NULL)
		assert.equal(row[0], "PROJECT_TOKEN_BUDGET");
		assert.equal(row[6], "operator");
		assert.ok(String(row[7]).includes("Invalid token budget"));
	});

	test("AC-49: emergency override (no context) resolves DID, audits operator", async () => {
		const pool = dbPool({
			id: "9",
			did: "did:hive:emergency",
			principal_type: "operator",
		});
		const r = await freshResolver(pool);
		const prev = process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID;
		process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID = "did:hive:emergency";
		try {
			// No agentContextStorage.run() — empty context, override must engage.
			await r.set(FlagKeys.USE_OFFER_DISPATCH, true);
		} finally {
			if (prev === undefined)
				delete process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID;
			else process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID = prev;
		}
		assert.equal((pool as any).mutationRows.length, 1, "one success-audit row");
		const row = (pool as any).mutationRows[0];
		assert.equal(row[5], "did:hive:emergency", "caller_did = env DID");
		assert.equal(row[6], "9", "principal_id = resolved row id");
		assert.equal(row[7], "operator", "authority forced to operator");
	});

	test("AC-49: emergency override never writes secret class", async () => {
		const pool = dbPool({
			id: "9",
			did: "did:hive:emergency",
			principal_type: "operator",
		});
		const r = await freshResolver(pool);
		const prev = process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID;
		process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID = "did:hive:emergency";
		try {
			await assert.rejects(
				() => r.set(SecretKeys.PGPASSWORD, "x"),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "IMMUTABLE_CLASS",
			);
		} finally {
			if (prev === undefined)
				delete process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID;
			else process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID = prev;
		}
		assert.equal((pool as any).mutationRows.length, 0);
	});
});

/**
 * A richer hiveCentral mock that records the FULL ordered query stream of BOTH
 * the pool and the transaction client, plus pg_notify payloads. Used to assert
 * the success-path behaviors: single-txn ordering (AC-45), synchronous cache
 * eviction (AC-16/40), notify-carries-no-value (AC-15/31), and that two
 * identical mutations write two distinct audit rows (AC-46).
 */
function txnPool(
	principalRow: { id: string; did: string; principal_type: string },
) {
	const sqlStream: string[] = []; // ordered SQL text across pool + client
	const notifyPayloads: string[] = [];
	const auditRows: any[][] = [];
	const flagUpserts: any[][] = [];

	async function record(sql: string, params?: any[]) {
		sqlStream.push(sql);
		if (sql.includes("control_identity.principal")) {
			return { rows: [principalRow] };
		}
		if (sql.includes("pg_notify")) {
			notifyPayloads.push((params ?? [])[0]);
			return { rows: [] };
		}
		if (sql.includes("config_mutation_log")) {
			auditRows.push(params ?? []);
			return { rows: [] };
		}
		if (sql.includes("runtime_flag")) {
			flagUpserts.push(params ?? []);
			return { rows: [] };
		}
		return { rows: [] };
	}

	const client = {
		query: (sql: string, params?: any[]) => record(sql, params),
		release: () => {},
		on: () => {},
	};
	return {
		sqlStream,
		notifyPayloads,
		auditRows,
		flagUpserts,
		query: (sql: string, params?: any[]) => record(sql, params),
		connect: async () => client,
		options: {},
	} as never;
}

describe("ConfigResolver.set() success path (P828 AC-15/16/31/40/45/46)", () => {
	const opRow = { id: "11", did: "did:hive:op", principal_type: "operator" };

	test("AC-45: runtime_flag upsert + config_mutation_log append run in one BEGIN/COMMIT txn, in order", async () => {
		const pool = txnPool(opRow);
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await r.set(FlagKeys.USE_OFFER_DISPATCH, true);
		});
		const stream: string[] = (pool as any).sqlStream;
		const beginIdx = stream.findIndex((s) => s.trim().startsWith("BEGIN"));
		const flagIdx = stream.findIndex(
			(s) => s.includes("runtime_flag") && s.includes("INSERT"),
		);
		const auditIdx = stream.findIndex((s) =>
			s.includes("config_mutation_log"),
		);
		const commitIdx = stream.findIndex((s) => s.trim().startsWith("COMMIT"));
		assert.ok(beginIdx >= 0, "BEGIN present");
		assert.ok(commitIdx > auditIdx, "COMMIT after audit insert");
		assert.ok(
			beginIdx < flagIdx && flagIdx < auditIdx && auditIdx < commitIdx,
			`order must be BEGIN<flag<audit<COMMIT, got ${beginIdx},${flagIdx},${auditIdx},${commitIdx}`,
		);
	});

	test("AC-15/31: pg_notify payload carries identifiers only — no value field", async () => {
		const pool = txnPool(opRow);
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await r.set(FlagKeys.USE_OFFER_DISPATCH, true);
		});
		const payloads: string[] = (pool as any).notifyPayloads;
		assert.equal(payloads.length, 1, "exactly one notify");
		const parsed = JSON.parse(payloads[0]);
		assert.equal(parsed.flag_name, "USE_OFFER_DISPATCH");
		assert.equal(parsed.scope, "global");
		assert.equal(parsed.op, "UPDATE");
		assert.ok(
			!("value" in parsed) &&
				!("new_value" in parsed) &&
				!("value_jsonb" in parsed),
			"notify must NOT leak the value",
		);
	});

	test("AC-16/40: local cache is synchronously evicted before set() returns", async () => {
		const pool = txnPool(opRow);
		const r = await freshResolver(pool);
		// Prime the cache by resolving once (env-free → undefined, but cache entry set).
		await r.getOptional(FlagKeys.USE_OFFER_DISPATCH).catch(() => undefined);
		await withPrincipal("operator", async () => {
			await r.set(FlagKeys.USE_OFFER_DISPATCH, true);
		});
		// After set() returns, the resolved-cache entry for the key must be gone
		// (the next read re-resolves from the DB). Inspect the private cache.
		const cache: Map<string, unknown> = (r as any).cache;
		const dbCache: Map<string, unknown> = (r as any).dbCache;
		assert.ok(
			!cache.has("USE_OFFER_DISPATCH"),
			"resolved-cache entry evicted synchronously",
		);
		assert.ok(
			!dbCache.has("runtime_flag:USE_OFFER_DISPATCH:global"),
			"db-cache entry evicted synchronously",
		);
	});

	test("AC-37: 5 concurrent operator writes each produce an audit row (no lost write)", async () => {
		const pool = txnPool(opRow);
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			const results = await Promise.allSettled(
				Array.from({ length: 5 }, () =>
					r.set(FlagKeys.USE_OFFER_DISPATCH, true),
				),
			);
			assert.ok(
				results.every((x) => x.status === "fulfilled"),
				"all concurrent writes resolve",
			);
		});
		assert.equal(
			(pool as any).auditRows.length,
			5,
			"five concurrent writes → five audit rows",
		);
	});

	test("AC-46: two identical mutations write two DISTINCT audit rows", async () => {
		const pool = txnPool(opRow);
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await r.set(FlagKeys.USE_OFFER_DISPATCH, true);
			await r.set(FlagKeys.USE_OFFER_DISPATCH, true);
		});
		assert.equal(
			(pool as any).auditRows.length,
			2,
			"identical inputs still append two audit rows (append-only history)",
		);
	});
});

describe("ConfigResolver.reload() identity gate (P828 AC-17)", () => {
	test("no context → NO_IDENTITY_CONTEXT", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await assert.rejects(
			() => r.reload(),
			(e: unknown) =>
				e instanceof RuntimeConfigMutationForbidden &&
				e.reason === "NO_IDENTITY_CONTEXT",
		);
	});

	test("agent → RELOAD_UNAUTHORIZED", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("agent", async () => {
			await assert.rejects(
				() => r.reload(),
				(e: unknown) =>
					e instanceof RuntimeConfigMutationForbidden &&
					e.reason === "RELOAD_UNAUTHORIZED",
			);
		});
	});

	test("operator → resolves (clears cache)", async () => {
		const pool = spyPool();
		const r = await freshResolver(pool);
		await withPrincipal("operator", async () => {
			await r.reload(); // must not throw
		});
		assert.ok(true);
	});
});
