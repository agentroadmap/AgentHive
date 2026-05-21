#!/usr/bin/env bun
/**
 * P1290 AC-5: Health check script that verifies all capabilities referenced by
 * ROLE_TO_REQUIRED_CAPABILITIES are advertised by at least one active, dispatchable
 * agency in provider_registry.capabilities->'jobs'.
 *
 * Usage:
 *   bun run scripts/orchestrator-capability-coverage-check.ts [--warn-only]
 *
 * Flags:
 *   --warn-only    Log warnings but exit 0 (used by orchestrator boot path)
 *   (default)      Exit 1 on any missing capability (used by CI)
 *
 * Output:
 *   Red error for each missing cap, listing affected roles.
 *   Green summary if all checks pass.
 *   Log line text is referenced in CONVENTIONS.md runbook for remediation.
 */

import { query } from "../src/infra/postgres/pool.ts";
import { ROLE_TO_REQUIRED_CAPABILITIES } from "../src/core/orchestration/offer-dispatch.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

interface CoverageResult {
	missing: Map<string, string[]>;
	hasErrors: boolean;
}

/**
 * Check coverage of all capabilities in the role map.
 */
async function checkCoveragE(): Promise<CoverageResult> {
	// Collect all unique capabilities referenced in the map.
	const allCaps = new Set<string>();
	const capToRoles = new Map<string, Set<string>>();

	for (const [role, caps] of Object.entries(ROLE_TO_REQUIRED_CAPABILITIES)) {
		for (const cap of caps) {
			allCaps.add(cap);
			if (!capToRoles.has(cap)) {
				capToRoles.set(cap, new Set());
			}
			capToRoles.get(cap)!.add(role);
		}
	}

	const missing = new Map<string, string[]>();

	// For each capability, run the query to check for matching agencies.
	for (const cap of allCaps) {
		try {
			const { rows } = await query<{ count: number }>(
				`SELECT count(*)::int AS count
				   FROM roadmap_workforce.provider_registry pr
				   JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
				  WHERE pr.status NOT IN ('offline', 'retired')
				    AND ar.status = 'active'
				    AND ar.agent_type <> 'coordinator'
				    AND ar.agent_identity NOT LIKE 'test/%'
				    AND (pr.capabilities->'jobs') ? $1`,
				[cap],
			);

			const count = rows[0]?.count ?? 0;
			if (count === 0) {
				const roles = Array.from(capToRoles.get(cap) ?? []).sort();
				missing.set(cap, roles);
			}
		} catch (err) {
			console.error(
				`${RED}ERROR${RESET} checking capability "${cap}": ${err instanceof Error ? err.message : String(err)}`,
			);
			return { missing, hasErrors: true };
		}
	}

	return { missing, hasErrors: missing.size > 0 };
}

/**
 * Format and log coverage results.
 */
function logResults(
	result: CoverageResult,
	warnOnly: boolean,
): number {
	if (!result.hasErrors) {
		console.log(
			`${GREEN}✓ All ${Object.keys(ROLE_TO_REQUIRED_CAPABILITIES).length} mapped roles have matching dispatchable agencies${RESET}`,
		);
		return 0;
	}

	// Log each missing capability and its affected roles.
	for (const [cap, roles] of result.missing) {
		const level = warnOnly ? YELLOW : RED;
		console.log(
			`${level}${warnOnly ? "WARN" : "ERROR"}${RESET} capability "${cap}" required by roles [${roles.map((r) => `"${r}"`).join(", ")}] has no matching dispatchable agency via provider_registry.capabilities->'jobs'. Investigate role-to-capability mapping (P1290) or seed missing capabilities on active agencies (see CONVENTIONS.md § Capability vocabulary mismatch remediation).`,
		);
	}

	if (warnOnly) {
		console.log(
			`${YELLOW}WARN${RESET} Capability coverage check found ${result.missing.size} missing cap(s). Orchestrator continuing in warn-only mode.`,
		);
		return 0;
	}

	console.log(
		`${RED}ERROR${RESET} Capability coverage check failed: ${result.missing.size} missing cap(s). CI build fails. Fix via role-map edit or agency seeding before retry.`,
	);
	return 1;
}

/**
 * Main entry point.
 */
async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const warnOnly = args.includes("--warn-only");

	try {
		const result = await checkCoveragE();
		return logResults(result, warnOnly);
	} catch (err) {
		console.error(
			`${RED}FATAL${RESET} ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	} finally {
		process.exit(0);
	}
}

main().catch((err) => {
	console.error(`${RED}FATAL${RESET} Unhandled error: ${err}`);
	process.exit(1);
});

/**
 * Export the main function for orchestrator boot integration.
 */
export { main as checkCapabilityCoverage };
