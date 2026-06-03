/**
 * P925 AC-1: resolveAgentByIdentityOrAlias unit tests
 *
 * Covers:
 *   - identity hit (any status)
 *   - alias hit (active row)
 *   - alias on inactive row returns null (only identity path resolves it)
 *   - no match returns null
 *   - empty/null value returns null
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { query } from "../../../../infra/postgres/pool.ts";
import { resolveAgentByIdentityOrAlias } from "../registry.ts";

const TEST_PREFIX = "test-p925-resolve";

async function insertAgent(opts: {
	identity: string;
	status?: string;
	display_alias?: string;
}): Promise<void> {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, role, status, display_alias)
		 VALUES ($1, 'contract', 'test-role', $2, $3)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   status        = EXCLUDED.status,
		   display_alias = EXCLUDED.display_alias`,
		[opts.identity, opts.status ?? "online", opts.display_alias ?? null],
	);
}

describe("resolveAgentByIdentityOrAlias — P925 AC-1", () => {
	afterEach(async () => {
		await query(
			`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1`,
			[`${TEST_PREFIX}-%`],
		);
	});

	it("returns null for empty string", async () => {
		const result = await resolveAgentByIdentityOrAlias("");
		expect(result).toBeNull();
	});

	it("returns null for whitespace-only string", async () => {
		const result = await resolveAgentByIdentityOrAlias("   ");
		expect(result).toBeNull();
	});

	it("resolves by agent_identity regardless of status", async () => {
		const identity = `${TEST_PREFIX}-identity-hit`;
		await insertAgent({ identity, status: "offline" });

		const result = await resolveAgentByIdentityOrAlias(identity);
		expect(result).not.toBeNull();
		expect(result!.agent_identity).toBe(identity);
		expect(result!.status).toBe("offline");
	});

	it("resolves by display_alias for an active row", async () => {
		const identity = `${TEST_PREFIX}-alias-active`;
		const alias = "TestAliasActive";
		await insertAgent({ identity, status: "online", display_alias: alias });

		const result = await resolveAgentByIdentityOrAlias(alias);
		expect(result).not.toBeNull();
		expect(result!.agent_identity).toBe(identity);
		expect(result!.display_alias).toBe(alias);
	});

	it("returns null when alias belongs only to an inactive row", async () => {
		const identity = `${TEST_PREFIX}-alias-inactive`;
		const alias = "TestAliasInactive";
		await insertAgent({ identity, status: "inactive", display_alias: alias });

		// alias lookup excludes 'inactive'
		const result = await resolveAgentByIdentityOrAlias(alias);
		expect(result).toBeNull();

		// but identity lookup still works
		const byIdentity = await resolveAgentByIdentityOrAlias(identity);
		expect(byIdentity).not.toBeNull();
		expect(byIdentity!.agent_identity).toBe(identity);
	});

	it("returns null when neither identity nor alias matches", async () => {
		const result = await resolveAgentByIdentityOrAlias("does-not-exist-p925");
		expect(result).toBeNull();
	});

	it("identity lookup takes precedence over alias lookup", async () => {
		// Two rows: one whose agent_identity equals the alias of the other
		const aliasValue = `${TEST_PREFIX}-overlap-id`;
		const holder = `${TEST_PREFIX}-overlap-holder`;
		await insertAgent({ identity: aliasValue, status: "online" });
		await insertAgent({ identity: holder, status: "online", display_alias: aliasValue });

		// Should return the row whose agent_identity = aliasValue (identity wins)
		const result = await resolveAgentByIdentityOrAlias(aliasValue);
		expect(result).not.toBeNull();
		expect(result!.agent_identity).toBe(aliasValue);
	});
});
