import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getPool } from "../../src/infra/postgres/pool.ts";

describe("P748: Agent Role Profile Seed Coverage", () => {
	let pool: any;

	beforeAll(async () => {
		pool = getPool();
	});

	afterAll(async () => {
		// Pool cleanup is handled by the pool itself
	});

	it("verifies agent_role_profile table exists", async () => {
		const { rows } = await pool.query(
			`SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'roadmap'
       AND table_name = 'agent_role_profile'
     ) AS exists`,
		);

		expect(rows[0].exists).toBe(true);
	});

	it("verifies indexes exist for performance", async () => {
		const { rows: lookupIdx } = await pool.query(
			`SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'roadmap'
       AND tablename = 'agent_role_profile'
       AND indexname = 'idx_agent_role_profile_lookup'
     ) AS exists`,
		);

		const { rows: scopeIdx } = await pool.query(
			`SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'roadmap'
       AND tablename = 'agent_role_profile'
       AND indexname = 'idx_agent_role_profile_scope'
     ) AS exists`,
		);

		expect(lookupIdx[0].exists).toBe(true);
		expect(scopeIdx[0].exists).toBe(true);
	});

	it("verifies Standard RFC (template_id=14) has seed data", async () => {
		const { rows } = await pool.query(
			`SELECT COUNT(*) as count
       FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND scope = 'global'`,
		);

		expect(rows[0].count).toBeGreaterThanOrEqual(28); // 7 * 4 maturity+stage combos
	});

	it("verifies Hotfix (template_id=37) has seed data", async () => {
		const { rows } = await pool.query(
			`SELECT COUNT(*) as count
       FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 37
       AND scope = 'global'`,
		);

		expect(rows[0].count).toBeGreaterThanOrEqual(12); // 6 * 2 (DRAFT + DEVELOP)
	});

	it("verifies all Standard RFC stages have profiles", async () => {
		const stages = ["DRAFT", "REVIEW", "DEVELOP", "MERGE"];

		for (const stage of stages) {
			const { rows } = await pool.query(
				`SELECT COUNT(DISTINCT role) as role_count
         FROM roadmap.agent_role_profile
         WHERE workflow_template_id = 14
         AND stage = $1
         AND scope = 'global'`,
				[stage],
			);

			expect(rows[0].role_count).toBeGreaterThan(0);
		}
	});

	it("verifies DRAFT stage has expected roles", async () => {
		const { rows } = await pool.query(
			`SELECT role FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND stage = 'DRAFT'
       AND scope = 'global'
       AND maturity = 'new'
       ORDER BY priority ASC`,
		);

		const roles = rows.map((r: any) => r.role);
		expect(roles).toContain("researcher");
		expect(roles).toContain("architect");
	});

	it("verifies REVIEW stage has expected roles", async () => {
		const { rows } = await pool.query(
			`SELECT role FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND stage = 'REVIEW'
       AND scope = 'global'
       AND maturity = 'mature'
       ORDER BY priority ASC`,
		);

		const roles = rows.map((r: any) => r.role);
		expect(roles).toContain("skeptic-alpha");
		expect(roles).toContain("reviewer-d2");
	});

	it("verifies DEVELOP stage has expected roles", async () => {
		const { rows } = await pool.query(
			`SELECT role FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND stage = 'DEVELOP'
       AND scope = 'global'
       AND maturity = 'new'
       ORDER BY priority ASC`,
		);

		const roles = rows.map((r: any) => r.role);
		expect(roles).toContain("developer");
		expect(roles).toContain("engineer");
	});

	it("verifies MERGE stage has expected roles", async () => {
		const { rows } = await pool.query(
			`SELECT role FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND stage = 'MERGE'
       AND scope = 'global'
       AND maturity = 'mature'
       ORDER BY priority ASC`,
		);

		const roles = rows.map((r: any) => r.role);
		expect(roles).toContain("reviewer-d4");
		expect(roles[0]).toBe("reviewer-d4"); // must be first
	});

	it("verifies Hotfix only has DRAFT and DEVELOP", async () => {
		const { rows } = await pool.query(
			`SELECT DISTINCT stage FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 37
       AND scope = 'global'
       ORDER BY stage`,
		);

		const stages = rows.map((r: any) => r.stage);
		expect(stages).toEqual(["DEVELOP", "DRAFT"]); // sorted
		expect(stages).not.toContain("REVIEW");
		expect(stages).not.toContain("MERGE");
	});

	it("verifies maturity bands exist for all stages", async () => {
		const stages = ["DRAFT", "REVIEW", "DEVELOP", "MERGE"];

		for (const stage of stages) {
			const { rows: newRows } = await pool.query(
				`SELECT COUNT(*) as count
         FROM roadmap.agent_role_profile
         WHERE workflow_template_id = 14
         AND stage = $1
         AND maturity = 'new'`,
				[stage],
			);

			const { rows: activeRows } = await pool.query(
				`SELECT COUNT(*) as count
         FROM roadmap.agent_role_profile
         WHERE workflow_template_id = 14
         AND stage = $1
         AND maturity = 'active'`,
				[stage],
			);

			const { rows: matureRows } = await pool.query(
				`SELECT COUNT(*) as count
         FROM roadmap.agent_role_profile
         WHERE workflow_template_id = 14
         AND stage = $1
         AND maturity = 'mature'`,
				[stage],
			);

			expect(newRows[0].count).toBeGreaterThan(0);
			expect(activeRows[0].count).toBeGreaterThan(0);
			expect(matureRows[0].count).toBeGreaterThan(0);
		}
	});

	it("verifies new/active maturity have build agents", async () => {
		const { rows } = await pool.query(
			`SELECT DISTINCT role FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND maturity IN ('new', 'active')
       ORDER BY role`,
		);

		const buildRoles = rows.map((r: any) => r.role);
		expect(buildRoles).toContain("architect");
		expect(buildRoles).toContain("developer");
		expect(buildRoles).toContain("researcher");
	});

	it("verifies mature maturity have gate reviewers", async () => {
		const { rows } = await pool.query(
			`SELECT DISTINCT role FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND maturity = 'mature'
       ORDER BY role`,
		);

		const gateRoles = rows.map((r: any) => r.role);
		expect(gateRoles).toContain("skeptic-alpha");
		expect(gateRoles).toContain("reviewer-d2");
		expect(gateRoles).toContain("reviewer-d3");
		expect(gateRoles).toContain("reviewer-d4");
	});

	it("verifies priority ordering is unique within stage/maturity", async () => {
		const { rows } = await pool.query(
			`SELECT stage, maturity, priority, COUNT(*) as count
       FROM roadmap.agent_role_profile
       WHERE workflow_template_id = 14
       AND scope = 'global'
       GROUP BY stage, maturity, priority
       HAVING COUNT(*) > 1`,
		);

		// All priorities within a stage/maturity combo should be unique
		expect(rows).toHaveLength(0);
	});

	it("verifies UNIQUE constraint on (scope, project_id, workflow_template_id, stage, maturity, role)", async () => {
		// Try to insert a duplicate and expect it to fail
		const testRole = "test-duplicate-role";

		// First insert should succeed
		await pool.query(
			`INSERT INTO roadmap.agent_role_profile
       (scope, workflow_template_id, stage, maturity, role, priority)
       VALUES ('global', 14, 'DRAFT', 'new', $1, 999)`,
			[testRole],
		);

		// Second insert of same row should fail due to UNIQUE constraint
		let insertFailed = false;
		try {
			await pool.query(
				`INSERT INTO roadmap.agent_role_profile
         (scope, workflow_template_id, stage, maturity, role, priority)
         VALUES ('global', 14, 'DRAFT', 'new', $1, 999)`,
				[testRole],
			);
		} catch {
			insertFailed = true;
		}

		// Clean up test data
		await pool.query(
			`DELETE FROM roadmap.agent_role_profile
       WHERE role = $1 AND priority = 999`,
			[testRole],
		);

		expect(insertFailed).toBe(true);
	});

	it("verifies all profiles have required fields", async () => {
		const { rows } = await pool.query(
			`SELECT id, role, required_capabilities, priority, scope
       FROM roadmap.agent_role_profile
       WHERE workflow_template_id IN (14, 37)
       AND scope = 'global'
       LIMIT 50`,
		);

		for (const row of rows) {
			expect(row.id).toBeDefined();
			expect(row.role).toBeDefined();
			expect(Array.isArray(row.required_capabilities)).toBe(true);
			expect(typeof row.priority).toBe("number");
			expect(row.scope).toBe("global");
		}
	});
});
