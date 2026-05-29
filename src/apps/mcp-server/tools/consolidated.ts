import type { McpServer } from "../server.ts";
import type { CallToolResult, McpToolHandler } from "../types.ts";

type RouteMap = Record<string, string>;

type RouterArgs = {
	action?: string;
	args?: Record<string, unknown> | string;
	[key: string]: unknown;
};

const jsonObjectSchema = {
	type: "object",
	additionalProperties: true,
};

const routerSchema = {
	type: "object",
	properties: {
		action: {
			type: "string",
			description: "Domain action to run. Use action=list_actions to inspect supported actions.",
		},
		args: {
			...jsonObjectSchema,
			description: "Arguments passed to the selected action.",
		},
	},
	required: ["action"],
	additionalProperties: true,
};

function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function formatActions(domain: string, routes: RouteMap): CallToolResult {
	const lines = Object.entries(routes)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([action, tool]) => `- ${action}  tool_name: ${tool}`);
	return textResult(`Actions for ${domain}:\n${lines.join("\n")}`);
}

export function extractArgs(input: RouterArgs): Record<string, unknown> {
	const { action: _action, args, ...rest } = input;
	// args may arrive as an object (well-behaved client) or as a JSON-encoded
	// string (some MCP clients stringify nested object params before send).
	// Tolerate both — parse the string form once before merging.
	let argsObj: Record<string, unknown> | undefined;
	if (args && typeof args === "object" && !Array.isArray(args)) {
		argsObj = args as Record<string, unknown>;
	} else if (typeof args === "string" && args.trim().length) {
		try {
			const parsed = JSON.parse(args);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				argsObj = parsed as Record<string, unknown>;
			}
		} catch {
			// Leave argsObj undefined; rest-only fallback below
		}
	}
	if (argsObj) {
		return { ...rest, ...argsObj };
	}
	return rest;
}

function createRouterTool(
	server: McpServer,
	name: string,
	description: string,
	routes: RouteMap,
): McpToolHandler {
	return {
		name,
		description,
		inputSchema: routerSchema,
		async handler(input: Record<string, unknown>): Promise<CallToolResult> {
			const request = input as RouterArgs;
			const action = request.action?.trim();
			if (!action || action === "list_actions") {
				return formatActions(name, routes);
			}

			const toolName = routes[action];
			if (!toolName) {
				return textResult(
					`Unknown ${name} action '${action}'. Use action=list_actions to inspect supported actions.`,
				);
			}

			return server.invokeTool(toolName, extractArgs(request));
		},
	};
}

// Agents frequently call the underlying tool name (with prefix) instead of
// the consolidated short action — e.g. `prop_get`, `prop_list`, `prop_claim`.
// They also try `mcp_get_proposal_projection` directly. Accept all canonical
// short names AND the raw tool names, so a misremembered call doesn't strand
// a gate/review run with "Unknown action".
const proposalRoutes: RouteMap = {
	// canonical short actions
	list: "prop_list",
	get: "prop_get",
	detail: "mcp_get_proposal_projection",
	project: "mcp_get_proposal_projection",
	create: "prop_create",
	update: "prop_update",
	delete: "prop_delete",
	transition: "prop_transition",
	set_maturity: "prop_set_maturity",
	claim: "prop_claim",
	release: "prop_release",
	renew: "prop_renew",
	leases: "prop_leases",
	add_criteria: "add_acceptance_criteria",
	verify_criteria: "verify_ac",
	list_criteria: "list_ac",
	delete_criteria: "delete_ac",
	add_dependency: "add_dependency",
	get_dependencies: "get_dependencies",
	resolve_dependency: "resolve_dependency",
	remove_dependency: "remove_dependency",
	check_cycle: "check_cycle",
	can_promote: "can_promote",
	submit_review: "submit_review",
	list_reviews: "list_reviews",
	add_discussion: "add_discussion",
	gate_decision: "record_gate_decision",
	record_gate_decision: "record_gate_decision",
	merge_worktree: "worktree_merge",
	sync_worktrees: "worktree_sync",
	merge_status: "worktree_merge_status",
	get_detail: "mcp_get_proposal_projection",
	// Common variant names agents try when they don't recall the canonical
	// short action — route them all to the projection tool, which returns
	// summary/design/AC/lease/decisions in one payload (the union of what a
	// gate/review agent typically wants up-front).
	get_projection: "mcp_get_proposal_projection",
	get_acceptance_criteria: "list_ac",
	get_ac: "list_ac",
	get_discussions: "mcp_get_proposal_projection",
	get_advisory: "mcp_get_proposal_projection",
	// raw-tool aliases (agents often dispatch on raw tool names)
	prop_list: "prop_list",
	prop_get: "prop_get",
	// `prop_get_detail` is registered but its handler binding (handlers.getProposalDetail)
	// does not exist — the call throws at dispatch. Route to the projection tool until
	// the handler is implemented (TODO P609 follow-up).
	prop_get_detail: "mcp_get_proposal_projection",
	prop_create: "prop_create",
	prop_update: "prop_update",
	prop_delete: "prop_delete",
	prop_transition: "prop_transition",
	prop_set_maturity: "prop_set_maturity",
	prop_claim: "prop_claim",
	prop_release: "prop_release",
	prop_renew: "prop_renew",
	prop_leases: "prop_leases",
	mcp_get_proposal_projection: "mcp_get_proposal_projection",
	worktree_merge_status: "worktree_merge_status",
	worktree_merge: "worktree_merge",
	worktree_sync: "worktree_sync",
	add_acceptance_criteria: "add_acceptance_criteria",
	verify_ac: "verify_ac",
	list_ac: "list_ac",
	delete_ac: "delete_ac",
	// P997 migration-map actions
	map_upsert: "prop_map_upsert",
	map_get: "prop_map_get",
	map_query: "prop_map_query",
	map_summary: "prop_map_summary",
	prop_map_upsert: "prop_map_upsert",
	prop_map_get: "prop_map_get",
	prop_map_query: "prop_map_query",
	prop_map_summary: "prop_map_summary",
	// P466 spawn-briefing actions — primary home is `mcp_agent`, but agents
	// often guess `mcp_proposal` because the work is proposal-scoped. Alias
	// here so misrouted calls succeed instead of bouncing on "Unknown action".
	briefing_assemble: "briefing_assemble",
	briefing_load: "briefing_load",
	child_boot_check: "child_boot_check",
	spawn_summary_emit: "spawn_summary_emit",
	briefing_list: "briefing_list",
};

