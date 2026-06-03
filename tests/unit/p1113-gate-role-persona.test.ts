/**
 * P1113: Unit tests for resolvePersonaByRoleName.
 *
 * Pure-mocked: no DB, no Pool. Verifies the three-tier lookup order:
 *   1. BUILTIN_FALLBACK match by role name
 *   2. gate_role table (WHERE role = $1)
 *   3. agent_role_profile table (prompt_template->>'system')
 *   4. null when no match anywhere
 *   5. DB error swallowed → returns null (never throws)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePersonaByRoleName, type QueryFn } from "../../src/core/orchestration/gate-role-resolver.ts";

function makeQueryFn(rows: Record<string, unknown>[]): QueryFn {
	return async () => ({ rows });
}

function makeSequentialQueryFn(responses: Record<string, unknown>[][]): QueryFn {
	let callIndex = 0;
	return async () => {
		const rows = responses[callIndex] ?? [];
		callIndex++;
		return { rows };
	};
}

function throwingQueryFn(): QueryFn {
	return async () => {
		throw new Error("DB connection refused");
	};
}

test("resolvePersonaByRoleName: returns BUILTIN_FALLBACK persona for 'skeptic-alpha'", async () => {
	// queryFn should never be called — BUILTIN_FALLBACK matches first
	let queryCalled = false;
	const queryFn: QueryFn = async () => {
		queryCalled = true;
		return { rows: [] };
	};

	const result = await resolvePersonaByRoleName("skeptic-alpha", queryFn);

	assert.equal(queryCalled, false, "DB must not be queried when BUILTIN_FALLBACK matches");
	assert.ok(typeof result === "string" && result.length > 0, "should return a non-empty persona");
	assert.ok(result!.includes("SKEPTIC ALPHA"), "should be the D1 persona text");
});

test("resolvePersonaByRoleName: returns BUILTIN_FALLBACK persona for 'architecture-reviewer'", async () => {
	const result = await resolvePersonaByRoleName("architecture-reviewer", makeQueryFn([]));
	assert.ok(typeof result === "string" && result!.includes("Architecture Reviewer"), "should be D2 persona");
});

test("resolvePersonaByRoleName: returns BUILTIN_FALLBACK persona for 'skeptic-beta'", async () => {
	const result = await resolvePersonaByRoleName("skeptic-beta", makeQueryFn([]));
	assert.ok(typeof result === "string" && result!.includes("SKEPTIC BETA"), "should be D3 persona");
});

test("resolvePersonaByRoleName: returns BUILTIN_FALLBACK persona for 'gate-reviewer'", async () => {
	const result = await resolvePersonaByRoleName("gate-reviewer", makeQueryFn([]));
	assert.ok(typeof result === "string" && result!.includes("Integration Reviewer"), "should be D4 persona");
});

test("resolvePersonaByRoleName: falls through to gate_role table when no BUILTIN match", async () => {
	const customPersona = "You are a custom gate agent for this project.";
	// First query (gate_role) returns the custom persona
	const queryFn = makeSequentialQueryFn([[{ persona: customPersona }], []]);

	const result = await resolvePersonaByRoleName("custom-gate-role", queryFn);
	assert.equal(result, customPersona);
});

test("resolvePersonaByRoleName: falls through to agent_role_profile when gate_role returns empty", async () => {
	const profilePersona = "You are a profile-based agent.";
	// First query (gate_role) returns no rows; second (agent_role_profile) returns the persona
	const queryFn = makeSequentialQueryFn([[], [{ persona: profilePersona }]]);

	const result = await resolvePersonaByRoleName("developer", queryFn);
	assert.equal(result, profilePersona);
});

test("resolvePersonaByRoleName: returns null when neither DB table has a match", async () => {
	// Both queries return empty rows
	const queryFn = makeSequentialQueryFn([[], []]);

	const result = await resolvePersonaByRoleName("unknown-role-xyz", queryFn);
	assert.equal(result, null);
});

test("resolvePersonaByRoleName: swallows DB errors and returns null (never throws)", async () => {
	const result = await resolvePersonaByRoleName("some-role", throwingQueryFn());
	assert.equal(result, null, "DB error must be swallowed — null returned, not thrown");
});

test("resolvePersonaByRoleName: gate_role row with empty string persona falls through to agent_role_profile", async () => {
	const profilePersona = "Fallthrough profile persona.";
	// gate_role returns a row but with empty string — must skip to next tier
	const queryFn = makeSequentialQueryFn([[{ persona: "" }], [{ persona: profilePersona }]]);

	const result = await resolvePersonaByRoleName("some-role", queryFn);
	assert.equal(result, profilePersona);
});

test("resolvePersonaByRoleName: agent_role_profile row with empty string yields null", async () => {
	// Both tiers return non-null but empty — should return null
	const queryFn = makeSequentialQueryFn([[{ persona: "" }], [{ persona: "" }]]);

	const result = await resolvePersonaByRoleName("some-role", queryFn);
	assert.equal(result, null);
});
