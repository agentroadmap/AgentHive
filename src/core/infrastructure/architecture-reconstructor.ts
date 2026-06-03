/**
 * P405: Architecture Reconstructor
 *
 * Queries roadmap_proposal DB tables to produce live architectural views.
 * No filesystem reads — all data comes from the DB.
 *
 * Env: ARCH_RECONSTRUCTOR_DISABLED=true bypasses this module (AC-32).
 */

import {
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { QueryResult } from "pg";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CapabilityNode {
	displayId: string;
	title: string;
	workflowState: string;
	maturity: string;
	parentId: string | null;
	tags: unknown;
	children: CapabilityNode[];
}

export interface DependencyEdge {
	fromDisplayId: string;
	toDisplayId: string;
	type: "blocks" | "depended_by" | "supersedes" | "relates" | "derived_from";
	resolved: boolean;
}

export interface GapItem {
	displayId: string;
	title: string;
	gapType: "failing_ac" | "unresolved_dep" | "no_acs";
	detail: string;
}

export interface TimelineEntry {
	displayId: string;
	title: string;
	fromState: string;
	toState: string;
	transitionedAt: Date;
	transitionedBy: string | null;
}

export interface ArchitectureViews {
	capabilityTree: CapabilityNode[];
	dependencyDAG: { edges: DependencyEdge[]; mermaid: string };
	gapAnalysis: GapItem[];
	timeline: TimelineEntry[];
	generatedAt: Date;
}

export type QueryFn = (
	text: string,
	params?: unknown[],
) => Promise<{ rows: unknown[] }>;

// ─── Status → Mermaid fill colour ─────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
	DRAFT: "#ffffff",
	REVIEW: "#ff9800",
	DEVELOP: "#2196f3",
	MERGE: "#9c27b0",
	COMPLETE: "#00c853",
};

function statusColor(raw: string): string {
	return STATUS_COLORS[raw.toUpperCase()] ?? "#e0e0e0";
}

function sanitizeId(displayId: string): string {
	return displayId.replace(/[^A-Za-z0-9_]/g, "_");
}

// ─── Capability tree ──────────────────────────────────────────────────────────

interface ProposalRow {
	id: string;
	display_id: string;
	parent_id: string | null;
	title: string;
	status: string;
	maturity: string;
	tags: unknown;
}

export async function queryCapabilityTree(
	queryFn: QueryFn = defaultQuery,
): Promise<CapabilityNode[]> {
	const result = await queryFn(`
		SELECT id, display_id, parent_id::text, title, status, maturity, tags
		FROM roadmap_proposal.proposal
		ORDER BY parent_id NULLS FIRST, display_id
	`);

	const rows = result.rows as ProposalRow[];
	const byId = new Map<string, CapabilityNode>();
	const roots: CapabilityNode[] = [];

	for (const row of rows) {
		const node: CapabilityNode = {
			displayId: row.display_id,
			title: row.title,
			workflowState: row.status,
			maturity: row.maturity,
			parentId: row.parent_id ?? null,
			tags: row.tags,
			children: [],
		};
		byId.set(row.id, node);
	}

	for (const row of rows) {
		const node = byId.get(row.id)!;
		if (row.parent_id === null) {
			roots.push(node);
		} else {
			const parent = byId.get(row.parent_id);
			if (parent) {
				parent.children.push(node);
			} else {
				roots.push(node);
			}
		}
	}

	return roots;
}

// ─── Dependency DAG ───────────────────────────────────────────────────────────

interface DepRow {
	from_display: string;
	to_display: string;
	dependency_type: string;
	resolved: boolean;
	from_status: string;
	to_status: string;
}

