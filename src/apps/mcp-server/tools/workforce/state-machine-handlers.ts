import { query } from "../../../../infra/postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";
import { execSync } from "child_process";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function run(cmd: string): string {
	try {
		return execSync(cmd, { encoding: "utf8", timeout: 10_000 }).trim();
	} catch (e: any) {
		return e.stderr?.toString()?.trim() || e.message || "error";
	}
}

function serviceStatus(name: string): string {
	return run(`systemctl is-active ${name} 2>/dev/null`) || "unknown";
}

export const stateMachineStartHandler: ToolHandler = async () => {
	const results: string[] = [];
	for (const svc of ["agenthive-orchestrator"]) {
		const before = serviceStatus(svc);
		if (before === "active") {
			results.push(`${svc}: already running`);
		} else {
			run(`sudo systemctl start ${svc}`);
			const after = serviceStatus(svc);
			results.push(`${svc}: ${before} → ${after}`);
		}
	}
	return { content: [{ type: "text" as const, text: results.join("\n") }] };
};

export const stateMachineStopHandler: ToolHandler = async () => {
	const results: string[] = [];
	for (const svc of ["agenthive-orchestrator"]) {
		run(`sudo systemctl stop ${svc}`);
		results.push(`${svc}: ${serviceStatus(svc)}`);
	}
	return { content: [{ type: "text" as const, text: results.join("\n") }] };
};

export const stateMachineStatusHandler: ToolHandler = async () => {
	const lines: string[] = [];

	// Services
	lines.push("Services:");
	for (const svc of ["agenthive-orchestrator"]) {
		const status = serviceStatus(svc);
		lines.push(`  ${status === "active" ? "✓" : "✗"} ${svc}: ${status}`);
	}

	// Agencies
	lines.push("\nAgencies:");
	const agencies = await query(
		`SELECT ar.agent_identity, ar.status,
				COALESCE(string_agg(ac.capability, ', ' ORDER BY ac.capability), 'none') as caps
		 FROM roadmap_workforce.agent_registry ar
		 LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
		 GROUP BY ar.id, ar.agent_identity, ar.status
		 ORDER BY ar.agent_identity`,
	);
	for (const r of agencies.rows) {
		lines.push(`  ${r.agent_identity} (${r.status}) — ${r.caps}`);
	}

	// Offers
	lines.push("\nOffers:");
	const offers = await query(
		`SELECT offer_status, count(*) as cnt
		 FROM roadmap_workforce.squad_dispatch
		 GROUP BY offer_status ORDER BY offer_status`,
	);
	for (const r of offers.rows) {
		lines.push(`  ${r.offer_status}: ${r.cnt}`);
	}

	// Active dispatches
	lines.push("\nActive dispatches:");
	const dispatches = await query(
		`SELECT id, dispatch_role, offer_status,
				COALESCE(agent_identity, '-') as agency,
				COALESCE(worker_identity, '-') as worker
		 FROM roadmap_workforce.squad_dispatch
		 WHERE offer_status IN ('open','claimed','active')
		 ORDER BY id DESC LIMIT 10`,
	);
	if (dispatches.rows.length === 0) {
		lines.push("  (none)");
	} else {
		for (const r of dispatches.rows) {
			lines.push(`  #${r.id}: ${r.dispatch_role} @ ${r.worker} (${r.offer_status})`);
		}
	}

	return { content: [{ type: "text" as const, text: lines.join("\n") }] };
};

export const agenciesListHandler: ToolHandler = async () => {
	const result = await query(
		`SELECT ar.agent_identity, ar.agent_type, ar.status,
				COALESCE(string_agg(ac.capability, ', ' ORDER BY ac.capability), 'none') as capabilities
		 FROM roadmap_workforce.agent_registry ar
		 LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
		 GROUP BY ar.id, ar.agent_identity, ar.agent_type, ar.status
		 ORDER BY ar.agent_identity`,
	);
	const lines = result.rows.map(
		(r: any) => `${r.agent_identity} (${r.agent_type}, ${r.status}) — ${r.capabilities}`,
	);
	return {
		content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "No agencies registered." }],
	};
};

export const offersListHandler: ToolHandler = async (args) => {
	const { status } = args as { status?: string };
	let sql = `SELECT id, proposal_id, dispatch_role, offer_status,
	                   COALESCE(agent_identity, '-') as agency,
	                   COALESCE(worker_identity, '-') as worker,
	                   required_capabilities
	            FROM roadmap_workforce.squad_dispatch`;
	const params: unknown[] = [];
	if (status) {
		sql += ` WHERE offer_status = $1`;
		params.push(status);
	}
	sql += ` ORDER BY id DESC LIMIT 20`;
	const result = await query(sql, params);
	const lines = result.rows.map(
		(r: any) => `#${r.id}: P${r.proposal_id} ${r.dispatch_role} — ${r.offer_status} (agency=${r.agency}, worker=${r.worker})`,
	);
	return {
		content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "No offers found." }],
	};
};
