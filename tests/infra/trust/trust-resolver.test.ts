/**
 * P208: Trust Resolver Tests (AC#7)
 *
 * Verifies:
 *   - authority sender can send all message types
 *   - restricted sender cannot send 'task'
 *   - blocked explicit trust entry → tier=blocked, allowed=false
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { query } from "../../../src/infra/postgres/pool.js";
import { resolveTrust } from "../../../src/infra/trust/trust-resolver.js";

const TEST_SENDER = "test/p208-blocked-sender";
const TEST_RECEIVER = "test/p208-receiver";
const TEST_UNKNOWN = "test/p208-completely-unknown";
const TEST_OTHER = "different/p208-other";

async function ensureAgent(identity: string, type = "llm") {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
		 VALUES ($1, $2)
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity, type],
	);
}

describe("Trust Resolver (P208 AC#7)", () => {
	beforeEach(async () => {
		await ensureAgent(TEST_SENDER);
		await ensureAgent(TEST_RECEIVER);
		// Insert explicit blocked trust entry
		await query(
			`INSERT INTO roadmap_workforce.agent_trust
			   (agent_identity, trusted_agent, trust_level, granted_by, reason)
			 VALUES ($1, $2, 'blocked', 'gary', 'p208-test')
			 ON CONFLICT (agent_identity, trusted_agent)
			 DO UPDATE SET trust_level = 'blocked'`,
			[TEST_SENDER, TEST_RECEIVER],
		);
	});

	afterEach(async () => {
		await query(
			`DELETE FROM roadmap_workforce.agent_trust
			 WHERE agent_identity LIKE 'test/p208%' OR trusted_agent LIKE 'test/p208%'`,
		);
		await query(
			`DELETE FROM roadmap_workforce.agent_registry
			 WHERE agent_identity LIKE 'test/p208%'`,
		);
	});

	describe("AC#7a: authority can send all message types", () => {
		for (const msgType of ["task", "query", "response", "status", "ping", "pong"]) {
			it(`authority sender can send '${msgType}'`, async () => {
				const result = await resolveTrust({
					sender: "gary",
					receiver: TEST_OTHER,
					messageType: msgType,
				});
				assert.strictEqual(result.allowed, true, `expected allowed for '${msgType}'`);
				assert.strictEqual(result.tier, "authority");
			});
		}
	});

	describe("AC#7b: restricted sender cannot send 'task'", () => {
		it("unknown agent defaults to restricted and cannot send task", async () => {
			const result = await resolveTrust({
				sender: TEST_UNKNOWN,
				receiver: TEST_OTHER,
				messageType: "task",
			});
			assert.strictEqual(result.allowed, false);
			assert.strictEqual(result.tier, "restricted");
		});

		it("restricted agent cannot send 'query' either", async () => {
			const result = await resolveTrust({
				sender: TEST_UNKNOWN,
				receiver: TEST_OTHER,
				messageType: "query",
			});
			assert.strictEqual(result.allowed, false);
			assert.strictEqual(result.tier, "restricted");
		});

		it("restricted agent can send 'response'", async () => {
			const result = await resolveTrust({
				sender: TEST_UNKNOWN,
				receiver: TEST_OTHER,
				messageType: "response",
			});
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.tier, "restricted");
		});
	});

	describe("AC#7c: blocked messages return tier=blocked", () => {
		it("blocked explicit trust → tier=blocked, allowed=false", async () => {
			const result = await resolveTrust({
				sender: TEST_SENDER,
				receiver: TEST_RECEIVER,
				messageType: "task",
			});
			assert.strictEqual(result.allowed, false);
			assert.strictEqual(result.tier, "blocked");
		});

		it("blocked agent cannot send any message type", async () => {
			for (const msgType of ["task", "query", "response", "status", "ping"]) {
				const result = await resolveTrust({
					sender: TEST_SENDER,
					receiver: TEST_RECEIVER,
					messageType: msgType,
				});
				assert.strictEqual(result.allowed, false, `expected blocked for '${msgType}'`);
				assert.strictEqual(result.tier, "blocked");
			}
		});
	});
});
