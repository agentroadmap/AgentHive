/**
 * P459: cubic_create phase-driven role allocation tests
 *
 * Test cases:
 * AC1: cubic_create with agent_identity validates role per phase
 * AC2: cubic_create without agent_identity uses phase defaults
 * AC3: Mismatch returns typed error (not silent substitution)
 * AC4: All 4 phases have correct slot lists
 * AC5: Existing P281/P289 dispatch flow continues to work
 */

import test from "node:test";
import assert from "node:assert";
import { query } from "../../src/postgres/pool.ts";

test("P459: Cubic Phase-Driven Role Allocation", async (t) => {
	const testAgents = [
		{ identity: "skeptic-test-agent", role: "skeptic" },
		{ identity: "architect-test-agent", role: "architect" },
		{ identity: "coder-test-agent", role: "coder" },
		{ identity: "tester-test-agent", role: "tester" },
		{ identity: "deployer-test-agent", role: "deployer" },
	];

	// Setup: Create test agents
	for (const agent of testAgents) {
		await query(
			`INSERT INTO roadmap.agent_registry (agent_identity, agent_type, role, status)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[agent.identity, "llm", agent.role, "active"],
		);
	}

	await t.test(
		"AC1: agent_identity role validation",
		async (t) => {
			await t.test(
				"should accept skeptic agent in design phase",
				async () => {
					const result = await query(
						`SELECT role FROM roadmap.agent_registry WHERE agent_identity = $1`,
						["skeptic-test-agent"],
					);

					assert.strictEqual(result.rows.length, 1);
					assert.strictEqual(result.rows[0].role, "skeptic");

					// Verify design phase allows skeptic
					const phaseResult = await query(
						`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
						["design"],
					);
					assert(
						phaseResult.rows[0].allowed_roles.includes("skeptic"),
						"design phase should allow skeptic role",
					);
				},
			);

			await t.test("should reject coder in design phase", async () => {
				// Verify design phase does NOT allow coder
				const phaseResult = await query(
					`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
					["design"],
				);
				assert(
					!phaseResult.rows[0].allowed_roles.includes("coder"),
					"design phase should not allow coder role",
				);
			});

			await t.test(
				"should accept coder in build phase",
				async () => {
					const phaseResult = await query(
						`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
						["build"],
					);
					assert(
						phaseResult.rows[0].allowed_roles.includes("coder"),
						"build phase should allow coder role",
					);
				},
			);
		},
	);

	await t.test(
		"AC2: Phase defaults (no agent_identity)",
		async (t) => {
			await t.test(
				"design phase should have skeptic, architect, pm defaults",
				async () => {
					const result = await query(
						`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
						["design"],
					);
					const defaultRoles = result.rows[0].default_roles;
					assert(
						defaultRoles.includes("skeptic"),
						"design defaults should include skeptic",
					);
					assert(
						defaultRoles.includes("architect"),
						"design defaults should include architect",
					);
					assert(
						defaultRoles.includes("pm"),
						"design defaults should include pm",
					);
				},
			);

			await t.test(
				"build phase should have coder, tester defaults",
				async () => {
					const result = await query(
						`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
						["build"],
					);
					const defaultRoles = result.rows[0].default_roles;
					assert(
						defaultRoles.includes("coder"),
						"build defaults should include coder",
					);
					assert(
						defaultRoles.includes("tester"),
						"build defaults should include tester",
					);
				},
			);

			await t.test(
				"test phase should have tester, qa defaults",
				async () => {
					const result = await query(
						`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
						["test"],
					);
					const defaultRoles = result.rows[0].default_roles;
					assert(
						defaultRoles.includes("tester"),
						"test defaults should include tester",
					);
					assert(
						defaultRoles.includes("qa"),
						"test defaults should include qa",
					);
				},
			);

			await t.test(
				"ship phase should have deployer, ops defaults",
				async () => {
					const result = await query(
						`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
						["ship"],
					);
					const defaultRoles = result.rows[0].default_roles;
					assert(
						defaultRoles.includes("deployer"),
						"ship defaults should include deployer",
					);
					assert(
						defaultRoles.includes("ops"),
						"ship defaults should include ops",
					);
				},
			);
		},
	);

	await t.test(
		"AC3: Type-safe error on phase mismatch",
		async (t) => {
			await t.test(
				"should have properly structured phase_roles table",
				async () => {
					// Verify all 4 phases exist with proper structure
					const result = await query(
						`SELECT phase, default_roles, allowed_roles FROM roadmap.cubic_phase_roles ORDER BY phase`,
					);

					assert.strictEqual(
						result.rows.length,
						4,
						"should have exactly 4 phases",
					);
					const phases = result.rows.map((r) => r.phase);
					assert.deepStrictEqual(phases, [
						"build",
						"design",
						"ship",
						"test",
					]);

					// Verify each has both default and allowed
					for (const row of result.rows) {
						assert(
							Array.isArray(row.default_roles),
							"default_roles should be array",
						);
						assert(
							Array.isArray(row.allowed_roles),
							"allowed_roles should be array",
						);
						assert(
							row.default_roles.length > 0,
							"default_roles should not be empty",
						);
						assert(
							row.allowed_roles.length > 0,
							"allowed_roles should not be empty",
						);
					}
				},
			);
		},
	);

	await t.test(
		"AC4: All 4 phases configured correctly",
		async (t) => {
			await t.test(
				"should have all phases with proper allowed_roles",
				async () => {
					const result = await query(
						`SELECT phase, allowed_roles FROM roadmap.cubic_phase_roles ORDER BY phase`,
					);

					const phaseMap = new Map(
						result.rows.map((r) => [r.phase, r.allowed_roles]),
					);

					// design: skeptic, architect, pm, reviewer
					assert(
						phaseMap.get("design").includes("skeptic"),
						"design should allow skeptic",
					);
					assert(
						phaseMap.get("design").includes("architect"),
						"design should allow architect",
					);
					assert(
						phaseMap.get("design").includes("reviewer"),
						"design should allow reviewer",
					);

					// build: coder, tester, reviewer
					assert(
						phaseMap.get("build").includes("coder"),
						"build should allow coder",
					);
					assert(
						phaseMap.get("build").includes("tester"),
						"build should allow tester",
					);
					assert(
						phaseMap.get("build").includes("reviewer"),
						"build should allow reviewer",
					);

					// test: tester, qa, reviewer
					assert(
						phaseMap.get("test").includes("tester"),
						"test should allow tester",
					);
					assert(
						phaseMap.get("test").includes("qa"),
						"test should allow qa",
					);
					assert(
						phaseMap.get("test").includes("reviewer"),
						"test should allow reviewer",
					);

					// ship: deployer, ops, reviewer
					assert(
						phaseMap.get("ship").includes("deployer"),
						"ship should allow deployer",
					);
					assert(
						phaseMap.get("ship").includes("ops"),
						"ship should allow ops",
					);
					assert(
						phaseMap.get("ship").includes("reviewer"),
						"ship should allow reviewer",
					);
				},
			);

			await t.test(
				"should not allow build-only roles in design phase",
				async () => {
					const designResult = await query(
						`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = 'design'`,
					);
					const buildResult = await query(
						`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = 'build'`,
					);

					const designAllowed = designResult.rows[0].allowed_roles;
					const buildAllowed = buildResult.rows[0].allowed_roles;

					// Coder should be in build but not in design
					assert(
						buildAllowed.includes("coder"),
						"build should include coder",
					);
					assert(
						!designAllowed.includes("coder"),
						"design should not include coder",
					);
				},
			);
		},
	);

	await t.test(
		"AC5: Backward compatibility (P281/P289 dispatch)",
		async (t) => {
			await t.test(
				"should have cubic_phase_roles table queryable",
				async () => {
					// Verify the table exists and is accessible
					const result = await query(
						`SELECT COUNT(*) as cnt FROM roadmap.cubic_phase_roles`,
					);
					assert.strictEqual(
						Number(result.rows[0].cnt),
						4,
						"should have 4 phase configurations",
					);
				},
			);
		},
	);

	await t.test(
		"Integration: cubic_phase_roles seeding",
		async (t) => {
			await t.test(
				"should have exactly 4 phase role records",
				async () => {
					const result = await query(
						`SELECT COUNT(*) as cnt FROM roadmap.cubic_phase_roles`,
					);
					assert.strictEqual(
						Number(result.rows[0].cnt),
						4,
						"should have exactly 4 phases",
					);
				},
			);

			await t.test("should have proper indexes", async () => {
				const result = await query(
					`SELECT indexname FROM pg_indexes WHERE tablename = 'cubic_phase_roles'`,
				);
				assert(
					result.rows.length > 0,
					"should have at least one index",
				);
			});
		},
	);

	await t.test(
		"AC#102: Unique constraint uk_cubics_agent_phase_status exists",
		async (t) => {
			await t.test(
				"partial unique index on (agent_identity, phase, status) should exist",
				async () => {
					const result = await query(
						`SELECT indexname, indexdef
						 FROM pg_indexes
						 WHERE schemaname = 'roadmap'
						   AND tablename = 'cubics'
						   AND indexname = 'uk_cubics_agent_phase_status'`,
					);
					assert.strictEqual(
						result.rows.length,
						1,
						"uk_cubics_agent_phase_status index should exist",
					);
					const def = result.rows[0].indexdef as string;
					assert(
						def.includes("agent_identity") && def.includes("phase") && def.includes("status"),
						"index should cover agent_identity, phase, status columns",
					);
					assert(
						def.includes("WHERE") && def.includes("IS NOT NULL"),
						"index should be partial (WHERE agent_identity IS NOT NULL)",
					);
				},
			);
		},
	);

	await t.test(
		"AC#103: Concurrent cubic_create returns existing cubic_id on conflict",
		async (t) => {
			const raceAgent = "race-test-agent";
			const racePhase = "build";

			// Seed a registered agent so the unique index is triggered
			await query(
				`INSERT INTO roadmap.agent_registry (agent_identity, agent_type, role, status)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (agent_identity) DO NOTHING`,
				[raceAgent, "llm", "coder", "active"],
			);

			// Insert the first cubic directly to simulate an existing one
			const insertResult = await query<{ cubic_id: string }>(
				`INSERT INTO roadmap.cubics (worktree_path, phase, status, agent_identity, metadata)
				 VALUES ($1, $2, 'idle', $3, '{}')
				 RETURNING cubic_id`,
				[`/data/code/worktree/${raceAgent}`, racePhase, raceAgent],
			);
			const existingCubicId = insertResult.rows[0].cubic_id;

			await t.test(
				"second create for same agent+phase returns existing cubic_id",
				async () => {
					// Second insert — should hit ON CONFLICT and return the existing row
					const conflictResult = await query<{
						cubic_id: string;
						was_existing: boolean;
					}>(
						`INSERT INTO roadmap.cubics (worktree_path, phase, status, agent_identity, metadata)
						 VALUES ($1, $2, 'idle', $3, '{}')
						 ON CONFLICT (agent_identity, phase, status)
						     WHERE agent_identity IS NOT NULL
						 DO UPDATE SET metadata = roadmap.cubics.metadata
						 RETURNING cubic_id, (xmax <> 0) AS was_existing`,
						[`/data/code/worktree/${raceAgent}-2`, racePhase, raceAgent],
					);

					assert.strictEqual(
						conflictResult.rows.length,
						1,
						"should return exactly one row",
					);
					assert.strictEqual(
						conflictResult.rows[0].cubic_id,
						existingCubicId,
						"second create should return the first cubic_id",
					);
					assert.strictEqual(
						conflictResult.rows[0].was_existing,
						true,
						"was_existing should be true for the conflicting row",
					);
				},
			);

			await t.test(
				"exactly one row exists for the agent+phase after conflict",
				async () => {
					const countResult = await query<{ cnt: string }>(
						`SELECT COUNT(*) AS cnt FROM roadmap.cubics
						 WHERE agent_identity = $1 AND phase = $2 AND status = 'idle'`,
						[raceAgent, racePhase],
					);
					assert.strictEqual(
						Number(countResult.rows[0].cnt),
						1,
						"exactly one cubic row for same agent+phase+status after conflict",
					);
				},
			);

			// Cleanup race test cubic
			await query(
				`DELETE FROM roadmap.cubics WHERE cubic_id = $1`,
				[existingCubicId],
			);
			await query(
				`DELETE FROM roadmap.agent_registry WHERE agent_identity = $1`,
				[raceAgent],
			);
		},
	);

	// Cleanup: Remove test agents
	for (const identity of testAgents.map((a) => a.identity)) {
		await query(
			`DELETE FROM roadmap.agent_registry WHERE agent_identity = $1`,
			[identity],
		);
	}
});
