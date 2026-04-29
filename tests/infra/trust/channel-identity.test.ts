/**
 * P208: Channel Identity Mapper Integration Tests (AC#6)
 *
 * Verifies:
 *   - resolveChannelIdentity('discord', '1234567890') returns the mapped agent_identity
 *   - expired mapping throws ExpiredError
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { query } from "../../../src/infra/postgres/pool.js";
import {
	ExpiredError,
	mapChannelIdentity,
	resolveChannelIdentity,
} from "../../../src/infra/messaging/channel-identity-mapper.js";

const TEST_AGENT = "test/p208-discord-agent";
const DISCORD_EXTERNAL_ID = "1234567890";
const DISCORD_EXPIRED_ID = "9999999999";

async function ensureAgent(identity: string) {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
		 VALUES ($1, 'llm')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

describe("Channel Identity Mapper (P208 AC#6)", () => {
	beforeEach(async () => {
		await ensureAgent(TEST_AGENT);
	});

	afterEach(async () => {
		await query(
			`DELETE FROM roadmap.channel_identities
			 WHERE agent_identity LIKE 'test/p208%'`,
		);
		await query(
			`DELETE FROM roadmap_workforce.agent_registry
			 WHERE agent_identity = $1`,
			[TEST_AGENT],
		);
	});

	describe("AC#6a: resolveChannelIdentity returns mapped agent_identity", () => {
		it("resolveChannelIdentity('discord', '1234567890') returns the mapped agent", async () => {
			await mapChannelIdentity({
				channel: "discord",
				externalId: DISCORD_EXTERNAL_ID,
				externalHandle: "@test-user",
				agentIdentity: TEST_AGENT,
				mappedBy: "gary",
			});

			const result = await resolveChannelIdentity("discord", DISCORD_EXTERNAL_ID);

			assert.ok(result, "expected a result, got null");
			assert.strictEqual(result.agentIdentity, TEST_AGENT);
			assert.strictEqual(result.channel, "discord");
			assert.strictEqual(result.externalId, DISCORD_EXTERNAL_ID);
		});

		it("returns null for unmapped identity", async () => {
			const result = await resolveChannelIdentity("discord", "no-such-id-p208");
			assert.strictEqual(result, null);
		});

		it("mapChannelIdentity is idempotent (ON CONFLICT update)", async () => {
			await mapChannelIdentity({
				channel: "discord",
				externalId: DISCORD_EXTERNAL_ID,
				agentIdentity: TEST_AGENT,
				mappedBy: "gary",
			});
			// Second call updates handle
			const updated = await mapChannelIdentity({
				channel: "discord",
				externalId: DISCORD_EXTERNAL_ID,
				externalHandle: "@updated-handle",
				agentIdentity: TEST_AGENT,
				mappedBy: "gary",
			});
			assert.strictEqual(updated.externalHandle, "@updated-handle");
		});
	});

	describe("AC#6b: expired mapping throws ExpiredError", () => {
		it("expired mapping throws ExpiredError", async () => {
			await mapChannelIdentity({
				channel: "discord",
				externalId: DISCORD_EXPIRED_ID,
				agentIdentity: TEST_AGENT,
				mappedBy: "gary",
				expiresAt: new Date(Date.now() - 1000), // 1 second in the past
			});

			await assert.rejects(
				() => resolveChannelIdentity("discord", DISCORD_EXPIRED_ID),
				(err: Error) => {
					assert.ok(err instanceof ExpiredError, `expected ExpiredError, got ${err.constructor.name}`);
					assert.ok(err.message.includes("discord"));
					assert.ok(err.message.includes(DISCORD_EXPIRED_ID));
					return true;
				},
			);
		});

		it("non-expired mapping does not throw", async () => {
			await mapChannelIdentity({
				channel: "discord",
				externalId: DISCORD_EXTERNAL_ID,
				agentIdentity: TEST_AGENT,
				mappedBy: "gary",
				expiresAt: new Date(Date.now() + 3_600_000), // 1 hour in the future
			});

			const result = await resolveChannelIdentity("discord", DISCORD_EXTERNAL_ID);
			assert.ok(result);
			assert.strictEqual(result.agentIdentity, TEST_AGENT);
		});

		it("mapping with no expiry resolves normally", async () => {
			await mapChannelIdentity({
				channel: "discord",
				externalId: DISCORD_EXTERNAL_ID,
				agentIdentity: TEST_AGENT,
				mappedBy: "gary",
			});

			const result = await resolveChannelIdentity("discord", DISCORD_EXTERNAL_ID);
			assert.ok(result);
			assert.strictEqual(result.expiresAt, null);
		});
	});
});
