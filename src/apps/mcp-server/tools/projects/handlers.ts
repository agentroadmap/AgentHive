/**
 * Project Registry MCP Tools (P482 Phase 1)
 *
 * Manages multi-project bootstrap via `set_project` and `list_projects`.
 * Session binding is in-process (best-effort, keyed by SSE session id).
 * AC #201's durable table decision is deferred to Phase 3.
 *
 * LIMITATION: In-process Map is process-wide for a given session.
 * Without a session_id from server.ts, binding is best-effort and does not
 * survive process restart. Use stable project slug/id for cross-call references.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

// In-process session binding: keyed by SSE session id (string) or "process-wide" fallback.
const sessionProjectBindings = new Map<string, {
	project_id: number;
	slug: string;
	name: string;
	worktree_root: string;
	git_remote_url: string | null;
	git_default_branch: string;
}>();

const SESSION_KEY = "process-wide"; // Fallback when no session_id available.

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

function jsonResult(data: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

export async function setProject(args: {
	project?: string;
	sessionId?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.project) {
			return errorResult("set_project requires 'project' (slug or numeric id)", new Error("Missing project"));
		}

		// Query for the project by slug or numeric id.
		const projectValue = args.project.trim();
		let sql: string;
		const params: (string | number)[] = [];

		if (/^\d+$/.test(projectValue)) {
			// Numeric id
			sql = `SELECT project_id, slug, name, worktree_root, git_remote_url, git_default_branch FROM roadmap.project WHERE project_id = $1`;
			params.push(Number(projectValue));
		} else {
			// Slug
			sql = `SELECT project_id, slug, name, worktree_root, git_remote_url, git_default_branch FROM roadmap.project WHERE slug = $1`;
			params.push(projectValue);
		}

		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			git_remote_url: string | null;
			git_default_branch: string;
		}>(sql, params);

		if (!rows.length) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								ok: false,
								error: "project_not_found",
								project: args.project,
								message: `No project found for '${args.project}'`,
							},
							null,
							2,
						),
					},
				],
			};
		}

		const project = rows[0];
		const sessionKey = args.sessionId || SESSION_KEY;
		sessionProjectBindings.set(sessionKey, {
			project_id: project.project_id,
			slug: project.slug,
			name: project.name,
			worktree_root: project.worktree_root,
			git_remote_url: project.git_remote_url,
			git_default_branch: project.git_default_branch,
		});

		return jsonResult({
			ok: true,
			project: {
				project_id: project.project_id,
				slug: project.slug,
				name: project.name,
				worktree_root: project.worktree_root,
				git_remote_url: project.git_remote_url,
				git_default_branch: project.git_default_branch,
			},
			scope: args.sessionId ? "session" : "process",
			note: args.sessionId
				? "Binding stored per SSE session"
				: "Binding is process-wide (no session_id provided by server)",
		});
	} catch (err) {
		return errorResult("Failed to set project", err);
	}
}

export async function listProjects(args: {
	include_archived?: boolean;
	limit?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
		const includeArchived = args.include_archived === true;

		let sql =
			`SELECT project_id, slug, name, worktree_root, status, created_at, archived_at
			 FROM roadmap.project`;
		const params: unknown[] = [];

		if (!includeArchived) {
			sql += ` WHERE status = 'active'`;
		}

		sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
		params.push(limit);

		const [{ rows }, countResult] = await Promise.all([
			query<{
				project_id: number;
				slug: string;
				name: string;
				worktree_root: string;
				status: string;
				created_at: string;
				archived_at: string | null;
			}>(sql, params),
			query<{ total: string }>(
				`SELECT COUNT(*)::text AS total FROM roadmap.project${!includeArchived ? ` WHERE status = 'active'` : ""}`,
				[],
			),
		]);

		const totalMatching = Number(countResult.rows[0]?.total ?? rows.length);
		const truncated = totalMatching > rows.length;

		const items = rows.map((r) => ({
			project_id: r.project_id,
			slug: r.slug,
			name: r.name,
			worktree_root: r.worktree_root,
			status: r.status,
			created_at: r.created_at,
			archived_at: r.archived_at,
		}));

		return jsonResult({
			total: totalMatching,
			returned: items.length,
			truncated,
			limit,
			items,
		});
	} catch (err) {
		return errorResult("Failed to list projects", err);
	}
}

/**
 * Retrieve the currently bound project for a session.
 * Internal use (not exposed as MCP action in Phase 1).
 */
export function getCurrentProject(sessionId?: string): {
	project_id: number;
	slug: string;
	name: string;
	worktree_root: string;
	git_remote_url: string | null;
	git_default_branch: string;
} | null {
	const key = sessionId || SESSION_KEY;
	return sessionProjectBindings.get(key) || null;
}