const messageRoutes: RouteMap = {
	send: "msg_send",
	read: "msg_read",
	mark_read: "msg_pg_mark_read",
	unread_count: "msg_pg_unread_count",
	channels: "chan_list",
	subscribe: "chan_subscribe",
	subscriptions: "chan_subscriptions",
	create_thread: "protocol_pg_create_thread",
	reply_thread: "protocol_pg_reply",
	get_thread: "protocol_pg_get_thread",
	list_threads: "protocol_pg_list_threads",
	send_mention: "protocol_pg_send_mention",
	search_mentions: "protocol_pg_search_mentions",
	notifications: "protocol_pg_notifications",
	mark_mention_read: "protocol_pg_mark_read",
};

const agentRoutes: RouteMap = {
	list: "agent_list",
	get: "agent_get",
	register: "agent_register",
	register_agency: "agent_register_agency",
	team_list: "team_list",
	team_create: "team_create",
	team_add_member: "team_add_member",
	heartbeat: "pulse_heartbeat",
	health: "pulse_health",
	fleet: "pulse_fleet",
	history: "pulse_history",
	refresh: "pulse_refresh",
	cubic_create: "cubic_create",
	cubic_list: "cubic_list",
	cubic_focus: "cubic_focus",
	cubic_transition: "cubic_transition",
	cubic_recycle: "cubic_recycle",
	cubic_acquire: "cubic_acquire",
	// P466 spawn-briefing protocol — child agents call these over the
	// `mcp_agent` router (`action: 'briefing_load'` etc.) AND the raw tool
	// names work via the standalone tool registrations.
	briefing_assemble: "briefing_assemble",
	briefing_load: "briefing_load",
	child_boot_check: "child_boot_check",
	spawn_summary_emit: "spawn_summary_emit",
	briefing_list: "briefing_list",
	fallback_playbook_add: "fallback_playbook_add",
	mcp_quirks_register: "mcp_quirks_register",
	// P917: agency lifecycle
	agency_bootstrap: "agency_bootstrap",
	agency_join_project: "agency_join_project",
	agency_leave_project: "agency_leave_project",
	agency_liaison_status: "agency_liaison_status",
	// P1129: self-service agency registration + model registration + systemd lifecycle
	pg_register: "agent_pg_register",
	register_model: "agent_register_model",
	agency_start: "agency_start",
	agency_status: "agency_status",
	resolve: "agent_resolve",
};

const memoryRoutes: RouteMap = {
	set: "memory_set",
	get: "memory_get",
	delete: "memory_delete",
	list: "memory_list",
	summary: "memory_summary",
	search: "memory_search",
	knowledge_add: "knowledge_add",
	knowledge_search: "knowledge_search",
	record_decision: "knowledge_record_decision",
	extract_pattern: "knowledge_extract_pattern",
	get_decisions: "knowledge_get_decisions",
	stats: "knowledge_get_stats",
	mark_helpful: "knowledge_mark_helpful",
};

const documentRoutes: RouteMap = {
	list: "document_pg_list",
	get: "document_pg_view",
	create: "document_pg_create",
	update: "document_pg_update",
	search: "document_pg_search",
	versions: "document_pg_versions",
	delete: "document_pg_delete",
	note_create: "create_note",
	note_list: "note_list",
	note_get: "note_display",
	note_delete: "delete_note",
};

const schemaRoutes: RouteMap = {
	describe: "schema_describe",
};

