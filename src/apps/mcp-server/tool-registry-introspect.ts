/**
 * P1114 AC-7 — DB-free tool-registry introspection.
 *
 * The canonical source of truth for "which MCP tools exist" is the set of
 * `server.addTool(...)` calls executed by the `register*Tools(server)` family
 * (see server.ts → createMcpServer). Those functions only need an object with
 * an `addTool` method; the handler classes they construct are pool-lazy (they
 * open no DB connection until a tool handler actually runs). That lets us
 * enumerate the registry — and each tool's P1114 `clearance` declaration —
 * WITHOUT booting the full DB-backed server, registering crons, or touching the
 * live database.
 *
 * This module collects descriptors from the cleanly-factored registration
 * functions that own the representative tools P1114 annotates (proposals,
 * messaging, schema) plus the other side-effect-free families. Tools that are
 * registered INLINE inside createMcpServer's Postgres branch (workforce / ops /
 * agency families) are NOT reachable without booting the server and are listed
 * in INLINE_BOOTSTRAP_FAMILIES so callers can report the coverage boundary
 * honestly rather than silently under-counting.
 *
 * Both scripts/clearance-audit.ts and scripts/clearance-drift.ts consume this
 * single function so the audit and the drift guard can never diverge.
 */

import { registerBackupTools } from "./tools/backup/index.ts";
import { registerDependencyTools } from "./tools/dependencies/index.ts";
import { registerKnowledgeTools } from "./tools/knowledge/index.ts";
import { registerMessageTools } from "./tools/messages/index.ts";
import { registerMilestoneTools } from "./tools/milestones/index.ts";
import { registerNoteTools } from "./tools/notes/index.ts";
import { registerProposalTools } from "./tools/proposals/backend-switch.ts";
import { registerProtocolTools } from "./tools/protocol/index.ts";
import { registerSchemaTools } from "./tools/schema/index.ts";
import { registerTestingTools } from "./tools/testing/index.ts";
import { registerWorkflowTools } from "./tools/workflow/index.ts";
import type { McpServer } from "./server.ts";
import type { McpToolHandler, ToolClearance } from "./types.ts";

/** A registered tool plus its P1114 clearance (or null when UNDECLARED). */
export interface ToolDescriptor {
	name: string;
	description: string;
	clearance: ToolClearance | null;
}

/**
 * Minimal duck-typed stand-in for McpServer that only collects tool
 * descriptors. Registration code calls `addTool` (and occasionally a couple of
 * surface toggles); everything else is a no-op. No DB, no crons, no listeners.
 */
export class ToolCollector {
	public readonly tools = new Map<string, McpToolHandler>();

	addTool(tool: McpToolHandler): void {
		// Last-write-wins, mirroring McpServer.addTool semantics.
		this.tools.set(tool.name, tool);
	}

	// No-op surface methods some registration paths may touch.
	setConsolidatedToolSurface(_enabled: boolean): void {}
}

/**
 * Registration functions that are pure (no DB / cron side-effects at
 * registration time) and own the representative P1114 tools plus the rest of
 * the side-effect-free families. Each entry is invoked against the collector.
 */
type RegisterFn = (collector: ToolCollector, projectRoot: string) => unknown;

const SIDE_EFFECT_FREE_REGISTRARS: ReadonlyArray<{
	name: string;
	fn: RegisterFn;
}> = [
	{ name: "workflow", fn: (c) => registerWorkflowTools(c as unknown as McpServer) },
	{ name: "notes", fn: (c, root) => registerNoteTools(c as unknown as McpServer, root) },
	{ name: "milestones", fn: (c) => registerMilestoneTools(c as unknown as McpServer) },
	{ name: "knowledge", fn: (c) => registerKnowledgeTools(c as unknown as McpServer) },
	{ name: "protocol", fn: (c) => registerProtocolTools(c as unknown as McpServer) },
	{
		name: "proposals(prop_list/prop_transition)",
		fn: (c, root) => registerProposalTools(c as unknown as McpServer, root),
	},
	{ name: "messages(msg_send)", fn: (c) => registerMessageTools(c as unknown as McpServer) },
	{ name: "testing", fn: (c) => registerTestingTools(c as unknown as McpServer) },
	{ name: "dependencies", fn: (c) => registerDependencyTools(c as unknown as McpServer) },
	{ name: "backup", fn: (c) => registerBackupTools(c as unknown as McpServer) },
	{ name: "schema(schema_lint_migration)", fn: (c) => registerSchemaTools(c as unknown as McpServer) },
];

/**
 * Tool families registered INLINE inside createMcpServer's Postgres branch.
 * These cannot be enumerated without booting the DB-backed server. Reported by
 * callers as the known coverage boundary (not silently dropped).
 */
export const INLINE_BOOTSTRAP_FAMILIES: ReadonlyArray<string> = [
	"workforce (agency_register, provider_register, dispatch_*, worker_register, agency_cap_*)",
	"agency lifecycle (agency_bootstrap, agency_join_project, ...)",
	"ops (sla_*, pgbouncer_*, cooldown_*, capacity_*, d4_validate)",
	"agents/spending/models inline (agent_*, spending_*, model_list)",
	"consolidated (mcp_* aggregate surface)",
];

/**
 * Enumerate every tool reachable through the side-effect-free registrars.
 * Returns descriptors sorted by name. DB-free: safe to run from a cron.
 */
export function collectToolDescriptors(
	projectRoot: string = process.cwd(),
): ToolDescriptor[] {
	const collector = new ToolCollector();
	for (const { fn } of SIDE_EFFECT_FREE_REGISTRARS) {
		fn(collector, projectRoot);
	}
	const descriptors: ToolDescriptor[] = [];
	for (const tool of collector.tools.values()) {
		descriptors.push({
			name: tool.name,
			description: tool.description,
			clearance: tool.clearance ?? null,
		});
	}
	descriptors.sort((a, b) => a.name.localeCompare(b.name));
	return descriptors;
}
