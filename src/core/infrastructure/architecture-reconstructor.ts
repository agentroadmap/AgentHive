/**
 * P405 — Architecture Reconstructor
 *
 * Builds live architectural views (capability tree, dependency DAG, gap analysis,
 * timeline) from the roadmap_proposal DB schema.  All data comes from the DB;
 * no filesystem proposal files are read.
 *
 * Set ARCH_RECONSTRUCTOR_DISABLED=true to bypass this module and fall back to
 * the legacy doc-generator.ts filesystem path.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CapabilityNode {
	displayId: string;
	title: string;
	workflowState: string;
	maturityLevel: number;
	children: CapabilityNode[];
}

export interface DependencyEdge {
	fromDisplayId: string;
	toDisplayId: string;
	type: "blocks" | "depended_by" | "supersedes" | "relates";
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
	transitionedBy: string;
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
) => Promise<{ rows: Record<string, unknown>[] }>;

// ─── Internal helpers ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
	DRAFT: "#ffffff",
	REVIEW: "#ff9800",
	DEVELOP: "#2196f3",
	MERGE: "#9c27b0",
	COMPLETE: "#00c853",
};

function sanitizeNodeId(displayId: string): string {
	return displayId.replace(/[^a-zA-Z0-9]/g, "_");
}

function statusColor(workflowState: string): string {
	return STATUS_COLORS[workflowState?.toUpperCase()] ?? "#cccccc";
}

// ─── Capability tree ──────────────────────────────────────────────────────────

interface ProposalRow {
	id: string;
	display_id: string;
	title: string;
	status: string;
	maturity_level: number;
	parent_id: string | null;
}

export async function queryCapabilityTree(opts?: {
	queryFn?: QueryFn;
}): Promise<CapabilityNode[]> {
	const qfn = opts?.queryFn ?? defaultQuery;
	const { rows } = await qfn(
		`SELECT id::text, display_id, title, status, maturity_level, parent_id::text
		 FROM roadmap_proposal.proposal
		 ORDER BY parent_id NULLS FIRST, display_id`,
	);

	const allRows = rows as ProposalRow[];
	const byId = new Map(allRows.map((r) => [r.id, r]));
	const nodeMap = new Map<string, CapabilityNode>();

	for (const row of allRows) {
		nodeMap.set(row.id, {
			displayId: row.display_id,
			title: row.title,
			workflowState: row.status,
			maturityLevel: Number(row.maturity_level),
			children: [],
		});
	}

	const roots: CapabilityNode[] = [];
	for (const row of allRows) {
		const node = nodeMap.get(row.id)!;
		if (row.parent_id && byId.has(row.parent_id)) {
			nodeMap.get(row.parent_id)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

// ─── Dependency DAG ───────────────────────────────────────────────────────────

interface DepRow {
	from_display: string;
	from_title: string;
	to_display: string;
	to_title: string;
	dependency_type: string;
	resolved: boolean;
	from_status: string;
	to_status: string;
}

export async function queryDependencyDAG(opts?: {
	queryFn?: QueryFn;
}): Promise<{ edges: DependencyEdge[]; mermaid: string }> {
	const qfn = opts?.queryFn ?? defaultQuery;
	const { rows } = await qfn(
		`SELECT d.dependency_type, d.resolved,
		        p1.display_id AS from_display, p1.title AS from_title, p1.status AS from_status,
		        p2.display_id AS to_display,   p2.title AS to_title,   p2.status AS to_status
		 FROM roadmap_proposal.proposal_dependencies d
		 JOIN roadmap_proposal.proposal p1 ON p1.id = d.from_proposal_id
		 JOIN roadmap_proposal.proposal p2 ON p2.id = d.to_proposal_id
		 ORDER BY p1.display_id, p2.display_id`,
	);

	const depRows = rows as DepRow[];
	const edges: DependencyEdge[] = depRows.map((r) => ({
		fromDisplayId: r.from_display,
		toDisplayId: r.to_display,
		type: r.dependency_type as DependencyEdge["type"],
		resolved: Boolean(r.resolved),
	}));

	const nodeStyles = new Map<string, string>();
	const edgeLines: string[] = [];

	for (const r of depRows) {
		const fromId = sanitizeNodeId(r.from_display);
		const toId = sanitizeNodeId(r.to_display);
		const fromLabel = `${r.from_display} - ${r.from_title}`.replace(/"/g, "'");
		const toLabel = `${r.to_display} - ${r.to_title}`.replace(/"/g, "'");
		const arrow = r.resolved ? "-.->|" : "-->|";
		edgeLines.push(
			`  ${fromId}["${fromLabel}"] ${arrow}${r.dependency_type}| ${toId}["${toLabel}"]`,
		);
		nodeStyles.set(fromId, statusColor(r.from_status));
		nodeStyles.set(toId, statusColor(r.to_status));
	}

	const styleLines = [...nodeStyles.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, color]) => `  style ${id} fill:${color}`);

	const mermaid =
		edgeLines.length === 0
			? "graph TD\n  _empty[\"No dependencies recorded\"]"
			: ["graph TD", ...edgeLines, ...styleLines].join("\n");

	return { edges, mermaid };
}

// ─── Gap analysis ─────────────────────────────────────────────────────────────

interface GapRow {
	display_id: string;
	title: string;
	gap_type: string;
	detail: string;
}

export async function queryGapAnalysis(opts?: {
	queryFn?: QueryFn;
}): Promise<GapItem[]> {
	const qfn = opts?.queryFn ?? defaultQuery;
	const { rows } = await qfn(
		`-- Failing / pending ACs on DRAFT or REVIEW proposals
		 SELECT p.display_id, p.title, 'failing_ac'::text AS gap_type,
		        ac.criterion_text AS detail
		 FROM roadmap_proposal.proposal p
		 JOIN roadmap_proposal.proposal_acceptance_criteria ac ON ac.proposal_id = p.id
		 WHERE p.status IN ('DRAFT', 'REVIEW')
		   AND ac.status != 'pass'
		 UNION ALL
		 -- Unresolved blocking dependencies on DRAFT or REVIEW proposals
		 SELECT p.display_id, p.title, 'unresolved_dep'::text AS gap_type,
		        p2.display_id || ' (' || d.dependency_type || ')' AS detail
		 FROM roadmap_proposal.proposal p
		 JOIN roadmap_proposal.proposal_dependencies d ON d.from_proposal_id = p.id
		 JOIN roadmap_proposal.proposal p2 ON p2.id = d.to_proposal_id
		 WHERE p.status IN ('DRAFT', 'REVIEW')
		   AND d.resolved = false
		 UNION ALL
		 -- Proposals with no ACs defined
		 SELECT p.display_id, p.title, 'no_acs'::text AS gap_type,
		        'No acceptance criteria defined'::text AS detail
		 FROM roadmap_proposal.proposal p
		 WHERE p.status IN ('DRAFT', 'REVIEW')
		   AND NOT EXISTS (
		     SELECT 1 FROM roadmap_proposal.proposal_acceptance_criteria ac
		     WHERE ac.proposal_id = p.id
		   )
		 ORDER BY display_id, gap_type, detail`,
	);

	return (rows as GapRow[]).map((r) => ({
		displayId: r.display_id,
		title: r.title,
		gapType: r.gap_type as GapItem["gapType"],
		detail: r.detail,
	}));
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

interface TimelineRow {
	display_id: string;
	title: string;
	from_state: string;
	to_state: string;
	transitioned_at: string;
	transitioned_by: string;
}

export async function queryTimeline(opts?: {
	queryFn?: QueryFn;
}): Promise<TimelineEntry[]> {
	const qfn = opts?.queryFn ?? defaultQuery;
	const { rows } = await qfn(
		`SELECT p.display_id, p.title,
		        pt.from_state, pt.to_state,
		        pt.transitioned_at, pt.transitioned_by
		 FROM roadmap_proposal.proposal_state_transitions pt
		 JOIN roadmap_proposal.proposal p ON p.id = pt.proposal_id
		 ORDER BY pt.transitioned_at DESC
		 LIMIT 100`,
	);

	return (rows as TimelineRow[]).map((r) => ({
		displayId: r.display_id,
		title: r.title,
		fromState: r.from_state,
		toState: r.to_state,
		transitionedAt: new Date(r.transitioned_at),
		transitionedBy: r.transitioned_by,
	}));
}

// ─── Stale detection ──────────────────────────────────────────────────────────

export async function checkStale(
	views: ArchitectureViews,
	opts?: { queryFn?: QueryFn },
): Promise<{ staleSince?: Date }> {
	const qfn = opts?.queryFn ?? defaultQuery;
	const { rows } = await qfn(
		`SELECT GREATEST(
		   (SELECT MAX(updated_at) FROM roadmap_proposal.proposal),
		   (SELECT MAX(updated_at) FROM roadmap_proposal.proposal_dependencies),
		   (SELECT MAX(transitioned_at) FROM roadmap_proposal.proposal_state_transitions)
		 ) AS latest_change`,
	);

	const latestChange = rows[0]?.latest_change as string | null | undefined;
	if (!latestChange) return {};
	const latestDate = new Date(latestChange);
	if (latestDate > views.generatedAt) return { staleSince: latestDate };
	return {};
}

// ─── Ephemeral output ─────────────────────────────────────────────────────────

const ARCH_DOCS_TTL_MS = 24 * 60 * 60 * 1000;

function cleanOldArchDirs(tmpBase: string): void {
	try {
		const entries = readdirSync(tmpBase);
		const cutoff = Date.now() - ARCH_DOCS_TTL_MS;
		for (const entry of entries) {
			if (!entry.startsWith("arch-docs-")) continue;
			const full = join(tmpBase, entry);
			try {
				const st = statSync(full);
				if (st.mtimeMs < cutoff) {
					rmSync(full, { recursive: true, force: true });
				}
			} catch {
				// ignore individual entry errors
			}
		}
	} catch {
		// tmp/ may not exist yet
	}
}

function findLatestArchDocsDir(tmpBase: string): string | null {
	try {
		const entries = readdirSync(tmpBase)
			.filter((e) => e.startsWith("arch-docs-"))
			.sort()
			.reverse();
		return entries[0] ? join(tmpBase, entries[0]) : null;
	} catch {
		return null;
	}
}

export function getLatestArchDocs(
	projectRoot?: string,
): ArchitectureViews | null {
	const tmpBase = join(projectRoot ?? process.cwd(), "tmp");
	const dir = findLatestArchDocsDir(tmpBase);
	if (!dir) return null;
	try {
		const raw = readFileSync(join(dir, "index.json"), "utf-8");
		const parsed = JSON.parse(raw) as ArchitectureViews & {
			generatedAt: string;
			timeline?: Array<TimelineEntry & { transitionedAt: string }>;
		};
		parsed.generatedAt = new Date(parsed.generatedAt);
		if (parsed.timeline) {
			parsed.timeline = parsed.timeline.map((e) => ({
				...e,
				transitionedAt: new Date(e.transitionedAt),
			}));
		}
		return parsed as ArchitectureViews;
	} catch {
		return null;
	}
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function generateArchitectureDocs(opts?: {
	queryFn?: QueryFn;
	projectRoot?: string;
}): Promise<ArchitectureViews> {
	const qfnOpts = opts?.queryFn ? { queryFn: opts.queryFn } : undefined;
	const tmpBase = join(opts?.projectRoot ?? process.cwd(), "tmp");

	cleanOldArchDirs(tmpBase);

	const [capabilityTree, dependencyDAG, gapAnalysis, timeline] =
		await Promise.all([
			queryCapabilityTree(qfnOpts),
			queryDependencyDAG(qfnOpts),
			queryGapAnalysis(qfnOpts),
			queryTimeline(qfnOpts),
		]);

	const views: ArchitectureViews = {
		capabilityTree,
		dependencyDAG,
		gapAnalysis,
		timeline,
		generatedAt: new Date(),
	};

	const outDir = join(tmpBase, `arch-docs-${views.generatedAt.getTime()}`);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "index.json"), JSON.stringify(views, null, 2));
	writeFileSync(join(outDir, "dependency-dag.md"), `\`\`\`mermaid\n${dependencyDAG.mermaid}\n\`\`\``);
	writeFileSync(join(outDir, "gap-analysis.json"), JSON.stringify(gapAnalysis, null, 2));
	writeFileSync(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 2));

	return views;
}
