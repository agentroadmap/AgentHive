/**
 * P1290: Capability coverage CI check.
 *
 * Verifies every capability in ROLE_TO_REQUIRED_CAPABILITIES maps to at least
 * one dispatchable agency in provider_registry. Exits 1 if any gap is found.
 *
 * Usage:
 *   npm run check:capability-coverage
 *
 * Core logic lives in src/core/orchestration/capability-coverage.ts so the
 * Orchestrator can run the same check at boot (warn-only, no process.exit).
 */

import {
	checkCapabilityCoverage,
	hasGaps,
} from "../src/core/orchestration/capability-coverage.ts";
import { closePool } from "../src/infra/postgres/pool.ts";

(async () => {
	try {
		const results = await checkCapabilityCoverage();
		await closePool();
		process.exit(hasGaps(results) ? 1 : 0);
	} catch (err) {
		console.error("[capability-coverage] fatal:", err);
		await closePool().catch(() => {});
		process.exit(1);
	}
})();
