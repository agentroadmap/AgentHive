/**
 * P1290: Capability coverage health check — shared core logic.
 *
 * Used by:
 *   - scripts/orchestrator-capability-coverage-check.ts (CI, exits 1 on gap)
 *   - Orchestrator.bootMaintenance() (warn-only, no process.exit)
 */

import { query } from "../../infra/postgres/pool.ts";
import { ROLE_TO_REQUIRED_CAPABILITIES } from "./offer-dispatch.ts";

export interface CapabilityCoverageResult {
	capability: string;
	roles: string[];
	agencyCount: number;
}

/**
 * Check that every capability in ROLE_TO_REQUIRED_CAPABILITIES has at least
 * one dispatchable agency. Returns the full coverage matrix.
 *
 * The dispatchable predicate mirrors agency-resolver.ts:
 *   - provider_registry.status NOT IN ('offline', 'retired')
 *   - agent_registry.status = 'active'
 *   - agent_type <> 'coordinator'
 *   - agent_identity NOT LIKE 'test/%'
 */
export async function checkCapabilityCoverage(
	logger: Pick<Console, "log" | "warn" | "error"> = console,
): Promise<CapabilityCoverageResult[]> {
	// Build deduplicated capability → roles index
	const capToRoles = new Map<string, string[]>();
	for (const [role, caps] of Object.entries(ROLE_TO_REQUIRED_CAPABILITIES)) {
		for (const cap of caps) {
			const existing = capToRoles.get(cap) ?? [];
			existing.push(role);
			capToRoles.set(cap, existing);
		}
	}

	const results: CapabilityCoverageResult[] = [];
	const gaps: string[] = [];

	for (const [cap, roles] of capToRoles) {
		const { rows } = await query<{ agency_count: string }>(
			`SELECT count(*) AS agency_count
			 FROM roadmap_workforce.provider_registry pr
			 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
			 WHERE pr.status NOT IN ('offline', 'retired')
			   AND ar.status = 'active'
			   AND ar.agent_type <> 'coordinator'
			   AND ar.agent_identity NOT LIKE 'test/%'
			   AND (pr.capabilities->'jobs') ? $1`,
			[cap],
		);
		const agencyCount = Number(rows[0]?.agency_count ?? 0);
		results.push({ capability: cap, roles, agencyCount });

		if (agencyCount === 0) {
			gaps.push(cap);
			logger.warn(
				`[capability-coverage] capability "${cap}" required by roles [${roles.join(", ")}] has no matching dispatchable agency; investigate provider_registry seeding`,
			);
		} else {
			logger.log(
				`[capability-coverage] capability "${cap}" → ${agencyCount} agency/agencies (roles: ${roles.join(", ")})`,
			);
		}
	}

	if (gaps.length > 0) {
		logger.error(
			`[capability-coverage] FAIL: ${gaps.length} capability/ies with zero dispatchable agencies: ${gaps.join(", ")}`,
		);
	} else {
		logger.log(
			`[capability-coverage] OK: all ${results.length} capabilities covered`,
		);
	}

	return results;
}

/** Returns true if any capability has zero matching agencies. */
export function hasGaps(results: CapabilityCoverageResult[]): boolean {
	return results.some((r) => r.agencyCount === 0);
}
