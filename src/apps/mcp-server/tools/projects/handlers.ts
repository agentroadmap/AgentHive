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

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

// In-process session binding: keyed by SSE session id (string) or "process-wide" fallback.
const sessionProjectBindings = new Map<
	string,
	{
		project_id: number;
		slug: string;
		name: string;
		worktree_root: string;
		git_repo_url: string | null;
		git_default_branch: string;
	}
>();

const SESSION_KEY = "process-wide"; // Fallback when no session_id available.
let projectGitColumnsCache: {
	hasGitRepoUrl: boolean;
	hasGitRemoteUrl: boolean;
	hasGitDefaultBranch: boolean;
} | null = null;

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

async function getProjectGitColumns(): Promise<{
	hasGitRepoUrl: boolean;
	hasGitRemoteUrl: boolean;
	hasGitDefaultBranch: boolean;
}> {
	if (projectGitColumnsCache) return projectGitColumnsCache;

	const { rows } = await query<{ column_name: string }>(
		`SELECT column_name
		   FROM information_schema.columns
		  WHERE table_schema = 'roadmap'
		    AND table_name = 'project'
		    AND column_name IN ('git_repo_url', 'git_remote_url', 'git_default_branch')`,
		[],
	);
	const columns = new Set(rows.map((row) => row.column_name));
	projectGitColumnsCache = {
		hasGitRepoUrl: columns.has("git_repo_url"),
		hasGitRemoteUrl: columns.has("git_remote_url"),
		hasGitDefaultBranch: columns.has("git_default_branch"),
	};
	return projectGitColumnsCache;
}

async function projectGitSelect(): Promise<string> {
	const columns = await getProjectGitColumns();
	const repoExpr = columns.hasGitRepoUrl
		? "git_repo_url"
		: columns.hasGitRemoteUrl
			? "git_remote_url AS git_repo_url"
			: "NULL::text AS git_repo_url";
	const branchExpr = columns.hasGitDefaultBranch
		? "git_default_branch"
		: "'main'::text AS git_default_branch";
	return `${repoExpr}, ${branchExpr}`;
}