function buildMermaid(edges: DependencyEdge[], statusMap: Map<string, string>): string {
	if (edges.length === 0) return "graph TD\n";

	const lines: string[] = ["graph TD"];

	for (const edge of edges) {
		const fromId = sanitizeId(edge.fromDisplayId);
		const toId = sanitizeId(edge.toDisplayId);
		const fromLabel = `${edge.fromDisplayId}`;
		const toLabel = `${edge.toDisplayId}`;
		const arrowLabel = edge.resolved ? `|resolved ${edge.type}|` : `|${edge.type}|`;
		lines.push(`  ${fromId}["${fromLabel}"] -->${arrowLabel} ${toId}["${toLabel}"]`);
	}

	// Style nodes
	const seen = new Set<string>();
	for (const edge of edges) {
		for (const [dispId] of [
			[edge.fromDisplayId, statusMap.get(edge.fromDisplayId) ?? ""],
			[edge.toDisplayId, statusMap.get(edge.toDisplayId) ?? ""],
		]) {
			if (!seen.has(dispId)) {
				seen.add(dispId);
				const color = statusColor(statusMap.get(dispId) ?? "");
				lines.push(`  style ${sanitizeId(dispId)} fill:${color}`);
			}
		}
	}

	return lines.join("\n") + "\n";
}

export async function queryDependencyDAG(
	queryFn: QueryFn = defaultQuery,
): Promise<{ edges: DependencyEdge[]; mermaid: string }> {
	const result = await queryFn(`
		SELECT d.dependency_type, d.resolved,
		       p1.display_id AS from_display, p1.status AS from_status,
		       p2.display_id AS to_display, p2.status AS to_status
		FROM roadmap_proposal.proposal_dependencies d
		JOIN roadmap_proposal.proposal p1 ON p1.id = d.from_proposal_id
		JOIN roadmap_proposal.proposal p2 ON p2.id = d.to_proposal_id
		ORDER BY p1.display_id, p2.display_id
	`);

	const rows = result.rows as DepRow[];
	const edges: DependencyEdge[] = rows.map((r) => ({
		fromDisplayId: r.from_display,
		toDisplayId: r.to_display,
		type: r.dependency_type as DependencyEdge["type"],
		resolved: r.resolved,
	}));

	const statusMap = new Map<string, string>();
	for (const r of rows) {
		statusMap.set(r.from_display, r.from_status);
		statusMap.set(r.to_display, r.to_status);
	}

	return { edges, mermaid: buildMermaid(edges, statusMap) };
}

// ─── Gap analysis ─────────────────────────────────────────────────────────────

interface GapRow {
	display_id: string;
	title: string;
	gap_type: string;
	detail: string;
}

