/**
 * Project Lifecycle MCP Tools (P483 Phase 1)
 *
 * Manages project creation with transactional safety and worktree orphan detection.
 * Implements AC #2 (slug validation), AC #100 (transaction boundary), AC #103 (repair queue).
 *
 * LIMITATION: chown requires sudo; workaround documents the permission requirement.
 * See project_repair_queue table for deferred worktree directory creation.
 */

import { mkdir, stat } from "node:fs/promises";
import { query } from "../../../../postgres/pool.ts";
import { projectCreateSaga } from "../../../../core/saga/saga-create.ts";
import type { CallToolResult } from "../../types.ts";

/**
 * Slug validation pattern (AC #2):
 * - Lowercase alphanumeric + hyphens
 * - Must start with letter, end with alphanumeric
 * - No slashes, underscores, or other special chars
 * - Length 3-64 chars
 */
const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const MIN_SLUG_LEN = 3;
const MAX_SLUG_LEN = 64;

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

/**
 * Validate project slug against AC #2 rules.
 * @param slug Raw slug string
 * @returns Error message if invalid, null if valid
 */
function validateSlug(slug: string): string | null {
	if (!slug || typeof slug !== "string") {
		return "slug must be a non-empty string";
	}

	const trimmed = slug.trim();
	if (trimmed.length < MIN_SLUG_LEN) {
		return `slug must be at least ${MIN_SLUG_LEN} characters`;
	}
	if (trimmed.length > MAX_SLUG_LEN) {
		return `slug must not exceed ${MAX_SLUG_LEN} characters`;
	}

	if (!SLUG_PATTERN.test(trimmed)) {
		return "slug must match ^[a-z][a-z0-9-]*[a-z0-9]$ (lowercase, alphanumeric + hyphens, start/end with letter or digit)";
	}

	return null;
}

/**
 * Compute worktree_root path.
 * @param slug Project slug
 * @param worktreeRootArg Optional override from args
 * @returns Computed or provided worktree_root path
 */
function computeWorktreeRoot(slug: string, worktreeRootArg?: string): string {
	if (worktreeRootArg) {
		return worktreeRootArg;
	}
	const baseRoot = process.env.AGENTHIVE_WORKTREES_ROOT ?? "/data/code";
	return `${baseRoot}/${slug}/worktree`;
}

/**
 * Create a new project (P483 Phase 1 + P495 Saga).
 *
 * Entry point that delegates to either projectCreateWithSaga (if AGENTHIVE_TENANT_SAGA=true)
 * or projectCreateLegacy (default, P483 worktree-only mode).
 *
 * @param args {slug, name, worktree_root?, default_workflow_template?}
 * @returns {ok, project_id, dsn_validated} (saga mode) or
 *          {ok, project, worktree_created, repair_needed, note?} (legacy mode)
 */
export async function projectCreate(args: {
	slug?: string;
	name?: string;
	worktree_root?: string;
	default_workflow_template?: string;
}): Promise<CallToolResult> {
	const useSaga = process.env.AGENTHIVE_TENANT_SAGA === 'true';
	if (useSaga) {
		return projectCreateWithSaga(args);
	}
	return projectCreateLegacy(args);
}

/**
 * P495 Saga-based project creation (full tenant DB bootstrap)
 */
async function projectCreateWithSaga(args: {
	slug?: string;
	name?: string;
	worktree_root?: string;
	default_workflow_template?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.slug || !args.name) {
			return errorResult(
				"projectCreate (saga mode) requires 'slug' and 'name'",
				new Error("Missing required args")
			);
		}

		const result = await projectCreateSaga(args.slug, args.name);

		if (!result.ok) {
			return jsonResult(result);
		}

		return jsonResult({
			ok: true,
			project_id: result.project_id,
			dsn_validated: result.dsn_validated,
			message: `Project '${args.slug}' created successfully with tenant DB`,
		});
	} catch (err) {
		return errorResult("Saga project creation failed", err);
	}
}

/**
 * Legacy P483 Phase 1 project creation (worktree-only, no tenant DB).
 *
 * AC #2: Validate slug against safe pattern.
 * AC #100: Transactional insert with worktree orphan detection.
 * AC #103: On failed directory stat, queue for repair instead of failing.
 */
