import { query as defaultQuery } from "../../../infra/postgres/pool.ts";

type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Returns true if the project has remaining dispatch capacity.
 * When no config row exists the project is treated as uncapped.
 *
 * Active dispatches are approximated by agent_runs rows in 'running' status,
 * which is the source of truth available without a project_id FK on
 * squad_dispatch.
 *
 * @param queryFn - Injectable query function (defaults to the shared pool). Pass
 *   a fake during tests to avoid hitting the database.
 */
export async function isWithinCapacity(
	projectId: number,
	queryFn: QueryFn = defaultQuery,
): Promise<boolean> {
	const { rows } = await queryFn(
		`SELECT c.max_concurrent_dispatches,
		        COUNT(r.id) AS active_count
		 FROM roadmap.project_capacity_config c
		 LEFT JOIN agent_runs r
		   ON r.status = 'running'
		 WHERE c.project_id = $1
		 GROUP BY c.max_concurrent_dispatches`,
		[projectId],
	);
	if (!rows.length) return true; // no config row = uncapped
	return Number(rows[0].active_count) < Number(rows[0].max_concurrent_dispatches);
}
