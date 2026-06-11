import type { McpServer } from "../../server.ts";
import { takeBackup, verifyBackup, listBackups } from "./pg-handlers.ts";
import { setupTenantOps, cleanupTenantOps } from "../ops/tenant-ops-setup.ts";

export function registerBackupTools(server: McpServer): void {
	server.addTool({
		name: "backup_take",
		description: "Take a pg_dump backup for a project schema or the full database",
		inputSchema: {
			type: "object",
			properties: {
				schema: { type: "string", description: "Project schema name; omit for full-DB backup" },
				host: { type: "string", description: "Postgres host (default: 127.0.0.1)" },
				port: { type: "number", description: "Postgres port (default: 5432)" },
				user: { type: "string", description: "Postgres user (default: admin)" },
				database: { type: "string", description: "Database name (default: agentHive2)" },
				output_dir: { type: "string", description: "Override output directory" },
				dry_run: { type: "boolean", description: "Print commands without executing" },
			},
		},
		handler: async (args) => takeBackup(args as any),
	});

	server.addTool({
		name: "backup_verify",
		description: "Restore a backup to a temp DB and verify integrity, updating core.tenant_backup.verify_status",
		inputSchema: {
			type: "object",
			required: ["backup_id"],
			properties: {
				backup_id: { type: "string", description: "UUID from core.tenant_backup" },
				host: { type: "string" },
				port: { type: "number" },
				user: { type: "string" },
				database: { type: "string" },
				dry_run: { type: "boolean" },
			},
		},
		handler: async (args) => verifyBackup(args as any),
	});

	server.addTool({
		name: "backup_list",
		description: "List backups from core.tenant_backup, optionally filtered by project schema",
		inputSchema: {
			type: "object",
			properties: {
				schema: { type: "string", description: "Filter by project schema name" },
				limit: { type: "number", description: "Max rows to return (default: 50)" },
				include_pruned: { type: "boolean", description: "Include pruned/expired entries" },
			},
		},
		handler: async (args) => listBackups(args as any),
	});

	server.addTool({
		name: "tenant_ops_setup",
		description: "P509: Set up tenant backup ops (policy, tenants.local) after project provisioning",
		inputSchema: {
			type: "object",
			required: ["project_slug"],
			properties: {
				project_slug: { type: "string", description: "Project slug (e.g., agenthive)" },
				control_dsn: { type: "string", description: "Control-plane DSN (optional)" },
				dry_run: { type: "boolean", description: "Dry-run mode" },
			},
		},
		handler: async (args) => setupTenantOps(args as any),
	});

	server.addTool({
		name: "tenant_ops_cleanup",
		description: "P509: Clean up tenant from ops (remove from tenants.local) on archive",
		inputSchema: {
			type: "object",
			required: ["project_slug"],
			properties: {
				project_slug: { type: "string", description: "Project slug" },
				dry_run: { type: "boolean", description: "Dry-run mode" },
			},
		},
		handler: async (args) => cleanupTenantOps(args as any),
	});
}
