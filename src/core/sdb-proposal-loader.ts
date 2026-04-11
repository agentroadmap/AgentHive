/**
 * SpacetimeDB Proposal Loader
 *
 * Loads all proposals directly from SpacetimeDB via CLI (curl).
 * Used as a fast synchronous path for statistics and bulk operations.
 * Falls back gracefully when SDB is unavailable.
 */

import { execSync } from "node:child_process";
import type { Proposal } from "../types/index.ts";

const SDB_URI = process.env.SDB_URI ?? "http://127.0.0.1:3000";
const SDB_NAME = process.env.SDB_NAME ?? "roadmap2";

/** Minimal SDB proposal row shape */
interface SDBRow {
	id: bigint;
	display_id: string;
	parent_id: bigint | null;
	proposal_type: string;
	category: string;
	domain_id: string;
	title: string;
	status: string;
	priority: string;
	body_markdown: string | null;
	process_logic: string | null;
	maturity_level: number | null;
	repository_path: string | null;
	budget_limit_usd: number;
	tags: string | null;
	created_at: bigint;
	updated_at: bigint;
}

/**
 * Convert an SDB row to a CLI Proposal object.
 */
function rowToProposal(row: SDBRow): Proposal {
	const createdMs = Number(row.created_at) / 1000; // microseconds → ms
	const updatedMs = Number(row.updated_at) / 1000;

	return {
		id: row.display_id ?? `PROP-${row.id}`,
		title: row.title,
		status: row.status,
		createdDate: new Date(createdMs).toISOString().split("T")[0],
		updatedDate: new Date(updatedMs).toISOString().split("T")[0],
		description: row.body_markdown ?? "",
		labels: row.tags ? row.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
		priority: (row.priority ?? "medium").toLowerCase() as "high" | "medium" | "low",
		type: row.proposal_type?.toLowerCase(),
		category: row.category?.toLowerCase(),
		domain: row.domain_id,
		displayId: row.display_id,
		parentId: row.parent_id != null ? `PROP-${row.parent_id}` : undefined,
		body: row.body_markdown ?? undefined,
		budgetLimit: row.budget_limit_usd,
	} as unknown as Proposal;
}

/**
 * Load all proposals from SpacetimeDB for statistics display.
 *
 * Returns proposals split into active, drafts, and grouped by status.
 */
export function loadProposalsForStatistics(): {
	proposals: Proposal[];
	drafts: Proposal[];
	statuses: Map<string, Proposal[]>;
} {
	const all = loadAllProposals();
	const proposals: Proposal[] = [];
	const drafts: Proposal[] = [];
	const statuses = new Map<string, Proposal[]>();

	for (const p of all) {
		const status = p.status?.toLowerCase() ?? "";
		if (status === "potential" || status === "draft") {
			drafts.push(p);
		} else {
			proposals.push(p);
		}

		const key = status || "unknown";
		if (!statuses.has(key)) statuses.set(key, []);
		statuses.get(key)!.push(p);
	}

	return { proposals, drafts, statuses };
}

/**
 * Load all proposals from SpacetimeDB.
 *
 * Uses `spacetime sql` CLI for a synchronous, zero-dependency query.
 * Returns empty array if SDB is unreachable (caller should fall back to FS).
 */
export function loadAllProposals(): Proposal[] {
	try {
		const sql = `SELECT * FROM proposal`;
		const cmd = `spacetime sql --json ${SDB_NAME} "${sql}"`;
		const raw = execSync(cmd, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, SPACETIME_URI: SDB_URI },
		}).trim();

		if (!raw || raw === "[]") return [];

		const rows: SDBRow[] = JSON.parse(raw);
		return rows.map(rowToProposal);
	} catch {
		// SDB unavailable — caller will fall back to filesystem
		return [];
	}
}