export async function setProject(args: {
	project?: string;
	sessionId?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.project) {
			return errorResult(
				"set_project requires 'project' (slug or numeric id)",
				new Error("Missing project"),
			);
		}

		// Query for the project by slug or numeric id.
		const projectValue = args.project.trim();
		const gitSelect = await projectGitSelect();
		let sql: string;
		const params: (string | number)[] = [];

		if (/^\d+$/.test(projectValue)) {
			// Numeric id
			sql = `SELECT project_id, slug, name, worktree_root, ${gitSelect} FROM roadmap.project WHERE project_id = $1`;
			params.push(Number(projectValue));
		} else {
			// Slug
			sql = `SELECT project_id, slug, name, worktree_root, ${gitSelect} FROM roadmap.project WHERE slug = $1`;
			params.push(projectValue);
		}

		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			git_repo_url: string | null;
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
			git_repo_url: project.git_repo_url,
			git_default_branch: project.git_default_branch,
		});

		return jsonResult({
			ok: true,
			project: {
				project_id: project.project_id,
				slug: project.slug,
				name: project.name,
				worktree_root: project.worktree_root,
				git_repo_url: project.git_repo_url,
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
		const gitSelect = await projectGitSelect();

		let sql = `SELECT project_id, slug, name, worktree_root, ${gitSelect}, status, created_at, archived_at
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
				git_repo_url: string | null;
				git_default_branch: string;
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
			git_repo_url: r.git_repo_url,
			git_default_branch: r.git_default_branch,
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

export async function updateProjectRegistry(args: {
	project?: string;
	git_repo_url?: string | null;
	git_default_branch?: string;
	worktree_root?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.project) {
			return errorResult(
				"project_update requires 'project' (slug or numeric id)",
				new Error("Missing project"),
			);
		}

		const assignments: string[] = [];
		const params: unknown[] = [];
		const gitColumns = await getProjectGitColumns();

		if (Object.hasOwn(args, "git_repo_url")) {
			if (!gitColumns.hasGitRepoUrl) {
				return jsonResult({
					ok: false,
					error: "ERROR_GIT_REPO_URL_COLUMN_MISSING",
					message:
						"Run P516 migration 146-p516-project-git-fields.sql before updating git_repo_url.",
				});
			}
			assignments.push(`git_repo_url = $${params.length + 1}`);
			params.push(args.git_repo_url ?? null);
		}

		if (args.git_default_branch !== undefined) {
			if (!gitColumns.hasGitDefaultBranch) {
				return jsonResult({
					ok: false,
					error: "ERROR_GIT_DEFAULT_BRANCH_COLUMN_MISSING",
					message:
						"Run P516 migration 146-p516-project-git-fields.sql before updating git_default_branch.",
				});
			}
			const branch = args.git_default_branch.trim();
			if (!branch) {
				return errorResult(
					"Invalid git_default_branch",
					new Error("git_default_branch must be non-empty"),
				);
			}
			assignments.push(`git_default_branch = $${params.length + 1}`);
			params.push(branch);
		}

		if (args.worktree_root !== undefined) {
			const worktreeRoot = args.worktree_root.trim();
			if (!worktreeRoot) {
				return errorResult(
					"Invalid worktree_root",
					new Error("worktree_root must be non-empty"),
				);
			}
			assignments.push(`worktree_root = $${params.length + 1}`);
			params.push(worktreeRoot);
		}

		if (!assignments.length) {
			return errorResult(
				"project_update requires at least one field",
				new Error("No update fields provided"),
			);
		}

		const projectValue = args.project.trim();
		const numericProject = /^\d+$/.test(projectValue);
		params.push(numericProject ? Number(projectValue) : projectValue);
		const gitSelect = await projectGitSelect();

		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			git_repo_url: string | null;
			git_default_branch: string;
		}>(
			`UPDATE roadmap.project
			    SET ${assignments.join(", ")}
			  WHERE ${numericProject ? "project_id" : "slug"} = $${params.length}
			  RETURNING project_id, slug, name, worktree_root, ${gitSelect}`,
			params,
		);

		if (!rows.length) {
			return jsonResult({
				ok: false,
				error: "project_not_found",
				project: args.project,
			});
		}

		const project = rows[0];
		return jsonResult({
			ok: true,
			project,
		});
	} catch (err) {
		return errorResult("Failed to update project registry", err);
	}
}

function normalizeRemote(remote: string): string {
	return remote.trim().replace(/\.git$/, "");
}

function readOriginRemote(worktreeRoot: string): string | null {
	try {
		return (
			execFileSync(
				"git",
				["-C", worktreeRoot, "config", "--get", "remote.origin.url"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim() || null
		);
	} catch {
		return null;
	}
}

export async function projectHealthCheck(args: {
	project_id?: number;
	project?: string;
}): Promise<CallToolResult> {
	try {
		const projectKey = args.project_id ?? args.project;
		if (
			projectKey === undefined ||
			projectKey === null ||
			String(projectKey).trim() === ""
		) {
			return jsonResult({
				ok: false,
				error: "PROJECT_REQUIRED",
				message: "project_id or project is required",
			});
		}
		const numericProject =
			typeof projectKey === "number" || /^\d+$/.test(String(projectKey));
		const gitSelect = await projectGitSelect();

		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			git_repo_url: string | null;
			git_default_branch: string;
		}>(
			`SELECT project_id, slug, name, worktree_root, ${gitSelect}
				   FROM roadmap.project
				  WHERE ${numericProject ? "project_id" : "slug"} = $1
				    AND status = 'active'`,
			[numericProject ? Number(projectKey) : String(projectKey)],
		);

		if (!rows.length) {
			return jsonResult({
				ok: false,
				error: "ERROR_PROJECT_NOT_FOUND",
				project: projectKey,
				message: `No active project found for ${numericProject ? "project_id" : "slug"}=${projectKey}`,
			});
		}

		const project = rows[0];
		const worktreeExists =
			existsSync(project.worktree_root) &&
			statSync(project.worktree_root).isDirectory();
		const checks: Array<{
			name: string;
			ok: boolean;
			code?: string;
			detail?: string;
		}> = [{ name: "registry_row", ok: true }];

		if (!project.git_repo_url && project.slug !== "agenthive") {
			checks.push({
				name: "git_repo_url",
				ok: false,
				code: "ERROR_GIT_REPO_URL_MISSING",
				detail: "tenant projects must have roadmap.project.git_repo_url set",
			});
		} else {
			checks.push({ name: "git_repo_url", ok: true });
		}

		checks.push({
			name: "worktree_root",
			ok: worktreeExists,
			...(worktreeExists
				? {}
				: {
						code: "ERROR_WORKTREE_NOT_FOUND",
						detail: `${project.worktree_root} does not exist or is not a directory`,
					}),
		});

		if (project.git_repo_url && worktreeExists) {
			const actualRemote = readOriginRemote(project.worktree_root);
			if (!actualRemote) {
				checks.push({
					name: "git_remote",
					ok: false,
					code: "ERROR_GIT_REMOTE_NOT_FOUND",
					detail: `No origin remote found under ${project.worktree_root}`,
				});
			} else if (
				normalizeRemote(actualRemote) !== normalizeRemote(project.git_repo_url)
			) {
				checks.push({
					name: "git_remote",
					ok: false,
					code: "ERROR_GIT_REMOTE_MISMATCH",
					detail: `origin=${actualRemote} registry=${project.git_repo_url}`,
				});
			} else {
				checks.push({ name: "git_remote", ok: true });
			}
		}
		const ok = checks.every((check) => check.ok);

		return jsonResult({
			ok,
			error: ok ? null : checks.find((check) => !check.ok)?.code,
			project: {
				project_id: project.project_id,
				slug: project.slug,
				name: project.name,
				git_repo_url: project.git_repo_url,
				git_default_branch: project.git_default_branch,
				worktree_root: project.worktree_root,
			},
			checks,
			message: ok
				? "Project registry and worktree are in sync."
				: "Project registry and worktree are out of sync. Repair the tenant checkout or registry values before dispatch.",
		});
	} catch (err) {
		return errorResult("Failed to run project health check", err);
	}
}

/**
 * Archive a project (AC-3, AC-101): set status=archived and log timestamp.
 * Dispatch handler will refuse claims for archived projects.
 */
export async function projectArchive(args: {
	project?: string;
	reason?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.project) {
			return errorResult(
				"project_archive requires 'project' (slug or numeric id)",
				new Error("Missing project"),
			);
		}

		const projectValue = args.project.trim();
		const numericProject = /^\d+$/.test(projectValue);
		const reason = args.reason?.trim() || "Archived by operator";

		const { rows: existing } = await query<{ status: string; slug: string }>(
			`SELECT status, slug FROM roadmap.project
			  WHERE ${numericProject ? "project_id" : "slug"} = $1`,
			[numericProject ? Number(projectValue) : projectValue],
		);

		if (!existing.length) {
			return jsonResult({
				ok: false,
				error: "project_not_found",
				project: args.project,
			});
		}

		if (existing[0].status === "archived") {
			return jsonResult({
				ok: true,
				already_archived: true,
				slug: existing[0].slug,
				message: "Project is already archived",
			});
		}

		const gitSelect = await projectGitSelect();
		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			git_repo_url: string | null;
			git_default_branch: string;
			status: string;
			archived_at: string | null;
		}>(
			`UPDATE roadmap.project
				SET status = 'archived', archived_at = NOW()
			  WHERE ${numericProject ? "project_id" : "slug"} = $1
			  RETURNING project_id, slug, name, worktree_root, ${gitSelect}, status, archived_at`,
			[numericProject ? Number(projectValue) : projectValue],
		);

		if (!rows.length) {
			return jsonResult({
				ok: false,
				error: "update_failed",
				project: args.project,
			});
		}

		const project = rows[0];
		return jsonResult({
			ok: true,
			project: {
				project_id: project.project_id,
				slug: project.slug,
				name: project.name,
				status: project.status,
				archived_at: project.archived_at,
			},
			message: `Project '${project.slug}' archived. Dispatch will refuse claims for archived projects.`,
		});
	} catch (err) {
		return errorResult("Failed to archive project", err);
	}
}

/**
 * Reactivate a project (AC-3): set status=active and clear archived_at.
 */
export async function projectReactivate(args: {
	project?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.project) {
			return errorResult(
				"project_reactivate requires 'project' (slug or numeric id)",
				new Error("Missing project"),
			);
		}

		const projectValue = args.project.trim();
		const numericProject = /^\d+$/.test(projectValue);

		const { rows: existing } = await query<{ status: string; slug: string }>(
			`SELECT status, slug FROM roadmap.project
			  WHERE ${numericProject ? "project_id" : "slug"} = $1`,
			[numericProject ? Number(projectValue) : projectValue],
		);

		if (!existing.length) {
			return jsonResult({
				ok: false,
				error: "project_not_found",
				project: args.project,
			});
		}

		if (existing[0].status !== "archived") {
			return jsonResult({
				ok: true,
				already_active: true,
				slug: existing[0].slug,
				status: existing[0].status,
				message: `Project is already in status '${existing[0].status}'`,
			});
		}

		const gitSelect = await projectGitSelect();
		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			git_repo_url: string | null;
			git_default_branch: string;
			status: string;
		}>(
			`UPDATE roadmap.project
				SET status = 'active', archived_at = NULL
			  WHERE ${numericProject ? "project_id" : "slug"} = $1
			  RETURNING project_id, slug, name, worktree_root, ${gitSelect}, status`,
			[numericProject ? Number(projectValue) : projectValue],
		);

		if (!rows.length) {
			return jsonResult({
				ok: false,
				error: "update_failed",
				project: args.project,
			});
		}

		const project = rows[0];
		return jsonResult({
			ok: true,
			project: {
				project_id: project.project_id,
				slug: project.slug,
				name: project.name,
				status: project.status,
			},
			message: `Project '${project.slug}' reactivated. Dispatch will accept claims for this project again.`,
		});
	} catch (err) {
		return errorResult("Failed to reactivate project", err);
	}
}

/**
 * Delete a project (AC-4): safety-guarded deletion with preflight cascade checks.
 * Refuses unless:
 * 1. Project has zero non-archived proposals
 * 2. Operator passes confirm_slug matching the project slug
 * 3. Optional --force flag for cascade with second confirmation
 */
export async function projectDelete(args: {
	project?: string;
	confirm_slug?: string;
	force?: boolean;
}): Promise<CallToolResult> {
	try {
		if (!args.project) {
			return errorResult(
				"project_delete requires 'project' (slug or numeric id)",
				new Error("Missing project"),
			);
		}

		const projectValue = args.project.trim();
		const numericProject = /^\d+$/.test(projectValue);

		// Fetch the project
		const { rows: projectRows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			status: string;
		}>(
			`SELECT project_id, slug, name, status FROM roadmap.project
			  WHERE ${numericProject ? "project_id" : "slug"} = $1`,
			[numericProject ? Number(projectValue) : projectValue],
		);

		if (!projectRows.length) {
			return jsonResult({
				ok: false,
				error: "project_not_found",
				project: args.project,
			});
		}

		const project = projectRows[0];

		// Check: confirm_slug must match
		if (!args.confirm_slug || args.confirm_slug.trim() !== project.slug) {
			return jsonResult({
				ok: false,
				error: "confirm_slug_mismatch",
				slug: project.slug,
				message: `Must pass confirm_slug='${project.slug}' to proceed with deletion`,
			});
		}

		// Check: zero dependent proposal dependencies/discussions/criteria/reviews/events
		// Note: roadmap_proposal.proposal itself is tenant-scoped and has no project_id;
		// only the dependent relationship tables have project_id
		const { rows: propDeps } = await query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM roadmap_proposal.proposal_dependencies
			  WHERE project_id = $1`,
			[project.project_id],
		);

		const propDepCount = Number(propDeps[0]?.count ?? 0);
		if (propDepCount > 0) {
			return jsonResult({
				ok: false,
				error: "dependent_proposals_exist",
				project_id: project.project_id,
				slug: project.slug,
				dependent_count: propDepCount,
				message: `Cannot delete project with ${propDepCount} dependent proposal relationships. Archive them first.`,
			});
		}

		// Preflight: check cascade scope
		const cascadeChecks = await performCascadeChecks(project.project_id);
		if (!cascadeChecks.safe && !args.force) {
			return jsonResult({
				ok: false,
				error: "cascade_dependencies_exist",
				project_id: project.project_id,
				slug: project.slug,
				cascade_checks: cascadeChecks,
				message: "Project has dependent data. Use force=true and confirm_slug to cascade-delete.",
			});
		}

		if (!args.force && cascadeChecks.dependencyCount > 0) {
			return jsonResult({
				ok: false,
				error: "cascade_dependencies_exist",
				project_id: project.project_id,
				slug: project.slug,
				message: "Pass force=true to cascade-delete dependent rows.",
			});
		}

		// Perform deletion
		try {
			await query("BEGIN");
			try {
				// Delete cascade on all FK dependent tables
				await query("DELETE FROM roadmap.project_route_allowlist WHERE project_id = $1", [
					project.project_id,
				]);
				await query("DELETE FROM roadmap.project_route_policy WHERE project_id = $1", [
					project.project_id,
				]);
				await query("DELETE FROM roadmap.project_capability_scope WHERE project_id = $1", [
					project.project_id,
				]);
				await query("DELETE FROM roadmap.project_budget_cap WHERE project_id = $1", [
					project.project_id,
				]);
				await query("DELETE FROM roadmap.project_repair_queue WHERE project_id = $1", [
					project.project_id,
				]);
				await query("DELETE FROM roadmap.project_capacity_config WHERE project_id = $1", [
					project.project_id,
				]);

				// Delete the project itself
				await query("DELETE FROM roadmap.project WHERE project_id = $1", [
					project.project_id,
				]);

				await query("COMMIT");
			} catch (err) {
				await query("ROLLBACK");
				throw err;
			}
		} catch (err) {
			return errorResult("Failed to delete project", err);
		}

		return jsonResult({
			ok: true,
			deleted: true,
			project_id: project.project_id,
			slug: project.slug,
			message: `Project '${project.slug}' deleted along with dependent routes, capabilities, and budgets.`,
		});
	} catch (err) {
		return errorResult("Failed to delete project", err);
	}
}

