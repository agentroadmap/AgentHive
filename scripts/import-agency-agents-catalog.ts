#!/usr/bin/env node
/**
 * P1358: One-time (idempotent) import of the msitarzewski/agency-agents catalog.
 *
 * Reads all agent definition .md files from a local clone of the agency-agents
 * repository and upserts them as inactive agent_registry rows with capability
 * seeds, enriching the orchestrator's matching catalog.
 *
 * Usage:
 *   npx tsx scripts/import-agency-agents-catalog.ts [--local-path <dir>] [--dry-run]
 *
 * Pre-flight gates:
 *   - personality + display_metadata columns must exist (P1356)
 *   - agent_type='agency' must be accepted by the DB CHECK constraint
 *
 * Exit codes:
 *   0  success (or dry-run complete)
 *   1  pre-flight check failed (missing columns / bad source path)
 *   2  partial failure (some rows errored; summary printed)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { closePool, query as pgQuery } from "../src/infra/postgres/pool.ts";

// ── Division → ExpertiseRole(s) mapping ─────────────────────────────────────

const DIVISION_ROLES: Record<string, string[]> = {
	engineering: ["architect", "coder", "reviewer"],
	design: ["designer"],
	testing: ["tester"],
	support: ["writer"],
	marketing: ["researcher", "writer"],
	"paid-media": ["researcher", "writer"],
	strategy: ["researcher", "writer"],
	sales: ["researcher"],
	product: ["researcher"],
	"project-management": ["researcher"],
	"game-development": ["designer", "coder"],
	"spatial-computing": ["designer"],
	academic: ["researcher"],
	specialized: [], // heuristic applied per agent name
};

const IMPORTABLE_DIVISIONS = Object.keys(DIVISION_ROLES);

// ── Slug helper ──────────────────────────────────────────────────────────────

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// ── Specialized heuristic ────────────────────────────────────────────────────

function specializedRoles(name: string): string[] {
	const n = name.toLowerCase();
	if (/architect/.test(n)) return ["architect"];
	if (/engineer|developer|coder|scripter/.test(n)) return ["coder"];
	if (/reviewer|auditor/.test(n)) return ["reviewer"];
	if (/designer|artist/.test(n)) return ["designer"];
	if (/writer|journalist|editor/.test(n)) return ["writer"];
	if (/tester|qa/.test(n)) return ["tester"];
	return ["researcher"];
}

// ── Frontmatter parser ───────────────────────────────────────────────────────

interface Frontmatter {
	name: string;
	description: string;
	color: string;
	emoji: string;
	vibe: string;
}

function parseFrontmatter(content: string): Frontmatter | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	const block = match[1]!;

	const get = (key: string): string => {
		const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		if (!m) return "";
		return m[1]!.trim().replace(/^["']|["']$/g, "");
	};

	return {
		name: get("name"),
		description: get("description"),
		color: get("color"),
		emoji: get("emoji"),
		vibe: get("vibe"),
	};
}

// ── Markdown section parser ──────────────────────────────────────────────────

function extractH3sUnderH2(content: string, h2Pattern: RegExp): string[] {
	const lines = content.split(/\r?\n/);
	let inside = false;
	const results: string[] = [];

	for (const line of lines) {
		if (/^##\s/.test(line)) {
			inside = h2Pattern.test(line);
			continue;
		}
		if (inside && /^###\s/.test(line)) {
			const title = line.replace(/^###\s+/, "").trim();
			results.push(title);
		}
	}
	return results;
}

// ── Agent definition ─────────────────────────────────────────────────────────

interface AgentDef {
	agentIdentity: string;
	displayName: string;
	division: string;
	roles: string[];
	fm: Frontmatter;
	capabilities: string[];
	boundaries: string[];
	filePath: string;
}

function parseAgentFile(filePath: string, division: string): AgentDef | null {
	const content = fs.readFileSync(filePath, "utf-8");
	const fm = parseFrontmatter(content);
	if (!fm || !fm.name) return null;

	const agentIdentity = `agency-agents/${slugify(fm.name)}`;
	const capabilities = extractH3sUnderH2(content, /Core Mission/i).map(slugify);
	const boundaries = extractH3sUnderH2(content, /Critical Rules/i);

	const roles =
		division === "specialized" ? specializedRoles(fm.name) : (DIVISION_ROLES[division] ?? ["researcher"]);

	return {
		agentIdentity,
		displayName: fm.name,
		division,
		roles,
		fm,
		capabilities,
		boundaries,
		filePath,
	};
}

// ── Pre-flight checks ────────────────────────────────────────────────────────

async function preflightChecks(): Promise<void> {
	// 1. Check personality + display_metadata columns exist
	const colResult = await pgQuery<{ count: string }>(
		`SELECT count(*) FROM information_schema.columns
		 WHERE table_schema = 'roadmap_workforce'
		   AND table_name = 'agent_registry'
		   AND column_name IN ('personality','display_metadata')`,
		[],
	);
	if (Number(colResult.rows[0]?.count ?? 0) < 2) {
		console.error(
			"PRE-FLIGHT FAILED: personality/display_metadata columns missing — P1356 migration required",
		);
		process.exit(1);
	}

	// 2. Check agent_type='agency' is accepted
	try {
		await pgQuery(
			`SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_type='agency' LIMIT 1`,
			[],
		);
	} catch {
		console.error(
			"PRE-FLIGHT FAILED: agent_type='agency' not accepted — check constraint must be relaxed first",
		);
		process.exit(1);
	}
}

// ── DB upsert ────────────────────────────────────────────────────────────────

async function upsertAgent(def: AgentDef): Promise<bigint> {
	const personality = {
		vibe: def.fm.vibe,
		core_truths: [],
		boundaries: def.boundaries,
		communication_style: null,
		expertise: def.roles,
	};
	const displayMetadata = {
		emoji: def.fm.emoji,
		color: def.fm.color,
		vibe: def.fm.vibe,
		description: def.fm.description,
		source: "agency-agents",
		division: def.division,
	};
	const primaryRole = def.roles[0] ?? "researcher";

	const result = await pgQuery<{ id: string }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, preferred_provider, role,
		    personality, display_metadata, display_name, project_id)
		 VALUES ($1, 'agency', 'inactive', NULL, $2, $3::jsonb, $4::jsonb, $5, 1)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   status           = 'inactive',
		   role             = EXCLUDED.role,
		   personality      = EXCLUDED.personality,
		   display_metadata = EXCLUDED.display_metadata,
		   display_name     = EXCLUDED.display_name,
		   updated_at       = now()
		 RETURNING id`,
		[
			def.agentIdentity,
			primaryRole,
			JSON.stringify(personality),
			JSON.stringify(displayMetadata),
			def.displayName,
		],
	);

	return BigInt(result.rows[0]!.id);
}

async function upsertCapabilities(agentId: bigint, capabilities: string[]): Promise<void> {
	for (const cap of capabilities) {
		await pgQuery(
			`INSERT INTO roadmap_workforce.agent_capability (agent_id, capability)
			 VALUES ($1, $2)
			 ON CONFLICT (agent_id, capability) DO NOTHING`,
			[agentId.toString(), cap],
		);
	}
}

// ── Main export ──────────────────────────────────────────────────────────────

export interface ImportOptions {
	localPath: string;
	dryRun?: boolean;
}

export async function runImport(options: ImportOptions): Promise<void> {
	const { localPath, dryRun = false } = options;

	if (!fs.existsSync(localPath)) {
		console.error(`Source path not found: ${localPath}`);
		process.exit(1);
	}

	if (!dryRun) {
		await preflightChecks();
	}

	// Scan divisions
	const defs: AgentDef[] = [];
	for (const division of IMPORTABLE_DIVISIONS) {
		const divPath = path.join(localPath, division);
		if (!fs.existsSync(divPath)) continue;

		const files = fs
			.readdirSync(divPath)
			.filter((f) => f.endsWith(".md"))
			.sort();

		for (const file of files) {
			const filePath = path.join(divPath, file);
			const def = parseAgentFile(filePath, division);
			if (!def) {
				console.warn(`  SKIP ${file}: could not parse frontmatter`);
				continue;
			}
			defs.push(def);
		}
	}

	console.log(`\nFound ${defs.length} agents across ${IMPORTABLE_DIVISIONS.length} divisions`);

	if (dryRun) {
		console.log("\n[DRY RUN] Would import:");
		for (const def of defs) {
			console.log(
				`  ${def.agentIdentity} (${def.division}) — ${def.capabilities.length} caps, ${def.boundaries.length} rules`,
			);
		}
		console.log(`\n[DRY RUN] Total: ${defs.length} agents`);
		return;
	}

	let succeeded = 0;
	let failed = 0;
	const errors: string[] = [];

	for (const def of defs) {
		try {
			const agentId = await upsertAgent(def);
			await upsertCapabilities(agentId, def.capabilities);
			succeeded++;
			process.stdout.write(".");
		} catch (err) {
			failed++;
			const msg = `${def.agentIdentity}: ${(err as Error).message}`;
			errors.push(msg);
			process.stdout.write("E");
		}
	}

	console.log(
		`\n\nImport complete: ${succeeded} succeeded, ${failed} failed out of ${defs.length} total`,
	);

	if (errors.length > 0) {
		console.error("\nErrors:");
		for (const e of errors) console.error(`  ${e}`);
		process.exitCode = 2;
	}
}

// ── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const dryRun = argv.includes("--dry-run");
	const lpIdx = argv.indexOf("--local-path");
	const localPath = lpIdx !== -1 ? argv[lpIdx + 1]! : "/data/code/agency-agents";

	if (!localPath) {
		console.error("Usage: import-agency-agents-catalog.ts [--local-path <dir>] [--dry-run]");
		process.exit(1);
	}

	try {
		await runImport({ localPath, dryRun });
	} finally {
		await closePool().catch(() => {});
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
