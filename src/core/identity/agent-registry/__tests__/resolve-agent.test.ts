/**
 * P925: resolveAgentByIdentityOrAlias tests
 *
 * Covers:
 *   - Identity lookup always resolves (any status)
 *   - Alias lookup resolves only for non-terminal rows (status NOT IN inactive/retired)
 *   - Identity match wins when a row satisfies both predicates
 *   - Returns null when no row matches
 */

import { afterEach, describe, expect, it } from "vitest";
import { query } from "../../../../infra/postgres/pool";
import { resolveAgentByIdentityOrAlias } from "../registry";

const TEST_PREFIX = "p925-resolve-test-";

async function insertAgent(
	identity: string,
	status: string,
	alias: string | null,
): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
			(agent_identity, agent_type, status, display_alias)
		 VALUES ($1, 'llm', $2, $3)
		 RETURNING id`,
		[identity, status, alias],
	);
	return rows[0]!.id;
}

describe("resolveAgentByIdentityOrAlias — P925", () => {
	afterEach(async () => {
		await query(
			`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1`,
			[`${TEST_PREFIX}%`],
		);
	});

	it("resolves by agent_identity regardless of status", async () => {
		await insertAgent(`${TEST_PREFIX}alpha`, "online", null);

		const row = await resolveAgentByIdentityOrAlias(`${TEST_PREFIX}alpha`);
		expect(row).not.toBeNull();
		expect(row!.agent_identity).toBe(`${TEST_PREFIX}alpha`);
	});

	it("resolves by display_alias when agent is online", async () => {
		await insertAgent(`${TEST_PREFIX}beta`, "online", "P925-Beta-Alias");

		const row = await resolveAgentByIdentityOrAlias("P925-Beta-Alias");
		expect(row).not.toBeNull();
		expect(row!.agent_identity).toBe(`${TEST_PREFIX}beta`);
	});

	it("does NOT resolve by alias when agent is inactive", async () => {
		await insertAgent(`${TEST_PREFIX}inactive`, "inactive", "P925-Inactive-Alias");

		const row = await resolveAgentByIdentityOrAlias("P925-Inactive-Alias");
		expect(row).toBeNull();
	});

	it("does NOT resolve by alias when agent is retired", async () => {
		await insertAgent(`${TEST_PREFIX}retired`, "retired", "P925-Retired-Alias");

		const row = await resolveAgentByIdentityOrAlias("P925-Retired-Alias");
		expect(row).toBeNull();
	});

	it("resolves by alias when agent is offline (not terminal)", async () => {
		await insertAgent(`${TEST_PREFIX}offline`, "offline", "P925-Offline-Alias");

		const row = await resolveAgentByIdentityOrAlias("P925-Offline-Alias");
		expect(row).not.toBeNull();
		expect(row!.agent_identity).toBe(`${TEST_PREFIX}offline`);
	});

	it("identity match takes precedence when value equals both identity and alias of different rows", async () => {
		// Row A: agent_identity = the shared value
		await insertAgent(`${TEST_PREFIX}shared-id`, "online", null);
		// Row B: display_alias = the shared value (different identity)
		await insertAgent(`${TEST_PREFIX}alias-holder`, "online", `${TEST_PREFIX}shared-id`);

		const row = await resolveAgentByIdentityOrAlias(`${TEST_PREFIX}shared-id`);
		expect(row).not.toBeNull();
		// Should return the identity match, not the alias match
		expect(row!.agent_identity).toBe(`${TEST_PREFIX}shared-id`);
	});

	it("returns null when no identity or alias matches", async () => {
		const row = await resolveAgentByIdentityOrAlias("no-such-agent-xyz-99999");
		expect(row).toBeNull();
	});
});
