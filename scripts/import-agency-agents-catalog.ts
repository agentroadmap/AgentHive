/**
 * Import agency-agents catalog as inactive agent seeds.
 *
 * Reads all agent .md files from msitarzewski/agency-agents (local clone),
 * parses frontmatter + section headings, and upserts rows into
 * roadmap_workforce.agent_registry and roadmap_workforce.agent_capability.
 *
 * Usage:
 *   npx tsx scripts/import-agency-agents-catalog.ts [--local-path <dir>] [--dry-run]
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { getPool } from "../src/postgres/pool.ts";

export interface ImportOptions {
	localPath?: string;
	dryRun?: boolean;
}

// Divisions to scan (top-level .md files only)
const IMPORTABLE_DIVISIONS = [
	"academic",
	"design",
	"engineering",
	"game-development",
	"marketing",
	"paid-media",
	"product",
	"project-management",
	"sales",
	"spatial-computing",
	"specialized",
	"strategy",
	"support",
	"testing",
] as const;

type Division = (typeof IMPORTABLE_DIVISIONS)[number];

// Division → expertise roles mapping
const DIVISION_EXPERTISE: Record<Division, string[]> = {
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
	specialized: [],
	academic: ["researcher"],
};

const SPECIALIZED_KEYWORD_MAP: Record<string, string[]> = {
	architect: ["architect"],
	engineer: ["coder"],
	developer: ["coder"],
	coder: ["coder"],
	auditor: ["reviewer"],
	reviewer: ["reviewer"],
	analyst: ["researcher"],
	strategist: ["researcher"],
	designer: ["designer"],
	writer: ["writer"],
	trainer: ["writer"],
	coach: ["researcher"],
	operator: ["coordinator"],
	orchestrator: ["coordinator"],
	manager: ["coordinator"],
};

interface AgentDef {
	division: Division;
	filePath: string;
	identity: string;
	name: string;
	description: string;
	color: string;
	emoji: string;
	vibe: string;
	expertise: string[];
	capabilities: string[];
	boundaries: string[];
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseFrontmatter(
	content: string,
): Record<string, string> | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	const result: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
		if (key) result[key] = val;
	}
	return result;
}

/**
 * Extract H3 headings from the first occurrence of a section that matches
 * any of the provided heading patterns. Stops at the next H2 or H1.
 */
function extractH3sUnderSection(
	content: string,
	sectionPatterns: RegExp[],
): string[] {
	const lines = content.split("\n");
	let inSection = false;
	const results: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Check if we're entering a matching section
		if (!inSection) {
			for (const pat of sectionPatterns) {
				if (pat.test(trimmed)) {
					inSection = true;
					break;
				}
			}
			continue;
		}

		// Stop if we hit another H1 or H2 (not H3)
		if (/^#{1,2}\s/.test(trimmed) && !/^###\s/.test(trimmed)) {
			break;
		}

		// Collect H3 headings
		if (/^###\s+/.test(trimmed)) {
			const heading = trimmed.replace(/^###\s+/, "").replace(/\*\*/g, "").trim();
			results.push(heading);
		}
	}

	return results;
}

function inferSpecializedExpertise(name: string): string[] {
	const lower = name.toLowerCase();
	for (const [keyword, roles] of Object.entries(SPECIALIZED_KEYWORD_MAP)) {
		if (lower.includes(keyword)) return roles;
	}
	return ["researcher"];
}

async function parseAgentFile(
	filePath: string,
	division: Division,
): Promise<AgentDef | null> {
	const content = await readFile(filePath, "utf-8");
	const fm = parseFrontmatter(content);
	if (!fm?.name) return null;

	const capabilities = extractH3sUnderSection(content, [
		/^##\s+🎯\s+Your Core Mission/,
		/^#\s+Your Core Mission/,
	]).map(slugify);

	const boundaries = extractH3sUnderSection(content, [
		/^##\s+🚨\s+Critical Rules/,
		/^#\s+Critical Rules/,
	]);

	let expertise =
		division === "specialized"
			? inferSpecializedExpertise(fm.name)
			: DIVISION_EXPERTISE[division];

	const identity = `agency-agents/${slugify(fm.name)}`;

	return {
		division,
		filePath,
		identity,
		name: fm.name,
		description: fm.description ?? "",
		color: fm.color ?? "blue",
		emoji: fm.emoji ?? "",
		vibe: fm.vibe ?? "",
		expertise,
		capabilities,
		boundaries,
	};
}

async function scanDivision(
	baseDir: string,
	division: Division,
): Promise<AgentDef[]> {
	const dir = join(baseDir, division);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}

	const defs: AgentDef[] = [];
	for (const entry of entries) {
		if (extname(entry) !== ".md") continue;
		// Skip documentation files that aren't agent definitions
		if (/^(README|QUICKSTART|EXECUTIVE|NEXUS|CONTRIBUTING)/i.test(entry)) {
			continue;
		}
		const filePath = join(dir, entry);
		const def = await parseAgentFile(filePath, division);
		if (def) defs.push(def);
	}
	return defs;
}

