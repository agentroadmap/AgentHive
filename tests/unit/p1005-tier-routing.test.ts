/**
 * P1005: Task Tier Routing Unit Tests
 *
 * AC-8: Verify Tier-0 isolation — Tier-0 requests never route to Tier-3 providers
 * AC-5/6/7: Verify job runner structured output formats
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { QueryFn } from "../../src/core/orchestration/resolvers/agency-resolver.ts";
import {
	resolveAgency,
	_setQueryForTest,
} from "../../src/core/orchestration/resolvers/agency-resolver.ts";
import {
	executeTier0Job,
	handleRateLimit,
	type Tier0Job,
} from "../../src/infra/agency/tier0-job-runner.ts";

describe("P1005: Task Tier Routing", () => {
	// ─── AC-8: Tier-0 Isolation (SQL verification) ────────────────────────────────

	describe("AC-8: Tier-0 isolation — SQL verification", () => {
		let queryCalls: Array<{ sql: string; params: unknown[] }> = [];

		beforeEach(() => {
			queryCalls = [];
		});

		it("should include tier=0 filter in SQL when taskTier=0 is requested", async () => {
			_setQueryForTest(async (sql: string, params: unknown[] = []) => {
				queryCalls.push({ sql, params });
				return { rows: [] } as any;
			});

			await resolveAgency("1", undefined, 0 /* Tier-0 */);

			const lastCall = queryCalls.at(-1);
			expect(lastCall?.sql).toBeDefined();
			// The SQL should filter for tier=0 specifically
			expect(lastCall!.sql).toMatch(/:int.*=\s*0/);
		});

		it("should include tier>=1 filter in SQL when taskTier=1 is requested", async () => {
			_setQueryForTest(async (sql: string, params: unknown[] = []) => {
				queryCalls.push({ sql, params });
				return { rows: [] } as any;
			});

			await resolveAgency("1", undefined, 1 /* Tier-1 */);

			const lastCall = queryCalls.at(-1);
			expect(lastCall?.sql).toBeDefined();
			// The SQL should filter for tier >= 1
			expect(lastCall!.sql).toMatch(/>=\s*1/);
		});

		it("should NOT include tier filter in SQL when taskTier is undefined", async () => {
			_setQueryForTest(async (sql: string, params: unknown[] = []) => {
				queryCalls.push({ sql, params });
				return { rows: [] } as any;
			});

			await resolveAgency("1" /* no taskTier parameter */);

			const lastCall = queryCalls.at(-1);
			expect(lastCall?.sql).toBeDefined();
			// Should not have the tier-specific filter when taskTier is not provided
			expect(lastCall!.sql).not.toMatch(/AND.*tier.*=\s*0/);
		});
	});

	// ─── AC-5: Test Runner Output ──────────────────────────────────────────────────

	describe("AC-5: test_run job returns structured results", () => {
		it("should have valid TestResult schema with required fields", async () => {
			const result = await executeTier0Job(
				{ job: "test_run" },
				{ cwd: ".", timeout_ms: 5000 },
			);

			// Result should have these fields even on partial failure
			expect(typeof result).toBe("object");
			expect("passed" in result).toBe(true);
			expect("failed" in result).toBe(true);
			expect("duration_ms" in result).toBe(true);
			expect("failures" in result).toBe(true);
			expect(Array.isArray((result as any).failures)).toBe(true);
		});
	});

	// ─── AC-6: Typecheck Output ───────────────────────────────────────────────────

	describe("AC-6: typecheck job returns structured results", () => {
		it("should have valid TypecheckResult schema", async () => {
			const result = await executeTier0Job(
				{ job: "typecheck" },
				{ cwd: ".", timeout_ms: 30000 },
			);

			expect(typeof result).toBe("object");
			expect("error_count" in result).toBe(true);
			expect("errors" in result).toBe(true);
			expect(Array.isArray((result as any).errors)).toBe(true);

			// Each error should have: file, line, code, message
			if ((result as any).errors.length > 0) {
				const err = (result as any).errors[0];
				expect("file" in err).toBe(true);
				expect("line" in err).toBe(true);
				expect("code" in err).toBe(true);
				expect("message" in err).toBe(true);
			}
		});
	});

	// ─── AC-7: Changelog Output ───────────────────────────────────────────────────

	describe("AC-7: changelog job returns markdown-formatted results", () => {
		it("should have valid ChangelogResult schema", async () => {
			const result = await executeTier0Job(
				{
					job: "changelog",
					params: {
						base_ref: "origin/main",
						head_ref: "HEAD",
					},
				},
				{ cwd: ".", timeout_ms: 10000 },
			);

			expect(typeof result).toBe("object");
			expect("markdown" in result).toBe(true);
			expect("commit_count" in result).toBe(true);

			// markdown should be a string (possibly empty)
			expect(typeof (result as any).markdown).toBe("string");
			expect(typeof (result as any).commit_count).toBe("number");
		});
	});

	// ─── AC-10: Rate Limiting ──────────────────────────────────────────────────────

	describe("AC-10: Rate limit handling returns task_error with retry_after_ms", () => {
		it("should return TaskError with default retry_after_ms", () => {
			const err = handleRateLimit();

			expect(typeof err).toBe("object");
			expect("error" in err).toBe(true);
			expect("retry_after_ms" in err).toBe(true);
			expect(typeof err.retry_after_ms).toBe("number");
			expect(err.retry_after_ms).toBeGreaterThan(0);
		});

		it("should return TaskError with custom retry_after_ms", () => {
			const customMs = 60_000;
			const err = handleRateLimit(customMs);

			expect(err.retry_after_ms).toBe(customMs);
		});

		it("should include 'Rate limited' in error message", () => {
			const err = handleRateLimit();

			expect(err.error).toMatch(/[Rr]ate.*limit/);
		});
	});

	// ─── Job Types ────────────────────────────────────────────────────────────────

	describe("Tier-0 job types", () => {
		const tier0Jobs: Tier0Job[] = [
			"test_run",
			"typecheck",
			"lint",
			"changelog",
			"log_tail",
			"dep_audit",
			"env_audit",
			"health_check",
			"boilerplate",
		];

		it("should have all required Tier-0 job types", () => {
			// This test documents the complete list
			expect(tier0Jobs.length).toBe(9);
		});

		it("should reject unknown job types", async () => {
			let threw = false;
			try {
				await executeTier0Job(
					{ job: "unknown_job" as any },
					{ cwd: ".", timeout_ms: 1000 },
				);
			} catch (err) {
				threw = true;
				expect(String(err)).toMatch(/Unknown.*job/);
			}
			expect(threw).toBe(true);
		});
	});
});
