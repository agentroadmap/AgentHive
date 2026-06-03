/**
 * P182: Team Governance Layer — DB-backed MCP handlers.
 *
 * Implements the three subsystems defined in P182:
 *   1. team_charter_create — auto-charter on squad assembly (AC-1, AC-6)
 *   2. team_norms_set      — explicit norm storage (AC-2)
 *   3. team_dispute_log    — three-tier dispute resolution (AC-3, AC-4, AC-5)
 *
 * Uses roadmap_workforce.team_norms + agent_conflicts tables.
 */

import { query } from "../../../../postgres/pool.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

const DEFAULT_NORMS = {
	"team:norm:handoff": {
		rule: "Leave context summary in team memory before releasing lease",
		key: "team:handoff",
	},
	"team:norm:communication": {
		rule: "Use team: prefix in proposal_discussions for intra-team matters",
		key: "team:communication",
	},
	"team:norm:challenge": {
		rule: "Skeptic challenges go through team discussion before gate",
		key: "team:challenge",
	},
	"team:norm:memory": {
		rule: "Design decisions in team memory; implementation notes in individual",
		key: "team:memory",
	},
	"team:norm:worktree": {
		rule: "Coordinate via proposal_discussions before merging branches",
		key: "team:worktree",
	},
};

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

export class PgTeamGovernanceHandlers {
	constructor(private readonly server: McpServer) {}

