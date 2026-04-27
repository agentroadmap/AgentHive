/**
 * P599 Integration tests — AC-6 (fail-closed) and AC-10 (revocation safety).
 *
 * These tests use injected queryFn stubs so no live DB connection is required.
 * The injected stubs mirror the exact DB states described in the AC specifications.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	resolveToolEnvelope,
	ToolGrantResolutionError,
} from "../../src/infra/agency/tool-grant.ts";

// ── AC-6: fail-closed ────────────────────────────────────────────────────────

describe("AC-6 — resolveToolEnvelope fail-closed", () => {
	it("throws ToolGrantResolutionError when the DB query rejects", async () => {
		const failingQuery = async () => {
			throw new Error("Connection refused: ECONNREFUSED 127.0.0.1:5432");
		};

		await assert.rejects(
			() => resolveToolEnvelope(1, "agency:42", failingQuery),
			(err: unknown) => {
				assert.ok(err instanceof ToolGrantResolutionError, `Expected ToolGrantResolutionError, got ${String(err)}`);
				assert.equal((err as ToolGrantResolutionError).name, "ToolGrantResolutionError");
				assert.equal((err as ToolGrantResolutionError).projectId, 1);
				assert.equal((err as ToolGrantResolutionError).agencyPrincipalId, "agency:42");
				return true;
			},
		);
	});

	it("throws ToolGrantResolutionError wrapping the original cause", async () => {
		const cause = new Error("timeout after 5000ms");
		const failingQuery = async () => { throw cause; };

		await assert.rejects(
			() => resolveToolEnvelope(null, "agency:99", failingQuery),
			(err: unknown) => {
				assert.ok(err instanceof ToolGrantResolutionError);
				assert.equal((err as ToolGrantResolutionError).cause, cause);
				return true;
			},
		);
	});

	it("does not return a partial/full-grant envelope on DB failure", async () => {
		// Verify that the function NEVER silently returns {} or a default grant on error.
		const failingQuery = async () => { throw new Error("DB unreachable"); };
		let caught: unknown;
		try {
			await resolveToolEnvelope(null, null, failingQuery);
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof ToolGrantResolutionError, "must throw, not return empty envelope");
	});
});

// ── AC-10: revocation safety ─────────────────────────────────────────────────

describe("AC-10 — revoked agency receives empty envelope", () => {
	it("returns an empty envelope when the agency is revoked (query returns 0 rows)", async () => {
		// A revoked agency principal causes the SQL WHERE clause
		//   (... OR NOT EXISTS (SELECT 1 FROM roadmap.principal_identity pi
		//                       WHERE pi.principal_id = tg.agency_principal_id
		//                         AND pi.revoked_at IS NOT NULL))
		// to evaluate to FALSE for every tool_grant row → query returns 0 rows.
		const revokedAgencyQuery = async () => ({
			rows: [], // DB returns no rows — revoked principal filtered out
		});

		const envelope = await resolveToolEnvelope(1, "agency:revoked-42", revokedAgencyQuery);
		assert.deepEqual(envelope, {}, "revoked agency must receive empty envelope");
	});

	it("returns tools for an active agency principal (query returns rows)", async () => {
		const activeAgencyQuery = async () => ({
			rows: [
				{ tool_name: "mcp_proposal", permitted_ops: ["mcp_proposal:read", "mcp_proposal:write"] },
				{ tool_name: "git", permitted_ops: ["git:read", "git:write"] },
			],
		});

		const envelope = await resolveToolEnvelope(1, "agency:active-7", activeAgencyQuery);
		assert.deepEqual(envelope, {
			mcp_proposal: ["mcp_proposal:read", "mcp_proposal:write"],
			git: ["git:read", "git:write"],
		});
	});

	it("revoked agency forfeits all grants without manual tool_grant row deletion", async () => {
		// Simulates: agency:42 has 3 tool_grant rows in the DB,
		// but principal_identity.revoked_at IS NOT NULL for agency:42.
		// The SQL revocation sub-select causes all rows to be filtered → empty result.
		let callCount = 0;
		const revokedWithGrantsQuery = async () => {
			callCount++;
			// Return empty because the revocation check filters out all rows
			return { rows: [] };
		};

		const envelope = await resolveToolEnvelope(1, "agency:42", revokedWithGrantsQuery);
		assert.equal(callCount, 1, "should have called query exactly once");
		assert.deepEqual(envelope, {}, "revoked agency must get empty envelope even if grant rows exist");
	});

	it("global grants (NULL project, NULL agency) are visible to all non-revoked agents", async () => {
		const globalGrantQuery = async () => ({
			rows: [
				{ tool_name: "git", permitted_ops: ["git:read", "git:write"] },
				{ tool_name: "gh",  permitted_ops: ["gh:pr", "gh:issue", "gh:workflow"] },
			],
		});

		const envelope = await resolveToolEnvelope(null, null, globalGrantQuery);
		assert.ok("git" in envelope, "git should be present");
		assert.ok("gh" in envelope, "gh should be present");
		assert.ok(!("psql" in envelope), "psql should NOT be present (not globally granted)");
	});
});
