/**
 * Audit Agent Identifier Collisions (P462)
 *
 * Read-only audit script that exports existing agent_registry rows that:
 * - Fail the new normalization rules (would be rejected on insert today)
 * - Collide with another row under NFC normalization (homograph collisions)
 *
 * Output: CSV to stdout
 * Exits with code 0 on success, 1 on DB error
 */

import { query } from "../src/postgres/pool.ts";
import { normalizeAgentId, AgentIdInvalidError } from "../src/shared/identity/sanitize-agent-id.ts";

interface AgentRow {
	agent_identity: string;
	agent_type?: string;
	role?: string;
	status?: string;
	created_at?: string;
}

async function main() {
	try {
		// Fetch all agent identities from registry
		const { rows: agents } = await query<AgentRow>(
			`SELECT agent_identity, agent_type, role, status, created_at
       FROM roadmap.agent_registry
       ORDER BY agent_identity`,
		);

		if (!agents.length) {
			// CSV header only
			console.log(
				"agent_identity,reason,conflicting_with,agent_type,role,status,created_at",
			);
			process.exit(0);
		}

		// Build map of normalized forms to original identities
		const normalizedMap = new Map<string, AgentRow[]>();
		const invalidIdentities: Array<{
			row: AgentRow;
			reason: string;
		}> = [];

		for (const row of agents) {
			try {
				const normalized = normalizeAgentId(row.agent_identity);
				if (!normalizedMap.has(normalized)) {
					normalizedMap.set(normalized, []);
				}
				normalizedMap.get(normalized)!.push(row);
			} catch (err) {
				if (err instanceof AgentIdInvalidError) {
					invalidIdentities.push({
						row,
						reason: err.reason,
					});
				}
			}
		}

		// CSV header
		console.log(
			"agent_identity,reason,conflicting_with,agent_type,role,status,created_at",
		);

		// Export invalid identities
		for (const { row, reason } of invalidIdentities) {
			const agentType = row.agent_type ? `"${row.agent_type.replace(/"/g, '""')}"` : "";
			const role = row.role ? `"${row.role.replace(/"/g, '""')}"` : "";
			const status = row.status || "";
			const createdAt = row.created_at || "";

			console.log(
				`"${row.agent_identity.replace(/"/g, '""')}","${reason}","",${agentType},${role},${status},${createdAt}`,
			);
		}

		// Export collision identities (keep first, flag others)
		const collisionIdentities: Array<{
			row: AgentRow;
			conflictingWith: string;
		}> = [];

		for (const [_normalized, rows] of normalizedMap) {
			if (rows.length > 1) {
				// Multiple identities normalize to same form
				const [first, ...others] = rows;
				for (const other of others) {
					collisionIdentities.push({
						row: other,
						conflictingWith: first.agent_identity,
					});
				}
			}
		}

		for (const { row, conflictingWith } of collisionIdentities) {
			const agentType = row.agent_type ? `"${row.agent_type.replace(/"/g, '""')}"` : "";
			const role = row.role ? `"${row.role.replace(/"/g, '""')}"` : "";
			const status = row.status || "";
			const createdAt = row.created_at || "";
			const reason = "homograph_collision";

			console.log(
				`"${row.agent_identity.replace(/"/g, '""')}","${reason}","${conflictingWith.replace(/"/g, '""')}",${agentType},${role},${status},${createdAt}`,
			);
		}

		// Summary to stderr
		const totalIssues = invalidIdentities.length + collisionIdentities.length;
		console.error(
			`\n📋 Audit Summary: ${agents.length} total identities, ${invalidIdentities.length} invalid, ${collisionIdentities.length} collisions`,
		);

		process.exit(0);
	} catch (err) {
		console.error(
			`Database error: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

main();