/**
 * Preflight check for cascade dependencies before deletion (AC-102).
 * Returns {safe: bool, dependencyCount: number, details: {...}}
 */
async function performCascadeChecks(projectId: number): Promise<{
	safe: boolean;
	dependencyCount: number;
	active_cubics?: number;
	proposal_dependencies?: number;
	workflow_templates?: number;
	workflows?: number;
}> {
	const checks = {
		safe: true,
		dependencyCount: 0,
		active_cubics: 0,
		proposal_dependencies: 0,
		workflow_templates: 0,
		workflows: 0,
	};

	// Non-recycled cubics (status='complete' and 'expired' are terminal; others are active)
	const { rows: cubicRows } = await query<{ count: string }>(
		`SELECT COUNT(*)::text AS count FROM roadmap.cubics
		  WHERE project_id = $1 AND status NOT IN ('complete', 'expired')`,
		[projectId],
	);
	checks.active_cubics = Number(cubicRows[0]?.count ?? 0);

	// Proposal dependencies with this project_id
	const { rows: propDepRows } = await query<{ count: string }>(
		`SELECT COUNT(*)::text AS count FROM roadmap_proposal.proposal_dependencies
		  WHERE project_id = $1`,
		[projectId],
	);
	checks.proposal_dependencies = Number(propDepRows[0]?.count ?? 0);

	// Workflow templates owned by this project
	const { rows: templateRows } = await query<{ count: string }>(
		`SELECT COUNT(*)::text AS count FROM roadmap.workflow_templates
		  WHERE project_id = $1`,
		[projectId],
	);
	checks.workflow_templates = Number(templateRows[0]?.count ?? 0);

	// Workflows owned by this project
	const { rows: wfRows } = await query<{ count: string }>(
		`SELECT COUNT(*)::text AS count FROM roadmap.workflows
		  WHERE project_id = $1`,
		[projectId],
	);
	checks.workflows = Number(wfRows[0]?.count ?? 0);

	checks.dependencyCount =
		checks.active_cubics +
		checks.proposal_dependencies +
		checks.workflow_templates +
		checks.workflows;

	checks.safe = checks.dependencyCount === 0;

	return checks;
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
	git_repo_url: string | null;
	git_default_branch: string;
} | null {
	const key = sessionId || SESSION_KEY;
	return sessionProjectBindings.get(key) || null;
}
