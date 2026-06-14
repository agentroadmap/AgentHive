/**
 * P1109 Tier-1 & Tier-4: Schema introspection and migration linting tests
 *
 * AC-1/AC-8: describeTable returns table structure with columns, constraints, triggers, indexes.
 * AC-12: lintMigration wraps SQL execution in SAVEPOINT/ROLLBACK.
 * AC-13: lintMigration catches fabrication patterns (invalid CHECK values, JSDoc comments).
 *
 * Tests that touch the DB must use BEGIN/ROLLBACK and be env-gated (AGENTHIVE_RESOLVER_DB_TEST=1)
 * so they never pollute the live DB.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { describeTable, lintMigration } from "./pg-handlers.ts";

const skipIfNoDb = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1" ? describe : describe.skip;

skipIfNoDb("P1109 Tier-1 & Tier-4: Schema introspection and linting", () => {
	beforeAll(async () => {
		// Ensure we can connect to the DB
		const { query } = await import("../../../../infra/postgres/pool.ts");
		try {
			await query("SELECT 1");
		} catch (err) {
			console.error("DB connection failed:", (err as Error).message);
			throw err;
		}
	});

	describe("describeTable — AC-1/AC-8", () => {
		it("should describe a qualified table (roadmap.agency)", async () => {
			const result = await describeTable("roadmap.agency");
			expect(result.found).toBe(true);
			expect(result.schema).toBe("roadmap");
			expect(result.table).toBe("agency");
			expect(result.columns.length).toBeGreaterThan(0);

			// Verify at least one column is returned with expected structure
			const firstCol = result.columns[0];
			expect(firstCol.column_name).toBeDefined();
			expect(firstCol.data_type).toBeDefined();
		});

		it("should describe a bare table name and resolve it correctly", async () => {
			const result = await describeTable("agency");
			expect(result.found).toBe(true);
			expect(result.schema).toBe("roadmap");
			expect(result.table).toBe("agency");
		});

		it("should return error for non-existent table", async () => {
			const result = await describeTable("nonexistent_table_xyz");
			expect(result.found).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.columns.length).toBe(0);
		});

		it("should include CHECK constraints when present", async () => {
			// message_ledger has CHECK constraints on role and created_by_role
			const result = await describeTable("message_ledger");
			expect(result.found).toBe(true);

			if (result.check_constraints.length > 0) {
				const constraint = result.check_constraints[0];
				expect(constraint.name).toBeDefined();
				expect(constraint.definition).toBeDefined();
			}
		});

		it("should include indexes when present", async () => {
			const result = await describeTable("roadmap.agency");
			expect(result.found).toBe(true);
			// agency table should have indexes
			expect(result.indexes.length).toBeGreaterThan(0);

			const index = result.indexes[0];
			expect(index.name).toBeDefined();
			expect(typeof index.is_unique).toBe("boolean");
			expect(index.definition).toBeDefined();
		});
	});

	describe("lintMigration — AC-12", () => {
		it("should accept valid SQL (CREATE TABLE in transaction)", async () => {
			const validSql = `
        CREATE TEMPORARY TABLE test_lint_valid (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL
        );
        DROP TABLE test_lint_valid;
      `;
			const result = await lintMigration(validSql);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should reject JSDoc comment blocks — AC-13 (fabrication detection)", async () => {
			const jsDocSql = `
        /** This is JSDoc */
        CREATE TABLE test_table (id UUID PRIMARY KEY);
      `;
			const result = await lintMigration(jsDocSql);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("JSDoc");
		});

		it("should reject SQL with invalid CHECK constraint value — AC-13", async () => {
			// Create a table with a CHECK constraint and try to INSERT a value that violates it
			const invalidCheckSql = `
        CREATE TABLE test_check_constraint (
          id UUID PRIMARY KEY,
          status TEXT CHECK (status IN ('active', 'inactive'))
        );
        INSERT INTO test_check_constraint (id, status) VALUES (gen_random_uuid(), 'invalid_status');
        DROP TABLE test_check_constraint;
      `;
			const result = await lintMigration(invalidCheckSql);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			// PostgreSQL error will mention CHECK constraint violation
			expect(result.errors[0].toLowerCase()).toMatch(/check|violates/);
		});

		it("should reject SQL referencing non-existent columns — AC-13", async () => {
			const fabricatedColSql = `
        UPDATE roadmap.agency SET nonexistent_column = 'value' WHERE id = 'test';
      `;
			const result = await lintMigration(fabricatedColSql);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			// PostgreSQL will report "column does not exist"
			expect(result.errors[0]).toMatch(/column|does not exist/i);
		});

		it("should preserve BEGIN/END inside dollar-quoted functions", async () => {
			const functionSql = `
        CREATE OR REPLACE FUNCTION test_fn() RETURNS void AS $$
        BEGIN
          RAISE NOTICE 'test';
        END;
        $$ LANGUAGE plpgsql;

        DROP FUNCTION test_fn();
      `;
			const result = await lintMigration(functionSql);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should strip top-level BEGIN/COMMIT and still execute correctly", async () => {
			const sqlWithTxn = `
        BEGIN;
        CREATE TEMPORARY TABLE test_strip_txn (id UUID PRIMARY KEY);
        DROP TABLE test_strip_txn;
        COMMIT;
      `;
			const result = await lintMigration(sqlWithTxn);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});
	});
});