export async function queryGapAnalysis(
	queryFn: QueryFn = defaultQuery,
): Promise<GapItem[]> {
	const result = await queryFn(`
		SELECT p.display_id, p.title, 'failing_ac' AS gap_type,
		       ac.criterion_text AS detail
		FROM roadmap_proposal.proposal p
		JOIN roadmap_proposal.proposal_acceptance_criteria ac ON ac.proposal_id = p.id
		WHERE UPPER(p.status) IN ('DRAFT', 'REVIEW')
		  AND ac.status NOT IN ('pass', 'waived')
		UNION ALL
		SELECT p.display_id, p.title, 'unresolved_dep' AS gap_type,
		       p2.display_id || ' (' || d.dependency_type || ')' AS detail
		FROM roadmap_proposal.proposal p
		JOIN roadmap_proposal.proposal_dependencies d ON d.from_proposal_id = p.id
		JOIN roadmap_proposal.proposal p2 ON p2.id = d.to_proposal_id
		WHERE UPPER(p.status) IN ('DRAFT', 'REVIEW')
		  AND d.resolved = false
		UNION ALL
		SELECT p.display_id, p.title, 'no_acs' AS gap_type,
		       'no acceptance criteria defined' AS detail
		FROM roadmap_proposal.proposal p
		WHERE UPPER(p.status) IN ('DRAFT', 'REVIEW')
		  AND NOT EXISTS (
		      SELECT 1 FROM roadmap_proposal.proposal_acceptance_criteria ac2
		      WHERE ac2.proposal_id = p.id
		  )
		ORDER BY display_id, gap_type, detail
	`);

	return (result.rows as GapRow[]).map((r) => ({
		displayId: r.display_id,
		title: r.title,
		gapType: r.gap_type as GapItem["gapType"],
		detail: r.detail,
	}));
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

interface TransitionRow {
	display_id: string;
	title: string;
	from_state: string;
	to_state: string;
	transitioned_at: string;
	transitioned_by: string | null;
}

export async function queryTimeline(
	queryFn: QueryFn = defaultQuery,
	limit = 100,
): Promise<TimelineEntry[]> {
	const result = await queryFn(`
		SELECT p.display_id, p.title,
		       pt.from_state, pt.to_state,
		       pt.transitioned_at, pt.transitioned_by
		FROM roadmap_proposal.proposal_state_transitions pt
		JOIN roadmap_proposal.proposal p ON p.id = pt.proposal_id
		ORDER BY pt.transitioned_at DESC
		LIMIT $1
	`, [limit]);

	return (result.rows as TransitionRow[]).map((r) => ({
		displayId: r.display_id,
		title: r.title,
		fromState: r.from_state,
		toState: r.to_state,
		transitionedAt: new Date(r.transitioned_at),
		transitionedBy: r.transitioned_by,
	}));
}

// ─── Staleness check ──────────────────────────────────────────────────────────

export async function checkStale(
	views: ArchitectureViews,
	queryFn: QueryFn = defaultQuery,
): Promise<{ staleSince?: Date }> {
	const result = await queryFn(`
		SELECT GREATEST(
		  (SELECT MAX(modified_at) FROM roadmap_proposal.proposal),
		  (SELECT MAX(updated_at)  FROM roadmap_proposal.proposal_dependencies),
		  (SELECT MAX(transitioned_at) FROM roadmap_proposal.proposal_state_transitions)
		) AS latest_change
	`);

	const row = result.rows[0] as { latest_change: string | null };
	if (!row?.latest_change) return {};

	const latestChange = new Date(row.latest_change);
	if (latestChange > views.generatedAt) {
		return { staleSince: latestChange };
	}
	return {};
}

// ─── Full generation ──────────────────────────────────────────────────────────

export async function generateArchitectureDocs(
	outDir?: string,
	queryFn: QueryFn = defaultQuery,
): Promise<ArchitectureViews> {
	const [capabilityTree, dependencyDAG, gapAnalysis, timeline] =
		await Promise.all([
			queryCapabilityTree(queryFn),
			queryDependencyDAG(queryFn),
			queryGapAnalysis(queryFn),
			queryTimeline(queryFn),
		]);

	const generatedAt = new Date();
	const views: ArchitectureViews = {
		capabilityTree,
		dependencyDAG,
		gapAnalysis,
		timeline,
		generatedAt,
	};

	if (outDir) {
		// Purge dirs older than 24h
		const parentDir = join(outDir, "..");
		try {
			const entries = readdirSync(parentDir);
			const cutoff = Date.now() - 24 * 60 * 60 * 1000;
			for (const entry of entries) {
				if (!entry.startsWith("arch-docs-")) continue;
				const dirPath = join(parentDir, entry);
				try {
					const ts = Number(entry.replace("arch-docs-", ""));
					if (!Number.isNaN(ts) && ts < cutoff) {
						rmSync(dirPath, { recursive: true, force: true });
					}
				} catch {
					// non-fatal
				}
			}
		} catch {
			// parentDir may not exist yet
		}

		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			join(outDir, "arch-views.json"),
			JSON.stringify({ ...views, generatedAt: generatedAt.toISOString() }, null, 2),
		);
		writeFileSync(
			join(outDir, "dependency-dag.mmd"),
			views.dependencyDAG.mermaid,
		);
		writeFileSync(
			join(outDir, "gap-analysis.json"),
			JSON.stringify(views.gapAnalysis, null, 2),
		);
	}

	return views;
}
