/**
 * P1351 AC-3: Backfill parent_agency_id relationships
 *
 * Identifies agencies that can be grouped by (provider, host_id) matching,
 * and establishes parent-child relationships by finding the "root" agency
 * (first registered with a given provider+host_id combination) as the parent,
 * then assigning all others as children.
 *
 * Design:
 *   1. Dry-run mode (default): only logs and counts
 *   2. Live mode (--live flag): persists the changes to the database
 *   3. Orphan detection: agencies with no matching parent remain NULL
 *   4. Idempotent: re-running on an already-backfilled DB is a no-op
 */

import { query } from "../../../infra/postgres/pool.ts";

export interface BackfillResult {
  parentCreated: number;
  childrenAssigned: number;
  orphanedAgencies: string[];
  dryRun: boolean;
}

/**
 * Identify potential parent-child relationships by grouping agencies
 * on (provider, host_id). Returns a plan showing what would be updated.
 */
async function identifyRelationships(): Promise<
  Array<{
    parentAgencyId: string;
    childAgencyIds: string[];
    provider: string;
    hostId: string;
  }>
> {
  // Group agencies by (provider, host_id), sorted by registered_at (earliest = parent)
  const { rows } = await query<{
    parent_agency_id: string;
    child_agency_ids: string[];
    provider: string;
    host_id: string;
  }>(
    `
    WITH grouped AS (
      SELECT
        provider,
        host_id,
        array_agg(agency_id ORDER BY registered_at ASC) as all_agencies
      FROM roadmap.agency
      WHERE parent_agency_id IS NULL  -- Only process unclaimed agencies
      GROUP BY provider, host_id
      HAVING count(*) >= 2  -- Only groups with 2+ agencies (siblings)
    )
    SELECT
      grouped.provider,
      grouped.host_id,
      grouped.all_agencies[1] as parent_agency_id,
      grouped.all_agencies[2:] as child_agency_ids
    FROM grouped
    ORDER BY grouped.provider, grouped.host_id
    `,
  );

  return rows;
}

/**
 * Apply the backfill in live mode.
 */
async function applyBackfill(
  relationships: Array<{
    parentAgencyId: string;
    childAgencyIds: string[];
    provider: string;
    hostId: string;
  }>,
): Promise<{ parentCreated: number; childrenAssigned: number }> {
  let parentCreated = 0;
  let childrenAssigned = 0;

  for (const rel of relationships) {
    // Update each child to point to the parent
    for (const childId of rel.childAgencyIds) {
      const result = await query(
        `
        UPDATE roadmap.agency
        SET parent_agency_id = $1, updated_at = now()
        WHERE agency_id = $2 AND parent_agency_id IS NULL
        RETURNING agency_id
        `,
        [rel.parentAgencyId, childId],
      );
      if ((result.rowCount ?? 0) > 0) {
        childrenAssigned++;
      }
    }

    // Count parent as "created" (conceptually, though the parent row already exists)
    parentCreated++;
  }

  return { parentCreated, childrenAssigned };
}

/**
 * Main backfill entry point.
 *
 * @param dryRun - if true, only report; if false, apply changes
 * @returns summary of changes
 */
export async function backfillParentAgencies(
  dryRun = true,
): Promise<BackfillResult> {
  const relationships = await identifyRelationships();

  // Build orphan list: agencies with no (provider, host_id) siblings
  const { rows: orphans } = await query<{ agency_id: string }>(
    `
    SELECT DISTINCT a.agency_id
    FROM roadmap.agency a
    WHERE a.parent_agency_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM roadmap.agency b
        WHERE b.provider = a.provider
          AND b.host_id = a.host_id
          AND b.agency_id != a.agency_id
          AND b.parent_agency_id IS NULL
      )
    ORDER BY a.agency_id
    `,
  );

  let parentCreated = 0;
  let childrenAssigned = 0;

  if (!dryRun) {
    const result = await applyBackfill(relationships);
    parentCreated = result.parentCreated;
    childrenAssigned = result.childrenAssigned;
  } else {
    // In dry-run, just count what would happen
    parentCreated = relationships.length;
    childrenAssigned = relationships.reduce(
      (sum, rel) => sum + rel.childAgencyIds.length,
      0,
    );
  }

  return {
    parentCreated,
    childrenAssigned,
    orphanedAgencies: orphans.map((r) => r.agency_id),
    dryRun,
  };
}

// CLI entry point for manual execution
if (import.meta.main) {
  const dryRun = !process.argv.includes("--live");
  console.log(
    `[backfill-parent-agencies] Running in ${dryRun ? "DRY-RUN" : "LIVE"} mode`,
  );

  try {
    const result = await backfillParentAgencies(dryRun);
    console.log(
      `[backfill-parent-agencies] Complete: ${result.parentCreated} parents, ${result.childrenAssigned} children assigned`,
    );
    console.log(
      `[backfill-parent-agencies] Orphaned agencies (${result.orphanedAgencies.length}): ${result.orphanedAgencies.join(", ")}`,
    );
    process.exit(0);
  } catch (err) {
    console.error(
      `[backfill-parent-agencies] Error: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
