/**
 * P238 AC-7/AC-16: MCP operational snapshot — compact YAML+Markdown projection.
 * Returns enough context for an agent to identify active work, blockers,
 * pending gates, budget risk, and next allowed MCP actions.
 * Does NOT require agents to understand table structure.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

interface SnapshotArgs {
	project?: string;
}

async function resolveProject(
	slug: string,
): Promise<{ project_id: string; slug: string; name: string } | null> {
	const res = await query<{ project_id: string; slug: string; name: string }>(
		`SELECT project_id::text, slug, name FROM roadmap.project WHERE slug = $1 AND status = 'active' LIMIT 1`,
		[slug],
	);
	return res.rows[0] ?? null;
}

export async function handleOpsSnapshot(
	args: Record<string, unknown>,
): Promise<CallToolResult> {
	const { project: projectSlug = "agenthive" } = args as SnapshotArgs;

	const proj = await resolveProject(projectSlug);
	if (!proj) {
		return {
			content: [
				{
					type: "text",
					text: `project: ${projectSlug}\nstatus: not_found\nmessage: No active project with slug '${projectSlug}'. Use mcp_ops action=list_projects to see available projects.\n`,
				},
			],
		};
	}

	const pid = proj.project_id;

	const [queueRes, candidateRes, dispatchRes, leaseRes, liaisonRes, gateRes, budgetRes] =
		await Promise.allSettled([
			// 1. Queue pools: counts by (stage, maturity)
			query<{ stage: string; maturity: string; cnt: string; oldest_update_hours: string | null }>(
				`SELECT p.status AS stage,
				        p.maturity,
				        COUNT(*)::text AS cnt,
				        ROUND(EXTRACT(EPOCH FROM (now() - MIN(p.modified_at))) / 3600, 1)::text AS oldest_update_hours
				   FROM roadmap_proposal.proposal p
				  WHERE p.project_id = $1
				    AND lower(p.status) NOT IN ('complete','closed')
				    AND lower(p.maturity) <> 'obsolete'
				  GROUP BY p.status, p.maturity
				  ORDER BY p.status, p.maturity`,
				[pid],
			),
			// 2. Top candidates (dispatchable work)
			query<{ display_id: string; title: string; stage: string; maturity: string; priority: string; dep_blockers: string }>(
				`SELECT p.display_id,
				        p.title,
				        p.status AS stage,
				        p.maturity,
				        COALESCE(NULLIF(p.priority,''),'medium') AS priority,
				        COUNT(pd.id) FILTER (
				          WHERE lower(COALESCE(dep.status,'')) NOT IN ('complete','closed')
				            AND lower(COALESCE(dep.maturity,'')) <> 'obsolete'
				        )::text AS dep_blockers
				   FROM roadmap_proposal.proposal p
				   LEFT JOIN roadmap_proposal.proposal_dependencies pd ON pd.proposal_id = p.id
				   LEFT JOIN roadmap_proposal.proposal dep ON dep.id = pd.depends_on_id
				  WHERE p.project_id = $1
				    AND lower(p.status) = 'develop'
				    AND lower(p.maturity) IN ('new','active')
				  GROUP BY p.id, p.display_id, p.title, p.status, p.maturity, p.priority
				  ORDER BY CASE lower(COALESCE(p.priority,'')) WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
				           p.modified_at ASC
				  LIMIT 6`,
				[pid],
			),
			// 3. Active dispatches
			query<{ id: string; display_id: string | null; role: string; offer_status: string; worker: string | null; expires_in_s: string | null }>(
				`SELECT d.id::text,
				        p.display_id,
				        d.dispatch_role AS role,
				        COALESCE(d.offer_status,'?') AS offer_status,
				        COALESCE(d.worker_identity, d.agent_identity) AS worker,
				        CASE WHEN d.claim_expires_at IS NOT NULL
				             THEN ROUND(EXTRACT(EPOCH FROM (d.claim_expires_at - now())))::text
				             ELSE NULL
				        END AS expires_in_s
				   FROM roadmap_workforce.squad_dispatch d
				   LEFT JOIN roadmap_proposal.proposal p ON p.id = d.proposal_id
				  WHERE d.project_id = $1
				    AND lower(COALESCE(d.offer_status,'')) IN ('open','claimed','active')
				  ORDER BY d.assigned_at DESC NULLS LAST, d.id DESC
				  LIMIT 8`,
				[pid],
			),
			// 4. Leases: active + expired count
			query<{ active_count: string; expired_count: string }>(
				`SELECT
				   COUNT(*) FILTER (WHERE pl.released_at IS NULL AND (pl.expires_at IS NULL OR pl.expires_at >= now()))::text AS active_count,
				   COUNT(*) FILTER (WHERE pl.released_at IS NULL AND pl.expires_at IS NOT NULL AND pl.expires_at < now())::text AS expired_count
				  FROM roadmap_proposal.proposal_lease pl
				  JOIN roadmap_proposal.proposal p ON p.id = pl.proposal_id
				 WHERE p.project_id = $1`,
				[pid],
			),
			// 5. Liaison / agency health
			query<{ agency: string; status: string; in_flight: string; max_in_flight: string; last_seen_ago_m: string | null }>(
				`SELECT ar.agent_identity AS agency,
				        pr.status,
				        COALESCE(inf.in_flight_count,0)::text AS in_flight,
				        pr.max_in_flight::text,
				        ROUND(EXTRACT(EPOCH FROM (now() - pr.last_seen_at)) / 60, 1)::text AS last_seen_ago_m
				   FROM roadmap_workforce.provider_registry pr
				   JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
				   LEFT JOIN roadmap_workforce.v_agency_in_flight inf ON inf.provider_registry_id = pr.id
				  WHERE (pr.project_id IS NULL OR pr.project_id = $1::text)
				    AND pr.status NOT IN ('offline','retired')
				  ORDER BY pr.last_seen_at DESC NULLS LAST
				  LIMIT 10`,
				[pid],
			),
			// 6. Pending gate decisions (proposals in mature state awaiting gate)
			query<{ display_id: string; title: string; stage: string; maturity: string }>(
				`SELECT p.display_id, p.title, p.status AS stage, p.maturity
				   FROM roadmap_proposal.proposal p
				  WHERE p.project_id = $1
				    AND lower(p.maturity) = 'mature'
				    AND lower(p.status) NOT IN ('complete','closed')
				  ORDER BY p.modified_at ASC
				  LIMIT 8`,
				[pid],
			),
			// 7. Budget counters
			query<{ tracked: string; budget_cents: string; spent_cents: string; over_budget: string }>(
				`SELECT COUNT(*)::text AS tracked,
				        COALESCE(SUM(max_usd_cents),0)::text AS budget_cents,
				        COALESCE(SUM(current_spent_usd_cents),0)::text AS spent_cents,
				        COUNT(*) FILTER (WHERE current_spent_usd_cents > max_usd_cents)::text AS over_budget
				   FROM roadmap.principal_spending_cap
				  WHERE project_id IN ($1::text,'agenthive')`,
				[pid],
			),
		]);

	const lines: string[] = [];
	const now = new Date().toISOString();

	lines.push(`# Operational Snapshot`);
	lines.push(`generated_at: ${now}`);
	lines.push(`project: ${proj.name} (${proj.slug})`);
	lines.push(``);

	// Queue pools
	lines.push(`## Queue Pools`);
	if (queueRes.status === "fulfilled" && queueRes.value.rows.length > 0) {
		lines.push("```yaml");
		for (const row of queueRes.value.rows) {
			const hours = row.oldest_update_hours ? ` oldest_update_h: ${row.oldest_update_hours}` : "";
			lines.push(`  - stage: ${row.stage}  maturity: ${row.maturity}  count: ${row.cnt}${hours}`);
		}
		lines.push("```");
	} else {
		lines.push("_No queued work or unavailable._");
	}
	lines.push(``);

	// Pending gate
	lines.push(`## Pending Gate Decisions`);
	if (gateRes.status === "fulfilled" && gateRes.value.rows.length > 0) {
		lines.push("```yaml");
		for (const row of gateRes.value.rows) {
			lines.push(`  - ${row.display_id}: "${row.title}"  stage: ${row.stage}  maturity: ${row.maturity}`);
		}
		lines.push("```");
		lines.push(`> Use \`mcp_proposal action=submit_review\` to advance or hold these proposals.`);
	} else {
		lines.push("_No proposals pending gate decision._");
	}
	lines.push(``);

	// Top candidates
	lines.push(`## Top Develop Candidates`);
	if (candidateRes.status === "fulfilled" && candidateRes.value.rows.length > 0) {
		lines.push("```yaml");
		for (const row of candidateRes.value.rows) {
			const blocked = parseInt(row.dep_blockers, 10) > 0 ? `  dep_blockers: ${row.dep_blockers}` : "";
			lines.push(`  - ${row.display_id}: "${row.title}"  priority: ${row.priority}  maturity: ${row.maturity}${blocked}`);
		}
		lines.push("```");
		lines.push(`> Claim with \`mcp_proposal action=claim proposal_id=<ID>\` before starting work.`);
	} else {
		lines.push("_No active develop candidates._");
	}
	lines.push(``);

	// Active dispatches
	lines.push(`## Active Dispatches`);
	if (dispatchRes.status === "fulfilled" && dispatchRes.value.rows.length > 0) {
		lines.push("```yaml");
		for (const row of dispatchRes.value.rows) {
			const exp = row.expires_in_s !== null ? `  expires_in_s: ${row.expires_in_s}` : "";
			lines.push(`  - dispatch_id: ${row.id}  proposal: ${row.display_id ?? "?"}  role: ${row.role}  status: ${row.offer_status}  worker: ${row.worker ?? "unassigned"}${exp}`);
		}
		lines.push("```");
	} else {
		lines.push("_No active dispatches._");
	}
	lines.push(``);

	// Lease summary
	lines.push(`## Lease Status`);
	if (leaseRes.status === "fulfilled") {
		const r = leaseRes.value.rows[0];
		if (r) {
			const expiredCount = parseInt(r.expired_count, 10);
			lines.push(`- active leases: ${r.active_count}`);
			if (expiredCount > 0) {
				lines.push(`- **expired (not released): ${r.expired_count}** ← needs recovery`);
				lines.push(`> Use \`mcp_proposal action=release\` on stale leases to unblock work.`);
			} else {
				lines.push(`- expired (not released): 0`);
			}
		}
	} else {
		lines.push("_unavailable_");
	}
	lines.push(``);

	// Liaison health
	lines.push(`## Liaison / Agency Health`);
	if (liaisonRes.status === "fulfilled" && liaisonRes.value.rows.length > 0) {
		lines.push("```yaml");
		for (const row of liaisonRes.value.rows) {
			const seenAgo = row.last_seen_ago_m ? `  last_seen_ago_m: ${row.last_seen_ago_m}` : "";
			lines.push(`  - agency: ${row.agency}  status: ${row.status}  in_flight: ${row.in_flight}/${row.max_in_flight}${seenAgo}`);
		}
		lines.push("```");
	} else {
		lines.push("_No active liaisons or unavailable._");
	}
	lines.push(``);

	// Budget risk
	lines.push(`## Budget Risk`);
	if (budgetRes.status === "fulfilled") {
		const r = budgetRes.value.rows[0];
		if (r) {
			const overBudget = parseInt(r.over_budget, 10);
			const spentCents = parseInt(r.spent_cents, 10);
			const budgetCents = parseInt(r.budget_cents, 10);
			const pct = budgetCents > 0 ? Math.round((spentCents / budgetCents) * 100) : 0;
			lines.push(`- tracked_principals: ${r.tracked}`);
			lines.push(`- total_budget: $${(budgetCents / 100).toFixed(2)}`);
			lines.push(`- total_spent: $${(spentCents / 100).toFixed(2)} (${pct}%)`);
			if (overBudget > 0) {
				lines.push(`- **over_budget_principals: ${r.over_budget}** ← requires attention`);
			} else {
				lines.push(`- over_budget_principals: 0`);
			}
		} else {
			lines.push("_No budget caps configured._");
		}
	} else {
		lines.push("_unavailable_");
	}
	lines.push(``);

	// Next allowed actions
	lines.push(`## Next Allowed MCP Actions`);
	lines.push(`- Claim a proposal: \`mcp_proposal action=claim proposal_id=<ID> agent_identity=<you>\``);
	lines.push(`- Submit a gate review: \`mcp_proposal action=submit_review proposal_id=<ID> reviewer=<you> verdict=approve|hold|reject\``);
	lines.push(`- Release a stale lease: \`mcp_proposal action=release proposal_id=<ID> release_reason=<reason>\``);
	lines.push(`- View proposal detail: \`mcp_proposal action=detail proposal_id=<ID>\``);
	lines.push(`- List all proposals: \`mcp_proposal action=list\``);
	lines.push(`- Check SLA health: \`mcp_ops action=health_check\``);
	lines.push(`- Report usage: \`mcp_ops action=report_usage\``);

	return {
		content: [{ type: "text", text: lines.join("\n") }],
	};
}