const opsRoutes: RouteMap = {
	spending_set_cap: "spending_set_cap",
	spending_log: "spending_log",
	spending_report: "spending_report",
	efficiency_report: "spending_efficiency_report",
	model_list: "model_list",
	model_add: "model_add",
	escalation_add: "escalation_add",
	escalation_list: "escalation_list",
	escalation_resolve: "escalation_resolve",
	escalation_stats: "escalation_stats",
	test_discover: "test_discover",
	test_run: "test_run",
	test_issues: "test_issues",
	test_issue_create: "test_issue_create",
	test_issue_resolve: "test_issue_resolve",
	test_check_blocked: "test_check_blocked",
	workflow_load: "workflow_load",
	workflow_list: "workflow_list",
	federation_stats: "federation_stats",
	federation_list_hosts: "federation_list_hosts",
	federation_list_join_requests: "federation_list_join_requests",
	federation_approve_join: "federation_approve_join",
	federation_deny_join: "federation_deny_join",
	federation_quarantine: "federation_quarantine",
	federation_lift_quarantine: "federation_lift_quarantine",
	federation_list_certificates: "federation_list_certificates",
	federation_failed_connections: "federation_failed_connections",
	federation_remove_host: "federation_remove_host",
	set_project: "project_set",
	list_projects: "project_registry_list",
	create_project: "project_create_v2",
	project_route_list: "project_route_list",
	project_capability_list: "project_capability_list",
	project_cap_list: "project_cap_list",
	// P187: Reference Catalog
	ref_list_domains: "ref_list_domains",
	ref_list_terms: "ref_list_terms",
	ref_add_term: "ref_add_term",
	ref_get_term: "ref_get_term",
	// P498: Config audit tool
	config_audit: "config_audit",
	// P895: Backup harness
	backup_take: "backup_take",
	backup_verify: "backup_verify",
	backup_list: "backup_list",
	// P1004: Agent cost & quota self-reporting
	report_usage: "ops_report_usage",
	ops_report_usage: "ops_report_usage",
	// P499: PgBouncer operator tools
	pgbouncer_stats: "pgbouncer_stats",
	pgbouncer_ping: "pgbouncer_ping",
	pgbouncer_reload: "pgbouncer_reload",
	// P1359: Provider/model cooldown management
	cooldown_status: "cooldown_status",
	cooldown_clear: "cooldown_clear",
	provider_cooldown_clear: "provider_cooldown_clear",
	// P1365: Agency capacity tracking
	capacity_snapshot: "capacity_snapshot",
	capacity_clear: "capacity_clear",
};

const projectRoutes: RouteMap = {
	proposal_list: "prop_list",
	proposal_detail: "mcp_get_proposal_projection",
	message_read: "msg_read",
	agent_fleet: "pulse_fleet",
	agent_health: "pulse_health",
	knowledge_search: "knowledge_search",
	document_search: "document_pg_search",
	spending_report: "spending_report",
	test_run: "test_run",
};

export function registerConsolidatedTools(server: McpServer): void {
	server.addTool(
		createRouterTool(
			server,
			"mcp_project",
			"High-level AgentHive project interface for common proposal, message, agent, knowledge, document, spending, and test actions.",
			projectRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_proposal",
			"Consolidated proposal interface. Use actions for CRUD, projection detail, maturity, leases, criteria, dependencies, reviews, discussion, and worktree merge. " +
				"PARAM-NAME GOTCHAS (read once, save retries): " +
				"`get`/`detail`/`add_acceptance_criteria`/`add_discussion`/`claim`/`release`/`verify_ac`/`list_ac` use `proposal_id` (string). " +
				"`update`/`set_maturity`/`transition`/`delete` use `id` (string) — passing `proposal_id` returns 'Proposal undefined not found'. " +
				"`add_dependency`/`remove_dependency` use camelCase `fromProposalId`/`toProposalId`/`dependencyType` (string ids, not int). " +
				"VERIFY_AC: each AC needs its own call (1-indexed item_number); ACs stay 'pending' until you explicitly call verify_ac with status='pass' — NOT inferred from tests passing or maturity advance. status enum is {pass, fail, blocked, waived}, NOT 'verified'. " +
				"ADD_ACCEPTANCE_CRITERIA: pass `criteria: string[]` (array of full sentences), NOT individual title/description fields nor `acceptance_criteria` key. " +
				"Use action=list_actions to enumerate every action name.",
			proposalRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_message",
			"Consolidated messaging interface for direct messages, channels, subscriptions, protocol threads, mentions, and notifications.",
			messageRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_agent",
			"Consolidated agent and fleet interface for registry, teams, pulse health, and cubic workspaces.",
			agentRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_memory",
			"Consolidated memory and knowledge interface for agent memory, knowledge search, decisions, and patterns.",
			memoryRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_document",
			"Consolidated document and note interface for versioned documents, search, versions, and notes.",
			documentRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_schema",
			"Schema introspection. Use this BEFORE writing migration SQL so you don't fabricate column / constraint / trigger names. action='describe' takes {table} (qualified or bare) and returns columns + CHECK constraints + triggers + indexes.",
			schemaRoutes,
		),
	);
	server.addTool(
		createRouterTool(
			server,
			"mcp_ops",
			"Consolidated operations interface for spending, models, escalation, tests, workflow loading, and federation.",
			opsRoutes,
		),
	);
}
