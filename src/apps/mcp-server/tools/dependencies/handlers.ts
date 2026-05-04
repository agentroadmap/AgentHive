/**
 * MCP Tool Handlers for Proposal Dependencies (Postgres-backed)
 * P470: Rewrite to use roadmap_proposal.proposal_dependencies table
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

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

interface ProposalDependency {
	id: bigint;
	from_proposal_id: string;
	to_proposal_id: string;
	dependency_type: string;
	resolved: boolean;
	resolved_at: string | null;
	resolved_by: string | null;
	created_at: string;
	updated_at: string;
}

export class DependencyHandlers {
	/**
	 * Add a new dependency between proposals.
	 * INSERT or return existing if (from, to, type) triplet exists.
	 * Reject self-loops. Validate both proposal IDs exist.
	 */
	async addDependency(input: {
		fromProposalId: string;
		toProposalId: string;
		dependencyType?: string;
	}): Promise<CallToolResult> {
		try {
			const fromId = input.fromProposalId;
			const toId = input.toProposalId;
			const depType = input.dependencyType ?? "blocks";

			if (fromId === toId) {
				return errorResult(
					"Self-loop rejected",
					"from_proposal_id cannot equal to_proposal_id",
				);
			}

			const existFrom = await query(
				"SELECT 1 FROM roadmap_proposal.proposal WHERE id = $1",
				[fromId],
			);
			if (existFrom.rows.length === 0) {
				return errorResult(
					"Validation failed",
					`from_proposal_id ${fromId} does not exist`,
				);
			}

			const existTo = await query(
				"SELECT 1 FROM roadmap_proposal.proposal WHERE id = $1",
				[toId],
			);
			if (existTo.rows.length === 0) {
				return errorResult(
					"Validation failed",
					`to_proposal_id ${toId} does not exist`,
				);
			}

			const existing = await query<ProposalDependency>(
				`SELECT * FROM roadmap_proposal.proposal_dependencies
				 WHERE from_proposal_id = $1 AND to_proposal_id = $2 AND dependency_type = $3`,
				[fromId, toId, depType],
			);

			if (existing.rows.length > 0) {
				const dep = existing.rows[0];
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									dependency: {
										id: String(dep.id),
										fromProposalId: dep.from_proposal_id,
										toProposalId: dep.to_proposal_id,
										dependencyType: dep.dependency_type,
										resolved: dep.resolved,
										createdAt: dep.created_at,
									},
								},
								null,
								2,
							),
						},
					],
				};
			}

			const result = await query<ProposalDependency>(
				`INSERT INTO roadmap_proposal.proposal_dependencies
				 (from_proposal_id, to_proposal_id, dependency_type)
				 VALUES ($1, $2, $3)
				 RETURNING *`,
				[fromId, toId, depType],
			);

			const dep = result.rows[0];
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								dependency: {
									id: String(dep.id),
									fromProposalId: dep.from_proposal_id,
									toProposalId: dep.to_proposal_id,
									dependencyType: dep.dependency_type,
									resolved: dep.resolved,
									createdAt: dep.created_at,
								},
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to add dependency", err);
		}
	}

	/**
	 * Get dependencies with optional filters.
	 */
	async getDependencies(
		input: {
			fromProposalId?: string;
			toProposalId?: string;
			dependencyType?: string;
			resolved?: boolean;
		} = {},
	): Promise<CallToolResult> {
		try {
			let sql =
				"SELECT * FROM roadmap_proposal.proposal_dependencies WHERE 1=1";
			const params: (string | boolean)[] = [];
			let paramIdx = 1;

			if (input.fromProposalId) {
				sql += ` AND from_proposal_id = $${paramIdx++}`;
				params.push(input.fromProposalId);
			}
			if (input.toProposalId) {
				sql += ` AND to_proposal_id = $${paramIdx++}`;
				params.push(input.toProposalId);
			}
			if (input.dependencyType) {
				sql += ` AND dependency_type = $${paramIdx++}`;
				params.push(input.dependencyType);
			}
			if (input.resolved !== undefined) {
				sql += ` AND resolved = $${paramIdx++}`;
				params.push(input.resolved);
			}

			sql += " ORDER BY created_at DESC";

			const result = await query<ProposalDependency>(sql, params);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								count: result.rows.length,
								dependencies: result.rows.map((d) => ({
									id: String(d.id),
									fromProposalId: d.from_proposal_id,
									toProposalId: d.to_proposal_id,
									dependencyType: d.dependency_type,
									resolved: d.resolved,
									createdAt: d.created_at,
									updatedAt: d.updated_at,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get dependencies", err);
		}
	}

	/**
	 * Resolve a dependency (mark resolved, set timestamp and resolver).
	 */
	async resolveDependency(input: {
		id: string | number;
		resolved?: boolean;
		resolved_by?: string;
	}): Promise<CallToolResult> {
		try {
			const depId = String(input.id);
			const resolveTo = input.resolved !== false; // defaults to true if not specified
			const resolvedValue = resolveTo ? true : false;

			const result = await query<ProposalDependency>(
				`UPDATE roadmap_proposal.proposal_dependencies
				 SET resolved = $2, resolved_at = ${resolveTo ? "NOW()" : "NULL"}, resolved_by = $3, updated_at = NOW()
				 WHERE id = $1
				 RETURNING *`,
				[depId, resolvedValue, input.resolved_by ?? null],
			);

			if (result.rows.length === 0) {
				return errorResult("Not found", `dependency id ${depId} not found`);
			}

			const dep = result.rows[0];
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								dependency: {
									id: String(dep.id),
									fromProposalId: dep.from_proposal_id,
									toProposalId: dep.to_proposal_id,
									dependencyType: dep.dependency_type,
									resolved: dep.resolved,
									resolvedAt: dep.resolved_at,
									resolvedBy: dep.resolved_by,
									updatedAt: dep.updated_at,
								},
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to resolve dependency", err);
		}
	}

	/**
	 * Check if adding a dependency would create a cycle.
	 * Uses recursive CTE to detect reachability.
	 */
	async checkCycle(input: {
		fromProposalId: string;
		toProposalId: string;
	}): Promise<CallToolResult> {
		try {
			const result = await query<{ found: boolean }>(
				`WITH RECURSIVE reach AS (
					SELECT to_proposal_id FROM roadmap_proposal.proposal_dependencies
					WHERE from_proposal_id = $1 AND NOT resolved
					UNION
					SELECT d.to_proposal_id FROM roadmap_proposal.proposal_dependencies d
					JOIN reach r ON d.from_proposal_id = r.to_proposal_id
					WHERE NOT d.resolved
				)
				SELECT EXISTS(SELECT 1 FROM reach WHERE to_proposal_id = $2) as found`,
				[input.toProposalId, input.fromProposalId],
			);

			const wouldCreateCycle = result.rows[0]?.found ?? false;

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								wouldCreateCycle,
								message: wouldCreateCycle
									? "Adding this edge would create a cycle"
									: "Safe to add this dependency",
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to check cycle", err);
		}
	}

	/**
	 * Remove a dependency by ID.
	 */
	async removeDependency(input: {
		id: string | number;
	}): Promise<CallToolResult> {
		try {
			const depId = String(input.id);
			const result = await query(
				"DELETE FROM roadmap_proposal.proposal_dependencies WHERE id = $1",
				[depId],
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								removed: result.rowCount,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to remove dependency", err);
		}
	}

	/**
	 * Check if a proposal can be promoted (no unresolved blocks).
	 */
	async canPromote(input: { proposalId: string }): Promise<CallToolResult> {
		try {
			const blockers = await query<{
				from_proposal_id: string;
				dependency_type: string;
			}>(
				`SELECT from_proposal_id, dependency_type FROM roadmap_proposal.proposal_dependencies
				 WHERE to_proposal_id = $1 AND dependency_type = 'blocks' AND NOT resolved`,
				[input.proposalId],
			);

			const canPromote = blockers.rows.length === 0;

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								proposalId: input.proposalId,
								canPromote,
								blockedBy: blockers.rows.map((b) => ({
									fromId: b.from_proposal_id,
									type: b.dependency_type,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to check promotion", err);
		}
	}

	async addCrossProjectDep(input: {
		fromProjectId: string;
		toProjectId: string;
		kindId: string;
		referenceId: string;
		referenceType: string;
		notes?: string;
	}): Promise<CallToolResult> {
		try {
			const { getControlPool } = await import(
				"../../../../postgres/pool-registry.ts"
			);
			const { addCrossProjectDependency } = await import(
				"../../../../core/cross-project/cross-dep-service.ts"
			);
			const result = await addCrossProjectDependency(getControlPool(), {
				fromProjectId: BigInt(input.fromProjectId),
				toProjectId: BigInt(input.toProjectId),
				kindId: BigInt(input.kindId),
				referenceId: input.referenceId,
				referenceType: input.referenceType,
				notes: input.notes,
			});
			if (!result.ok) {
				return errorResult(
					"Failed to add cross-project dependency",
					result.error,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ ok: true, edgeId: result.edgeId.toString() },
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to add cross-project dependency", err);
		}
	}
}
