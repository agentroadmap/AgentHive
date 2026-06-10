import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runMonitorCycle } from "../../src/core/schema-drift/monitor.ts";

/**
 * P675 AC-21: Integration test verifying that SCHEMA_DRIFT_LOG_INPUT
 * environment variable allows injection of synthetic logs for testing
 * without requiring journalctl or adm-group privileges.
 */

describe("AC-21: Journalctl abstraction - injected log input", () => {
	it("accepts SCHEMA_DRIFT_LOG_INPUT env to provide synthetic logs", async () => {
		// Create a temporary file with synthetic schema-drift log lines
		const tmpFile = join(tmpdir(), `schema-drift-test-${Date.now()}.log`);
		const logContent = [
			`Apr 28 07:00:00 bot node[1234]: Error in handleListRoutes: column "cost_per_1k_input" does not exist`,
			`Apr 28 07:00:01 bot node[1235]: Some unrelated log line`,
			`Apr 28 07:00:02 bot node[1236]: Executed query: SELECT id, cost_per_1k_input FROM model_routes WHERE id = 1 -- error: column "cost_per_1k_input" does not exist`,
		].join("\n");

		writeFileSync(tmpFile, logContent, "utf8");

		// Mock database pool (simplified for this test)
		const dbQueries: any[] = [];
		const pool: any = {
			query: async (text: string, params: any[] = []) => {
				dbQueries.push({ text, params });
				if (/SELECT fingerprint, occurrence_count/.test(text)) {
					// First occurrence — no existing row
					return { rows: [] };
				}
				if (/INSERT INTO roadmap.schema_drift_seen/.test(text)) {
					return { rows: [] };
				}
				return { rows: [] };
			},
		};

		// Run the monitor with injected log input
		const oldEnv = process.env.SCHEMA_DRIFT_LOG_INPUT;
		process.env.SCHEMA_DRIFT_LOG_INPUT = tmpFile;

		try {
			const result = await runMonitorCycle({
				pool,
				repoRoot: "/tmp/r",
				createHotfixProposal: async (args) => ({
					id: 999,
					displayId: "P999",
				}),
				log: () => {},
				warn: () => {},
			});

			// AC-21: Verify that the monitor successfully processed injected logs
			assert.ok(result.scanned > 0, "expected to scan at least one log line");
			assert.ok(
				result.uniqueFingerprints > 0,
				"expected to extract at least one unique fingerprint",
			);
			assert.ok(
				result.newHotfixes > 0,
				"expected to file at least one hotfix proposal",
			);

			// Verify that an INSERT query was executed (hotfix proposal was filed)
			const insertQueries = dbQueries.filter((q) =>
				/INSERT INTO roadmap.schema_drift_seen/.test(q.text),
			);
			assert.ok(insertQueries.length > 0, "expected at least one INSERT query");

			console.log(
				`[AC-21] Successfully processed ${result.scanned} log lines via injected input file`,
			);
		} finally {
			// Restore env
			if (oldEnv === undefined) {
				delete process.env.SCHEMA_DRIFT_LOG_INPUT;
			} else {
				process.env.SCHEMA_DRIFT_LOG_INPUT = oldEnv;
			}
		}
	});
});
