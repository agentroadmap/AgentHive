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
