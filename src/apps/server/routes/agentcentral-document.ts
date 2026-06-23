/**
 * routes/agentcentral-document.ts — read-only "AgentCentral Document" API.
 *
 * Serves the agentHive3 tenant proposal tree (the AGC-* product spec) as a
 * single document payload for the dashboard-web AgentCentralDocumentPage.
 *
 * agentHive3 is a clean-sheet V3.1 tenant DB that is NOT (yet) registered in
 * the legacy `roadmap.project` registry, so getProjectDb()/getControlPool()
 * cannot resolve it. We therefore use a small, self-contained, lazily-created
 * pg pool dedicated to this endpoint. Connection is fully overridable via env:
 *
 *   AGENTHIVE3_DSN          full connection string (wins if set)
 *   AGENTHIVE3_DB           database name        (default "agentHive3")
 *   AGENTHIVE3_PGPORT       port                 (default PGPORT_DIRECT ?? 5432)
 *   PGHOST / PGUSER / PGPASSWORD  inherited for host + credentials
 *
 * The endpoint is read-only (SELECT only) and returns a flat node list with
 * acceptance criteria and dependency edges embedded; the client builds the
 * tree + table-of-contents and natural-sorts display ids.
 */
import { Pool } from "pg";

let pool: Pool | null = null;

function getAgentHive3Pool(): Pool {
	if (pool) return pool;
	const dsn = process.env.AGENTHIVE3_DSN;
	pool = dsn
		? new Pool({ connectionString: dsn, max: 4, statement_timeout: 15_000 })
		: new Pool({
				host: process.env.PGHOST ?? "127.0.0.1",
				port: Number(
					process.env.AGENTHIVE3_PGPORT ?? process.env.PGPORT_DIRECT ?? 5432,
				),
				user: process.env.PGUSER ?? "admin",
				password: process.env.PGPASSWORD,
				database: process.env.AGENTHIVE3_DB ?? "agentHive3",
				max: 4,
				statement_timeout: 15_000,
				idleTimeoutMillis: 60_000,
			});
	// Never let an idle-client error crash the process — just drop the pool so
	// the next request rebuilds it.
	pool.on("error", () => {
		pool = null;
	});
	return pool;
}

export interface AgcDocAcceptanceCriterion {
	item_number: number;
	criterion_text: string;
	status: string;
}

export interface AgcDocEdge {
	display_id: string;
	title: string;
	edge_type: string;
}

export interface AgcDocNode {
	id: number;
	display_id: string;
	parent_id: number | null;
	type: string;
	status: string;
	maturity: string;
	priority: number;
	title: string;
	summary: string | null;
	motivation: string | null;
	design: string | null;
	drawbacks: string | null;
	alternatives: string | null;
	tags: string[];
	acceptance_criteria: AgcDocAcceptanceCriterion[];
	deps_out: AgcDocEdge[]; // this node is the prerequisite (blocks → dependents)
	deps_in: AgcDocEdge[]; // this node depends on / relates to these
}

export interface AgcDocPayload {
	tenant: string;
	generated_at: string;
	total: number;
	nodes: AgcDocNode[];
}

/**
 * GET /api/agentcentral/document
 * Returns the agentHive3 proposal tree as a flat, fully-hydrated node list.
 */
export async function handleAgentCentralDocument(): Promise<Response> {
	let client: import("pg").PoolClient | undefined;
	try {
		client = await getAgentHive3Pool().connect();

		const tenantRes = await client.query<{ v: string }>(
			"SELECT v FROM meta.tenant_info WHERE k = 'slug' LIMIT 1",
		);
		const tenant = tenantRes.rows[0]?.v ?? "agentHive3";

		const propsRes = await client.query(`
			SELECT id, display_id, parent_id, type, status, maturity, priority,
			       title, summary, motivation, design, drawbacks, alternatives, tags
			FROM proposal.proposal
			ORDER BY id
		`);

		const acRes = await client.query(`
			SELECT proposal_id, item_number, criterion_text, status
			FROM proposal.proposal_acceptance_criteria
			ORDER BY proposal_id, item_number
		`);

		const depRes = await client.query(`
			SELECT d.from_proposal_id, d.to_proposal_id, d.edge_type,
			       f.display_id AS from_display_id, f.title AS from_title,
			       t.display_id AS to_display_id,   t.title AS to_title
			FROM proposal.proposal_dependency d
			JOIN proposal.proposal f ON f.id = d.from_proposal_id
			JOIN proposal.proposal t ON t.id = d.to_proposal_id
		`);

		const acById = new Map<number, AgcDocAcceptanceCriterion[]>();
		for (const r of acRes.rows) {
			const list = acById.get(r.proposal_id) ?? [];
			list.push({
				item_number: r.item_number,
				criterion_text: r.criterion_text,
				status: r.status,
			});
			acById.set(r.proposal_id, list);
		}

		const outById = new Map<number, AgcDocEdge[]>();
		const inById = new Map<number, AgcDocEdge[]>();
		for (const r of depRes.rows) {
			const out = outById.get(r.from_proposal_id) ?? [];
			out.push({
				display_id: r.to_display_id,
				title: r.to_title,
				edge_type: r.edge_type,
			});
			outById.set(r.from_proposal_id, out);

			const inc = inById.get(r.to_proposal_id) ?? [];
			inc.push({
				display_id: r.from_display_id,
				title: r.from_title,
				edge_type: r.edge_type,
			});
			inById.set(r.to_proposal_id, inc);
		}

		const nodes: AgcDocNode[] = propsRes.rows.map((p) => ({
			id: p.id,
			display_id: p.display_id,
			parent_id: p.parent_id,
			type: p.type,
			status: p.status,
			maturity: p.maturity,
			priority: p.priority,
			title: p.title,
			summary: p.summary,
			motivation: p.motivation,
			design: p.design,
			drawbacks: p.drawbacks,
			alternatives: p.alternatives,
			tags: Array.isArray(p.tags) ? p.tags : [],
			acceptance_criteria: acById.get(p.id) ?? [],
			deps_out: outById.get(p.id) ?? [],
			deps_in: inById.get(p.id) ?? [],
		}));

		const payload: AgcDocPayload = {
			tenant,
			generated_at: new Date().toISOString(),
			total: nodes.length,
			nodes,
		};
		return Response.json(payload);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json(
			{
				error: "Failed to load AgentCentral document",
				detail: message,
				hint: "agentHive3 must be reachable; override with AGENTHIVE3_DSN if needed.",
			},
			{ status: 503 },
		);
	} finally {
		client?.release();
	}
}
