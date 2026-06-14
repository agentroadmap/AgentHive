/**
 * P1114 AC-7 — clearance drift guard (cron, intended 4x/hour).
 *
 * Fails (exit 1) when a tool is registered WITHOUT a P1114 `clearance` field,
 * so a newly-added tool can't silently ship without declaring its minimum trust
 * tier. Introspects the SAME shared registry the server registers
 * (src/apps/mcp-server/tool-registry-introspect.ts) — never a hardcoded list —
 * so the guard cannot go stale relative to the real tool surface.
 *
 * Rollout backlog: P1114 AC-6 annotates only the 4 representative tools; the
 * remaining tools are not-yet-annotated and are listed in KNOWN_UNDECLARED so
 * the cron passes on today's surface while still catching NEW undeclared tools
 * (genuine drift). Drain KNOWN_UNDECLARED as tools get clearance; a tool that
 * gains clearance but is left in the allowlist is flagged as a stale entry.
 *
 * Run:  node --import jiti/register scripts/clearance-drift.ts
 *   --strict   ignore KNOWN_UNDECLARED — fail on ANY undeclared tool
 *               (use once the backlog is fully drained).
 *
 * Exit: 0 = no drift; 1 = drift detected (new undeclared tool, or stale
 *       allowlist entry).
 */

import { collectToolDescriptors } from "../src/apps/mcp-server/tool-registry-introspect.ts";

/**
 * P1114 rollout backlog — tools known to be undeclared as of AC-6. NOT a
 * permanent exemption: each should gain a `clearance` field over time, after
 * which it must be removed from this set (the guard reports stale entries).
 */
const KNOWN_UNDECLARED: ReadonlySet<string> = new Set<string>([
	"add_cross_project_dep",
	"add_dependency",
	"agent_credential_claim",
	"agent_credential_deliver",
	"agent_credential_retrieve",
	"agent_credential_spawn_manifest",
	"backup_list",
	"backup_take",
	"backup_verify",
	"can_promote",
	"chan_list",
	"chan_subscribe",
	"check_cycle",
	"create_note",
	"delete_note",
	"directive_add",
	"directive_archive",
	"directive_list",
	"directive_remove",
	"directive_rename",
	"dlq_expire",
	"dlq_inspect",
	"dlq_list",
	"dlq_replay",
	"dlq_stats",
	"get_chat_skill",
	"get_dependencies",
	"get_proposal_creation_guide",
	"get_proposal_execution_guide",
	"get_proposal_finalization_guide",
	"get_workflow_overview",
	"knowledge_add",
	"knowledge_extract_pattern",
	"knowledge_get_decisions",
	"knowledge_get_stats",
	"knowledge_mark_helpful",
	"knowledge_record_decision",
	"knowledge_search",
	"liaison_stuck_messages",
	"mcp_get_proposal_projection",
	"msg_ack",
	"msg_mark_read",
	"msg_read",
	"msg_reply",
	"msg_tail",
	"msg_unread_count",
	"msg_wait_reply",
	"note_display",
	"note_list",
	"prop_claim",
	"prop_create",
	"prop_delete",
	"prop_get",
	"prop_get_detail",
	"prop_get_projection",
	"prop_history",
	"prop_leases",
	"prop_map_get",
	"prop_map_query",
	"prop_map_summary",
	"prop_map_upsert",
	"prop_release",
	"prop_renew",
	"prop_report_no_op",
	"prop_set_maturity",
	"prop_update",
	"protocol_pg_create_thread",
	"protocol_pg_get_thread",
	"protocol_pg_list_threads",
	"protocol_pg_mark_read",
	"protocol_pg_notifications",
	"protocol_pg_reply",
	"protocol_pg_search_mentions",
	"protocol_pg_send_mention",
	"reeval_budget_check",
	"reeval_claim",
	"reeval_decide",
	"reeval_flag_complete",
	"reeval_flag_stale",
	"reeval_list",
	"reeval_projection",
	"reeval_release",
	"remove_dependency",
	"resolve_dependency",
	"schema_describe",
	"tenant_ops_cleanup",
	"tenant_ops_setup",
	"test_check_blocked",
	"test_discover",
	"test_issue_create",
	"test_issue_resolve",
	"test_issues",
	"test_run",
]);

function main(): number {
	const strict = process.argv.includes("--strict");
	const descriptors = collectToolDescriptors(process.cwd());

	const undeclared = descriptors
		.filter((d) => d.clearance === null)
		.map((d) => d.name);

	// Drift A: undeclared tools that are NOT in the rollout backlog (or any
	// undeclared tool in --strict mode).
	const driftNew = strict
		? undeclared
		: undeclared.filter((name) => !KNOWN_UNDECLARED.has(name));

	// Drift B: allowlist entries that have since gained clearance (or were
	// removed) — stale exemptions to clean up. Skipped in --strict (allowlist
	// is ignored there).
	const declaredNames = new Set(
		descriptors.filter((d) => d.clearance !== null).map((d) => d.name),
	);
	const presentNames = new Set(descriptors.map((d) => d.name));
	const staleAllowlist = strict
		? []
		: [...KNOWN_UNDECLARED].filter(
				(name) => declaredNames.has(name) || !presentNames.has(name),
			);

	console.log(
		`[clearance-drift] mode=${strict ? "strict" : "backlog-aware"}  tools=${descriptors.length}  declared=${declaredNames.size}  undeclared=${undeclared.length}`,
	);

	let exit = 0;

	if (driftNew.length > 0) {
		exit = 1;
		console.error(
			`\n❌ DRIFT: ${driftNew.length} tool(s) registered WITHOUT a P1114 clearance field` +
				(strict ? "" : " and not in the rollout backlog (KNOWN_UNDECLARED)") +
				":",
		);
		for (const name of driftNew) console.error(`   · ${name}`);
		console.error(
			"\nDeclare clearance: { min_tier, scope } on each tool's addTool(...) " +
				"registration, or (only for an intentional rollout deferral) add it to " +
				"KNOWN_UNDECLARED in this file with a tracking note.",
		);
	}

	if (staleAllowlist.length > 0) {
		exit = 1;
		console.error(
			`\n⚠️  STALE ALLOWLIST: ${staleAllowlist.length} KNOWN_UNDECLARED entr(ies) now declared or removed — delete them:`,
		);
		for (const name of staleAllowlist) console.error(`   · ${name}`);
	}

	if (exit === 0) {
		console.log("✅ No clearance drift detected.");
	}
	return exit;
}

process.exit(main());