async function projectCreateLegacy(args: {
	slug?: string;
	name?: string;
	worktree_root?: string;
	default_workflow_template?: string;
}): Promise<CallToolResult> {
	try {
		// Validate slug
		if (!args.slug) {
			return jsonResult({
				ok: false,
				error: "missing_slug",
				message: "projectCreateLegacy requires 'slug'",
			});
		}

		const slugValidationError = validateSlug(args.slug);
		if (slugValidationError) {
			return jsonResult({
				ok: false,
				error: "invalid_slug",
				slug: args.slug,
				message: slugValidationError,
			});
		}

		const slug = args.slug.trim().toLowerCase();

		// Validate name
		if (!args.name || typeof args.name !== "string") {
			return jsonResult({
				ok: false,
				error: "missing_name",
				message: "projectCreateLegacy requires 'name'",
			});
		}

		const name = args.name.trim();
		if (!name.length) {
			return jsonResult({
				ok: false,
				error: "empty_name",
				message: "projectCreate requires non-empty name",
			});
		}

		// Compute worktree_root
		const worktreeRoot = computeWorktreeRoot(slug, args.worktree_root);

		// Transaction boundary (AC #100)
		let projectId: number;
		let repairNeeded = false;

		try {
			// Begin explicit transaction
			await query("BEGIN");

			try {
				// INSERT into roadmap.project
				const insertResult = await query<{ project_id: number }>(
					`INSERT INTO roadmap.project (slug, name, worktree_root, status, created_at)
					 VALUES ($1, $2, $3, 'active', NOW())
					 RETURNING project_id`,
					[slug, name, worktreeRoot]
				);

				if (!insertResult.rows.length) {
					await query("ROLLBACK");
					return errorResult(
						"projectCreate: Failed to insert project",
						new Error("No RETURNING result")
					);
				}

				projectId = insertResult.rows[0].project_id;

				// Stat worktree directory inside tx (AC #100 fix)
				// If it does NOT exist, queue for repair instead of failing
				try {
					await stat(worktreeRoot);
				} catch (err) {
					// Directory doesn't exist or inaccessible; queue for repair
					repairNeeded = true;

					// Insert repair queue row (within same transaction)
					await query(
						`INSERT INTO roadmap.project_repair_queue (project_id, phase, failure_reason, status)
						 VALUES ($1, $2, $3, $4)`,
						[projectId, 'bootstrap', `worktree_root does not exist: ${worktreeRoot}`, 'queued']
					);
				}

				// Commit the transaction
				await query("COMMIT");
			} catch (err) {
				// Inner try failed; rollback
				try {
					await query("ROLLBACK");
				} catch {
					// Rollback itself failed; continue with outer error handling
				}
				throw err;
			}
		} catch (err) {
			// Transaction failed or rolled back
			if ((err as any).code === "23505") {
				// Unique constraint violation on slug
				return jsonResult({
					ok: false,
					error: "slug_collision",
					slug,
					message: `Project with slug '${slug}' already exists`,
				});
			}
			throw err;
		}

		// Post-commit: mkdir -p worktree_root with mode 0o775
		let worktreeCreated = false;
		let mkdirError: string | null = null;

		try {
			await mkdir(worktreeRoot, { mode: 0o775, recursive: true });
			worktreeCreated = true;
		} catch (err) {
			// mkdir failed; already queued for repair
			mkdirError = err instanceof Error ? err.message : String(err);
		}

		// Build response
		const response: Record<string, unknown> = {
			ok: true,
			project: {
				project_id: projectId,
				slug,
				name,
				worktree_root: worktreeRoot,
			},
			worktree_created: worktreeCreated,
			repair_needed: repairNeeded,
		};

		if (repairNeeded || mkdirError) {
			response.note = [
				"Worktree directory has issues:",
				mkdirError ? `mkdir failed: ${mkdirError}` : "Directory did not exist at commit time",
				"Project registered; repair queued.",
				"",
				"If agency users cannot write to worktree, run:",
				`  sudo chgrp dev ${worktreeRoot} && sudo chmod g+w ${worktreeRoot}`,
			].join("\n");
		}

		return jsonResult(response);
	} catch (err) {
		return errorResult("Failed to create project", err);
	}
}

/**
 * List projects with repair queue status (for operators).
 * Internal use; not exposed as MCP action in Phase 1.
 * Deferred to Phase 2.
 */
export async function getRepairQueue(args?: {
	unresolved_only?: boolean;
	limit?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args?.limit ?? 50, 1), 500);
		const unresolvedOnly = args?.unresolved_only === true;

		let sql = `SELECT id, project_id, reason, queued_at, resolved_at
				   FROM roadmap.project_repair_queue`;

		if (unresolvedOnly) {
			sql += ` WHERE resolved_at IS NULL`;
		}

		sql += ` ORDER BY queued_at DESC LIMIT $${unresolvedOnly ? 2 : 1}`;
		const params = unresolvedOnly ? [limit] : [limit];

		const { rows } = await query<{
			id: number;
			project_id: number;
			reason: string;
			queued_at: string;
			resolved_at: string | null;
		}>(sql, params);

		return jsonResult({
			total: rows.length,
			items: rows.map((r) => ({
				id: r.id,
				project_id: r.project_id,
				reason: r.reason,
				queued_at: r.queued_at,
				resolved_at: r.resolved_at,
				status: r.resolved_at ? "resolved" : "pending",
			})),
		});
	} catch (err) {
		return errorResult("Failed to get repair queue", err);
	}
}
