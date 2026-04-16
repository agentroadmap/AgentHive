import type { McpServer } from "../server.ts";
import type { CallToolResult, McpToolHandler } from "../types.ts";

type RouteMap = Record<string, string>;

type RouterArgs = {
	action?: string;
	args?: Record<string, unknown>;
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
		.map(([action, tool]) => `- ${action} -> ${tool}`);
	return textResult(`Actions for ${domain}:\n${lines.join("\n")}`);
}

function extractArgs(input: RouterArgs): Record<string, unknown> {
	const { action: _action, args, ...rest } = input;
	if (args && typeof args === "object" && !Array.isArray(args)) {
		return { ...rest, ...args };
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

const proposalRoutes: RouteMap = {
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
	merge_worktree: "worktree_merge",
	sync_worktrees: "worktree_sync",
	merge_status: "worktree_merge_status",
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
	workflow_load_builtin: "workflow_load_builtin",
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
			"Consolidated proposal interface. Use actions for CRUD, projection detail, maturity, leases, criteria, dependencies, reviews, discussion, and worktree merge.",
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
			"mcp_ops",
			"Consolidated operations interface for spending, models, escalation, tests, workflow loading, and federation.",
			opsRoutes,
		),
	);
}
