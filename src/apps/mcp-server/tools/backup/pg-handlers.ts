/**
 * Backup MCP Handlers for AgentHive2.
 *
 * Provides take_backup, verify_backup, and list_backups MCP actions
 * backed by core.tenant_backup and core.tenant_backup_policy.
 *
 * P895: Backup harness
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
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

function ok(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

/** Invoke the backup shell script for a given project schema or full DB. */
export async function takeBackup(args: {
	schema?: string;
	host?: string;
	port?: number;
	user?: string;
	database?: string;
	output_dir?: string;
	dry_run?: boolean;
}): Promise<CallToolResult> {
	try {
		const scriptPath = path.resolve(
			process.cwd(),
			"deploy/scripts/backup.sh",
		);
		if (!existsSync(scriptPath)) {
			return errorResult("take_backup", new Error(`Script not found: ${scriptPath}`));
		}

		const parts: string[] = [scriptPath];
		if (args.host) parts.push("-h", args.host);
		if (args.port) parts.push("-p", String(args.port));
		if (args.user) parts.push("-U", args.user);
		if (args.database) parts.push("-d", args.database);
		if (args.schema) parts.push("-s", args.schema);
		if (args.output_dir) parts.push("-o", args.output_dir);
		if (args.dry_run) parts.push("--dry-run");

		const cmd = parts.map((p) => JSON.stringify(p)).join(" ");
		const output = execSync(`bash ${cmd}`, { encoding: "utf8", timeout: 300_000 });
		return ok(output.trim());
	} catch (err) {
		return errorResult("take_backup failed", err);
	}
}

/** Invoke the verify script for a specific backup_id. */
export async function verifyBackup(args: {
	backup_id: string;
	host?: string;
	port?: number;
	user?: string;
	database?: string;
	dry_run?: boolean;
}): Promise<CallToolResult> {
	if (!args.backup_id) {
		return errorResult("verify_backup", new Error("backup_id is required"));
	}
	try {
		const scriptPath = path.resolve(
			process.cwd(),
			"deploy/scripts/verify-backup.sh",
		);
		if (!existsSync(scriptPath)) {
			return errorResult("verify_backup", new Error(`Script not found: ${scriptPath}`));
		}

		const parts: string[] = [scriptPath, "-b", args.backup_id];
		if (args.host) parts.push("-h", args.host);
		if (args.port) parts.push("-p", String(args.port));
		if (args.user) parts.push("-U", args.user);
		if (args.database) parts.push("-d", args.database);
		if (args.dry_run) parts.push("--dry-run");

		const cmd = parts.map((p) => JSON.stringify(p)).join(" ");
		const output = execSync(`bash ${cmd}`, { encoding: "utf8", timeout: 600_000 });
		return ok(output.trim());
	} catch (err) {
		return errorResult("verify_backup failed", err);
	}
}

/** List backups from core.tenant_backup, optionally filtered by project schema. */
export async function listBackups(args: {
	schema?: string;
	limit?: number;
	include_pruned?: boolean;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
		const whereClauses: string[] = [];
		const params: unknown[] = [limit];
		let idx = 2;

		if (args.schema) {
			whereClauses.push(`tb.schema_name = $${idx}`);
			params.push(args.schema);
			idx++;
		}

		if (!args.include_pruned) {
			whereClauses.push(`(tb.metadata_jsonb->>'pruned_at') IS NULL`);
		}

		const whereStr =
			whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

		const { rows } = await query<{
			backup_id: string;
			project_slug: string | null;
			taken_at: string;
			backup_kind: string;
			size_bytes: number | null;
			schema_name: string | null;
			verify_status: string | null;
			retention_until: string;
			storage_uri: string;
		}>(
			`SELECT
        tb.backup_id,
        p.slug AS project_slug,
        tb.taken_at,
        tb.backup_kind,
        tb.size_bytes,
        tb.schema_name,
        tb.verify_status,
        tb.retention_until,
        tb.storage_uri
      FROM core.tenant_backup tb
      LEFT JOIN core.project p ON tb.project_id = p.id
      ${whereStr}
      ORDER BY tb.taken_at DESC
      LIMIT $1`,
			params,
		);

		if (rows.length === 0) {
			return ok("No backups found.");
		}

		const lines = rows.map(
			(r) =>
				`${r.backup_id}  ${r.backup_kind.padEnd(7)}  ${r.taken_at}  ` +
				`${(r.schema_name ?? r.project_slug ?? "full").padEnd(20)}  ` +
				`verify=${r.verify_status ?? "none"}  ` +
				`size=${r.size_bytes != null ? `${Math.round(r.size_bytes / 1024)}KB` : "?"}  ` +
				`retain_until=${r.retention_until}`,
		);
		return ok(`Backups (${rows.length}):\n${lines.join("\n")}`);
	} catch (err) {
		return errorResult("list_backups", err);
	}
}
