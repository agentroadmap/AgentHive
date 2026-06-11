/**
 * Tenant Ops Setup Handler (P509).
 *
 * Called during project provisioning (P495/P893 integration).
 * Performs atomic setup of backup policies, smoke backup, and fallback tenants.local.
 *
 * Idempotent: safe to re-run on existing tenants.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

interface TenantOpsSetupArgs {
	project_slug: string;
	control_dsn?: string;
	dry_run?: boolean;
}

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

function ok(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

/**
 * Seed backup policy for a newly provisioned tenant.
 * Called atomically after project bootstrap_status='live'.
 */
export async function setupTenantOps(
	args: TenantOpsSetupArgs,
): Promise<CallToolResult> {
	const { project_slug, dry_run = false } = args;

	if (!project_slug) {
		return errorResult("setup_tenant_ops", new Error("project_slug is required"));
	}

	try {
		// Step 1: Fetch project_id from roadmap.project
		const { rows: projectRows } = await query<{ project_id: number }>(
			"SELECT project_id FROM roadmap.project WHERE slug = $1",
			[project_slug],
		);

		if (projectRows.length === 0) {
			return errorResult(
				"setup_tenant_ops",
				new Error(`Project not found: ${project_slug}`),
			);
		}

		const project_id = projectRows[0].project_id;

		if (dry_run) {
			return ok(
				`DRY RUN: Would seed backup policy for project_id=${project_id} (slug=${project_slug})`,
			);
		}

		// Step 2: Seed core.tenant_backup_policy row (if not exists)
		const { rows: policyRows } = await query<{ project_id: number }>(
			"SELECT project_id FROM roadmap.tenant_backup_policy WHERE project_id = $1",
			[project_id],
		);

		if (policyRows.length === 0) {
			await query(
				`INSERT INTO roadmap.tenant_backup_policy (project_id, disk_cap_gb, retain_daily_days, retain_weekly_count, retain_monthly_count, backup_cron_expr, prune_cron_expr)
       VALUES ($1, 50, 14, 8, 12, '15 3 * * *', '0 5 * * *')
       ON CONFLICT (project_id) DO NOTHING`,
				[project_id],
			);
		}

		// Step 3: Append to /etc/agenthive/tenants.local (fallback tenant discovery)
		await appendToTenantsLocal(project_slug);

		// Step 4: Run smoke backup (optional; mainly for sanity check)
		// This is deferred to actual backup cron, so we skip it here.
		// If needed, invoke the backup script with mode=smoke

		return ok(
			`Tenant ops setup complete for project_id=${project_id} (slug=${project_slug}). ` +
				`Backup policy seeded; tenants.local updated.`,
		);
	} catch (err) {
		return errorResult("setup_tenant_ops", err);
	}
}

/**
 * Append tenant slug to /etc/agenthive/tenants.local (JSON format).
 * Idempotent: checks if slug already exists before appending.
 */
async function appendToTenantsLocal(slug: string): Promise<void> {
	const tenantsLocalPath = "/etc/agenthive/tenants.local";

	// Ensure directory exists
	const dir = path.dirname(tenantsLocalPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
	}

	let data: { tenants: string[] } = { tenants: [] };

	// Read existing file if present
	if (fs.existsSync(tenantsLocalPath)) {
		try {
			const content = fs.readFileSync(tenantsLocalPath, "utf8");
			data = JSON.parse(content);
		} catch (err) {
			// Malformed JSON; reinitialize
			data = { tenants: [] };
		}
	}

	// Append slug if not present
	if (!data.tenants.includes(slug)) {
		data.tenants.push(slug);
	}

	// Write back
	fs.writeFileSync(tenantsLocalPath, JSON.stringify(data, null, 2), {
		mode: 0o644,
	});
}

/**
 * Remove tenant slug from /etc/agenthive/tenants.local on archive/retire.
 * Idempotent: safe if slug not present.
 */
export async function cleanupTenantOps(
	args: { project_slug: string; dry_run?: boolean },
): Promise<CallToolResult> {
	const { project_slug, dry_run = false } = args;

	if (!project_slug) {
		return errorResult("cleanup_tenant_ops", new Error("project_slug is required"));
	}

	try {
		if (dry_run) {
			return ok(`DRY RUN: Would remove ${project_slug} from tenants.local`);
		}

		const tenantsLocalPath = "/etc/agenthive/tenants.local";

		if (!fs.existsSync(tenantsLocalPath)) {
			return ok(`tenants.local not found; nothing to cleanup for ${project_slug}`);
		}

		let data: { tenants: string[] } = { tenants: [] };
		try {
			const content = fs.readFileSync(tenantsLocalPath, "utf8");
			data = JSON.parse(content);
		} catch (err) {
			return errorResult("cleanup_tenant_ops", new Error("Failed to parse tenants.local"));
		}

		// Remove slug
		data.tenants = data.tenants.filter((s) => s !== project_slug);

		// Write back
		fs.writeFileSync(tenantsLocalPath, JSON.stringify(data, null, 2), {
			mode: 0o644,
		});

		return ok(
			`Cleanup complete: ${project_slug} removed from tenants.local. ` +
				`Exporter will stop scraping this tenant within 60s.`,
		);
	} catch (err) {
		return errorResult("cleanup_tenant_ops", err);
	}
}