	/**
	 * AC-1, AC-6: Create a team charter stored as team:charter in team_norms.
	 * Idempotent — safe to call again if charter already exists.
	 */
	async teamCharterCreate(args: {
		teamId: string;
		proposalIds: string[];
		teamName: string;
		createdBy: string;
		norms?: Record<string, unknown>;
	}): Promise<CallToolResult> {
		try {
			const teamIdNum = parseInt(args.teamId, 10);
			if (isNaN(teamIdNum)) {
				return errorResult("Invalid teamId", "must be numeric");
			}

			// Verify team exists
			const teamRow = await query<{ id: number; team_name: string }>(
				`SELECT id, team_name FROM roadmap_workforce.team WHERE id = $1`,
				[teamIdNum],
			);
			if (teamRow.rows.length === 0) {
				return errorResult("Team not found", `id=${args.teamId}`);
			}

			const charterValue = {
				team_name: args.teamName,
				proposal_ids: args.proposalIds,
				created_by: args.createdBy,
				created_at: new Date().toISOString(),
				governance_layer: "team",
				norms_applied: Object.keys(DEFAULT_NORMS),
				custom_norms: args.norms ?? {},
			};

			// Upsert charter norm
			await query(
				`INSERT INTO roadmap_workforce.team_norms
					(team_id, norm_key, norm_value, set_by)
				VALUES ($1, 'team:charter', $2, $3)
				ON CONFLICT (team_id, norm_key)
				DO UPDATE SET norm_value = EXCLUDED.norm_value,
				              set_by = EXCLUDED.set_by,
				              updated_at = now()`,
				[teamIdNum, JSON.stringify(charterValue), args.createdBy],
			);

			// Insert default norms (skip if already set)
			for (const [normKey, normVal] of Object.entries(DEFAULT_NORMS)) {
				await query(
					`INSERT INTO roadmap_workforce.team_norms
						(team_id, norm_key, norm_value, set_by)
					VALUES ($1, $2, $3, $4)
					ON CONFLICT (team_id, norm_key) DO NOTHING`,
					[teamIdNum, normKey, JSON.stringify(normVal), args.createdBy],
				);
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Team charter created\n` +
							`Team: ${args.teamName} (id=${args.teamId})\n` +
							`Proposals: ${args.proposalIds.join(", ")}\n` +
							`Default norms applied: ${Object.keys(DEFAULT_NORMS).length}\n` +
							`Key: team:charter`,
					},
				],
			};
		} catch (err) {
			return errorResult("teamCharterCreate failed", err);
		}
	}

	/**
	 * AC-2: Set or update a named norm for a team.
	 */
	async teamNormsSet(args: {
		teamId: string;
		normKey: string;
		normValue: Record<string, unknown>;
		setBy: string;
	}): Promise<CallToolResult> {
		try {
			const teamIdNum = parseInt(args.teamId, 10);
			if (isNaN(teamIdNum)) {
				return errorResult("Invalid teamId", "must be numeric");
			}

			if (!args.normKey.startsWith("team:")) {
				return errorResult(
					"Invalid normKey",
					`Norm keys must start with 'team:' (got '${args.normKey}')`,
				);
			}

			await query(
				`INSERT INTO roadmap_workforce.team_norms
					(team_id, norm_key, norm_value, set_by)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (team_id, norm_key)
				DO UPDATE SET norm_value = EXCLUDED.norm_value,
				              set_by = EXCLUDED.set_by,
				              updated_at = now()`,
				[
					teamIdNum,
					args.normKey,
					JSON.stringify(args.normValue),
					args.setBy,
				],
			);

			return {
				content: [
					{
						type: "text",
						text:
							`Norm set\n` +
							`Team: ${args.teamId}\n` +
							`Key: ${args.normKey}\n` +
							`Set by: ${args.setBy}`,
					},
				],
			};
		} catch (err) {
			return errorResult("teamNormsSet failed", err);
		}
	}

	/**
	 * AC-3, AC-4, AC-5: Log or update a dispute in agent_conflicts.
	 * Supports three-tier ladder: L1(self) → L2(peer) → L3(team) → L4(society).
	 *
	 * Column mapping (actual DB schema):
	 *   initiatorAgent → agent_a
	 *   respondentAgent → agent_b
	 *   description → topic
	 *   positionA → position_a  (initiator's stated position)
	 *   positionB → position_b  (respondent's stated position)
	 */
	async teamDisputeLog(args: {
		proposalId: string;
		initiatorAgent: string;
		respondentAgent: string;
		description: string;
		escalationLevel: "L1" | "L2" | "L3" | "L4";
		positionA?: string;
		positionB?: string;
		status?: "open" | "team_resolved" | "escalated" | "resolved" | "dismissed";
		teamId?: string;
		resolutionNote?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalIdNum = parseInt(args.proposalId, 10);
			if (isNaN(proposalIdNum)) {
				return errorResult("Invalid proposalId", "must be numeric");
			}

			const teamIdNum =
				args.teamId != null ? parseInt(args.teamId, 10) : null;

			const status = args.status ?? "open";
			const positionA = args.positionA ?? "initiating dispute";
			const positionB = args.positionB ?? "responding agent";

			// Check if an open dispute between these agents on this proposal exists
			const existing = await query<{ id: number }>(
				`SELECT id FROM roadmap_workforce.agent_conflicts
				WHERE proposal_id = $1
				  AND agent_a = $2
				  AND agent_b = $3
				  AND status = 'open'
				LIMIT 1`,
				[proposalIdNum, args.initiatorAgent, args.respondentAgent],
			);

			let disputeId: number;

			if (existing.rows.length > 0 && args.status && args.status !== "open") {
				// Update existing open dispute
				disputeId = existing.rows[0].id;
				await query(
					`UPDATE roadmap_workforce.agent_conflicts
					SET status = $1,
					    escalation_level = $2,
					    team_id = $3,
					    resolution_note = $4,
					    resolved_at = CASE WHEN $1 IN ('resolved','team_resolved','dismissed')
					                       THEN now() ELSE resolved_at END
					WHERE id = $5`,
					[
						status,
						args.escalationLevel,
						teamIdNum,
						args.resolutionNote ?? null,
						disputeId,
					],
				);
			} else {
				// Insert new dispute record
				const result = await query<{ id: number }>(
					`INSERT INTO roadmap_workforce.agent_conflicts
						(proposal_id, agent_a, agent_b, topic, position_a, position_b,
						 status, escalation_level, team_id, resolution_note)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
					RETURNING id`,
					[
						proposalIdNum,
						args.initiatorAgent,
						args.respondentAgent,
						args.description,
						positionA,
						positionB,
						status,
						args.escalationLevel,
						teamIdNum,
						args.resolutionNote ?? null,
					],
				);
				disputeId = result.rows[0].id;
			}

			const lines = [
				`Dispute logged`,
				`ID: ${disputeId}`,
				`Proposal: P${args.proposalId}`,
				`Parties: ${args.initiatorAgent} ↔ ${args.respondentAgent}`,
				`Level: ${args.escalationLevel}`,
				`Status: ${status}`,
			];
			if (args.teamId) lines.push(`Team: ${args.teamId}`);
			if (args.resolutionNote) lines.push(`Resolution: ${args.resolutionNote}`);

			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("teamDisputeLog failed", err);
		}
	}

	/**
	 * AC-7: Archive team governance entries on proposal COMPLETE.
	 * Marks charter + decisions as archived; removes transient norms.
	 */
	async teamGovernanceArchive(args: {
		teamId: string;
		archivedBy: string;
	}): Promise<CallToolResult> {
		try {
			const teamIdNum = parseInt(args.teamId, 10);
			if (isNaN(teamIdNum)) {
				return errorResult("Invalid teamId", "must be numeric");
			}

			// Archive charter and decision norms
			const archiveResult = await query<{ count: string }>(
				`UPDATE roadmap_workforce.team_norms
				SET norm_value = norm_value || jsonb_build_object(
					'archived', true,
					'archived_by', $2::text,
					'archived_at', now()::text
				),
				updated_at = now()
				WHERE team_id = $1
				  AND norm_key IN (
				      SELECT norm_key FROM roadmap_workforce.team_norms
				      WHERE team_id = $1
				        AND (norm_key = 'team:charter'
				             OR norm_key LIKE 'team:decision:%')
				  )
				RETURNING 1`,
				[teamIdNum, args.archivedBy],
			);

			// Delete transient norms (disputes, working norms)
			const deleteResult = await query<{ count: string }>(
				`DELETE FROM roadmap_workforce.team_norms
				WHERE team_id = $1
				  AND norm_key NOT IN ('team:charter')
				  AND norm_key NOT LIKE 'team:decision:%'
				RETURNING 1`,
				[teamIdNum],
			);

			// Mark team as dissolved
			await query(
				`UPDATE roadmap_workforce.team
				SET status = 'dissolved',
				    metadata = metadata || jsonb_build_object(
				        'dissolved_by', $2::text,
				        'dissolved_at', now()::text
				    )
				WHERE id = $1`,
				[teamIdNum, args.archivedBy],
			);

			return {
				content: [
					{
						type: "text",
						text:
							`Team governance archived\n` +
							`Team: ${args.teamId}\n` +
							`Archived: ${archiveResult.rows.length} entries (charter + decisions)\n` +
							`Cleaned up: ${deleteResult.rows.length} transient norms\n` +
							`Status: dissolved`,
					},
				],
			};
		} catch (err) {
			return errorResult("teamGovernanceArchive failed", err);
		}
	}
}