async function preflightCheck(): Promise<void> {
	const pool = getPool();
	const client = await pool.connect();
	try {
		// Check personality + display_metadata columns exist
		const colRes = await client.query<{ column_name: string }>(
			`SELECT column_name
			 FROM information_schema.columns
			 WHERE table_schema = 'roadmap_workforce'
			   AND table_name = 'agent_registry'
			   AND column_name IN ('personality', 'display_metadata')`,
		);
		const cols = colRes.rows.map((r) => r.column_name);
		if (!cols.includes("personality") || !cols.includes("display_metadata")) {
			throw new Error(
				"P1356 migration required: personality and/or display_metadata columns missing from roadmap_workforce.agent_registry",
			);
		}

		// Check agent_type='agency' is accepted
		const typeRes = await client.query<{ conbin: string }>(
			`SELECT pg_get_constraintdef(oid) as conbin
			 FROM pg_constraint
			 WHERE conname = 'agent_registry_type_check'
			   AND conrelid = 'roadmap_workforce.agent_registry'::regclass`,
		);
		if (typeRes.rows.length > 0 && !typeRes.rows[0].conbin.includes("'agency'")) {
			console.warn(
				"[preflight] agent_type check constraint does not include 'agency' — will use 'llm' as fallback",
			);
		}
	} finally {
		client.release();
	}
}

async function upsertAgent(
	client: Awaited<ReturnType<ReturnType<typeof getPool>["connect"]>>,
	def: AgentDef,
	agentType: "agency" | "llm",
): Promise<number> {
	const personality = {
		vibe: def.vibe,
		expertise: def.expertise,
		boundaries: def.boundaries,
		core_truths: [],
		communication_style: "",
	};

	const display_metadata = {
		emoji: def.emoji,
		color: def.color,
		vibe: def.vibe,
		description: def.description,
		source: "agency-agents",
		division: def.division,
	};

	const res = await client.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, preferred_provider, personality, display_metadata)
		 VALUES ($1, $2, 'inactive', NULL, $3::jsonb, $4::jsonb)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   status           = 'inactive',
		   personality      = EXCLUDED.personality,
		   display_metadata = EXCLUDED.display_metadata,
		   updated_at       = now()
		 RETURNING id`,
		[
			def.identity,
			agentType,
			JSON.stringify(personality),
			JSON.stringify(display_metadata),
		],
	);
	return res.rows[0].id;
}

async function upsertCapabilities(
	client: Awaited<ReturnType<ReturnType<typeof getPool>["connect"]>>,
	agentId: number,
	capabilities: string[],
): Promise<void> {
	if (capabilities.length === 0) return;
	await client.query(
		`INSERT INTO roadmap_workforce.agent_capability (agent_id, capability)
		 SELECT $1, unnest($2::text[])
		 ON CONFLICT (agent_id, capability) DO NOTHING`,
		[agentId, capabilities],
	);
}

export async function runImport(opts: ImportOptions = {}): Promise<void> {
	const localPath = opts.localPath ?? "/data/code/agency-agents";
	const dryRun = opts.dryRun ?? false;

	console.log(
		`[import-catalog] source=${localPath} dry-run=${dryRun}`,
	);

	if (!dryRun) {
		await preflightCheck();
	}

	// Scan all divisions
	const allDefs: AgentDef[] = [];
	for (const division of IMPORTABLE_DIVISIONS) {
		const defs = await scanDivision(localPath, division);
		allDefs.push(...defs);
	}

	console.log(`[import-catalog] found ${allDefs.length} agent definitions`);

	if (dryRun) {
		for (const def of allDefs) {
			console.log(
				`  ${def.identity} | div=${def.division} caps=${def.capabilities.length} expertise=${def.expertise.join(",")}`,
			);
		}
		console.log("[import-catalog] dry-run complete — no writes performed");
		return;
	}

	// Determine agent_type to use (agency or fallback to llm)
	let agentType: "agency" | "llm" = "agency";
	const pool = getPool();
	{
		const client = await pool.connect();
		try {
			const res = await client.query<{ conbin: string }>(
				`SELECT pg_get_constraintdef(oid) as conbin
				 FROM pg_constraint
				 WHERE conname = 'agent_registry_type_check'
				   AND conrelid = 'roadmap_workforce.agent_registry'::regclass`,
			);
			if (res.rows.length > 0 && !res.rows[0].conbin.includes("'agency'")) {
				agentType = "llm";
				console.warn("[import-catalog] falling back to agent_type='llm'");
			}
		} finally {
			client.release();
		}
	}

	let inserted = 0;
	let updated = 0;
	let capRows = 0;
	let failed = 0;

	for (const def of allDefs) {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			// Check if row exists to count insert vs update
			const existing = await client.query<{ id: number }>(
				`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
				[def.identity],
			);
			const isNew = existing.rows.length === 0;

			const agentId = await upsertAgent(client, def, agentType);
			await upsertCapabilities(client, agentId, def.capabilities);

			await client.query("COMMIT");

			if (isNew) inserted++;
			else updated++;
			capRows += def.capabilities.length;

			console.log(
				`  [${isNew ? "INSERT" : "UPDATE"}] ${def.identity} caps=${def.capabilities.length}`,
			);
		} catch (err) {
			await client.query("ROLLBACK").catch(() => {});
			console.error(`  [ERROR] ${def.identity}: ${(err as Error).message}`);
			failed++;
		} finally {
			client.release();
		}
	}

	console.log(
		`[import-catalog] done — inserted=${inserted} updated=${updated} capability_rows=${capRows} failed=${failed}`,
	);

	// Shutdown pool
	await pool.end();
}

// Run directly if invoked as script
const isMain =
	process.argv[1] &&
	(process.argv[1].endsWith("import-agency-agents-catalog.ts") ||
		process.argv[1].endsWith("import-agency-agents-catalog.js"));

if (isMain) {
	const args = process.argv.slice(2);
	const localPathIdx = args.indexOf("--local-path");
	const localPath =
		localPathIdx !== -1 ? args[localPathIdx + 1] : "/data/code/agency-agents";
	const dryRun = args.includes("--dry-run");

	runImport({ localPath, dryRun }).catch((err) => {
		console.error("[import-catalog] fatal:", err);
		process.exit(1);
	});
}
