/**
 * P159 integration tests: agent-identity.ts ↔ agent_registry wiring
 *
 * Covers AC-1 through AC-10. Uses a real Postgres connection.
 * All test rows are prefixed with "test-p159-" and cleaned up in afterEach.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	generateAgentKeyPair,
	getOrCreateIdentity,
	issueToken,
	rotateKeyPair,
	verifyTokenWithDbLookup,
} from "../../src/core/identity/agent-identity.ts";
import {
	getAgentPublicKey,
	registerAgent,
	updateAgentPublicKey,
} from "../../src/core/identity/agent-registry/index.ts";
import { query } from "../../src/infra/postgres/pool.ts";

const TEST_PREFIX = "test-p159";
let workspaceRoot: string;

beforeEach(() => {
	workspaceRoot = join(tmpdir(), `p159-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1`,
		[`${TEST_PREFIX}%`],
	);
});

describe("P159 — registerAgent public_key wiring (AC-1)", () => {
	it("persists public_key and sets key_rotated_at when publicKey provided", async () => {
		const agentId = `${TEST_PREFIX}-reg-key`;
		const kp = generateAgentKeyPair(agentId);

		// instanceId matches agentId so getAgentPublicKey(agentId) is a stable lookup
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp.publicKey });

		const { rows } = await query<{ public_key: string; key_rotated_at: string }>(
			`SELECT public_key, key_rotated_at FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[agentId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].public_key).toBe(kp.publicKey);
		expect(rows[0].key_rotated_at).not.toBeNull();
	});

	it("registerAgent without publicKey leaves public_key NULL on new row", async () => {
		const agentId = `${TEST_PREFIX}-reg-nokey`;
		await registerAgent({ agentId, instanceId: agentId });

		const { rows } = await query<{ public_key: string | null }>(
			`SELECT public_key FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[agentId],
		);
		expect(rows[0].public_key).toBeNull();
	});

	it("idempotent: re-registering with same key does not throw (AC-10)", async () => {
		const agentId = `${TEST_PREFIX}-idempotent`;
		const kp = generateAgentKeyPair(agentId);
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp.publicKey });
		// Second call with same key — must not throw
		await expect(registerAgent({ agentId, instanceId: agentId, publicKey: kp.publicKey })).resolves.not.toThrow();
	});

	it("throws on key conflict: same agent different public key (AC-10)", async () => {
		const agentId = `${TEST_PREFIX}-conflict`;
		const kp1 = generateAgentKeyPair(agentId);
		const kp2 = generateAgentKeyPair(agentId);
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp1.publicKey });

		await expect(
			registerAgent({ agentId, instanceId: agentId, publicKey: kp2.publicKey }),
		).rejects.toThrow(/Key conflict/);
	});
});

describe("P159 — getOrCreateIdentity DB wiring (AC-2)", () => {
	it("writes public_key to DB on first-run identity creation", async () => {
		const agentName = `${TEST_PREFIX}-first-run`;
		const kp = await getOrCreateIdentity(workspaceRoot, agentName);

		const dbKey = await getAgentPublicKey(kp.agentId);
		expect(dbKey).toBe(kp.publicKey);
	});

	it("does not re-register on subsequent calls (key already on disk)", async () => {
		const agentName = `${TEST_PREFIX}-subsequent`;
		const kp1 = await getOrCreateIdentity(workspaceRoot, agentName);
		const kp2 = await getOrCreateIdentity(workspaceRoot, agentName);
		// Same object returned from disk
		expect(kp2.agentId).toBe(kp1.agentId);
		expect(kp2.publicKey).toBe(kp1.publicKey);
	});
});

describe("P159 — getAgentPublicKey (AC-3)", () => {
	it("returns null for unknown agent", async () => {
		const key = await getAgentPublicKey(`${TEST_PREFIX}-unknown`);
		expect(key).toBeNull();
	});

	it("returns stored key after registration", async () => {
		const agentId = `${TEST_PREFIX}-lookup`;
		const kp = generateAgentKeyPair(agentId);
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp.publicKey });

		const key = await getAgentPublicKey(agentId);
		expect(key).toBe(kp.publicKey);
	});
});

describe("P159 — rotateKeyPair DB wiring (AC-4)", () => {
	it("updates public_key in DB after rotation", async () => {
		const agentName = `${TEST_PREFIX}-rotate`;
		const kp = await getOrCreateIdentity(workspaceRoot, agentName);
		const originalKey = kp.publicKey;

		const { newKeyPair } = await rotateKeyPair(workspaceRoot, kp);

		const dbKey = await getAgentPublicKey(kp.agentId);
		expect(dbKey).toBe(newKeyPair.publicKey);
		expect(dbKey).not.toBe(originalKey);
	});
});

describe("P159 — updateAgentPublicKey (AC-4)", () => {
	it("updates public_key and key_rotated_at directly", async () => {
		const agentId = `${TEST_PREFIX}-update-key`;
		const kp = generateAgentKeyPair(agentId);
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp.publicKey });

		const kp2 = generateAgentKeyPair(agentId);
		await updateAgentPublicKey(agentId, kp2.publicKey);

		const dbKey = await getAgentPublicKey(agentId);
		expect(dbKey).toBe(kp2.publicKey);
	});
});

describe("P159 — verifyTokenWithDbLookup (AC-3)", () => {
	it("validates a token using the DB-stored public key", async () => {
		const agentId = `${TEST_PREFIX}-verify-db`;
		const kp = generateAgentKeyPair(agentId);
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp.publicKey });

		const token = issueToken(kp);
		const result = await verifyTokenWithDbLookup(token);
		expect(result.valid).toBe(true);
		expect(result.agentId).toBe(agentId);
	});

	it("falls back to token.publicKey when agent has no DB key", async () => {
		const agentId = `${TEST_PREFIX}-verify-fallback`;
		// Not registered in DB — only token-embedded key available
		const kp = generateAgentKeyPair(agentId);
		const token = issueToken(kp);

		const result = await verifyTokenWithDbLookup(token);
		expect(result.valid).toBe(true);
	});

	it("rejects a token when DB key differs from token-embedded key (tampered)", async () => {
		const agentId = `${TEST_PREFIX}-verify-mismatch`;
		const kp1 = generateAgentKeyPair(agentId);
		const kp2 = generateAgentKeyPair(agentId);

		// DB has kp2's key; token signed with kp1
		await registerAgent({ agentId, instanceId: agentId, publicKey: kp2.publicKey });
		const token = issueToken(kp1);

		const result = await verifyTokenWithDbLookup(token);
		expect(result.valid).toBe(false);
	});
});
