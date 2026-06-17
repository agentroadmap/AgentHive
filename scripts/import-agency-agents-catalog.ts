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
import { extname, join } from "node:path";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";

export interface ImportOptions {
	localPath?: string;
	dryRun?: boolean;
}

// Divisions to scan (top-level .md files only)
export const IMPORTABLE_DIVISIONS = [
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

// Dirs that exist on disk but are deliberately NOT imported. `finance` was
// added to the catalog after the P1358 spec (14 divisions / 167 agents); it is
// excluded here so the import stays at the spec'd scope and AC-17's
// reconciliation does not hard-fail. Surfaced in dry-run output.
const EXCLUDED_DIRS = new Set([
	"examples",
	"scripts",
	"integrations",
	"finance",
	// Divisions added upstream after the P1358 spec — excluded to keep the
	// import at the spec'd scope and let AC-17 reconciliation pass. (The
	// security-engineer persona still imports via the 'engineering' division.)
	// Opt these in later by moving them to IMPORTABLE_DIVISIONS.
	"gis",
	"security",
]);

/** Clamp a string to `max` chars (DB CHECK: vibe ≤160, communication ≤500). */
function clamp(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// Expertise roles accepted by fn_validate_personality. Anything else (e.g. the
// 'coordinator' the specialized keyword map can yield) is filtered out before
// insert, falling back to 'researcher'.
const VALID_EXPERTISE = new Set([
	"architect",
	"reviewer",
	"coder",
	"debugger",
	"writer",
	"researcher",
	"tester",
	"devops",
	"designer",
]);

// Division → expertise roles mapping
const DIVISION_EXPERTISE: Record<Division, string[]> = {
	engineering: ["architect", "coder", "reviewer"],
	design: ["designer"],
	testing: ["tester"],
	support: ["writer"],
	marketing: ["researcher", "writer"],
	"paid-media": ["researcher", "writer"],
	sales: ["researcher"],
	product: ["researcher"],
	"project-management": ["researcher"],
	"game-development": ["designer", "coder"],
	"spatial-computing": ["designer"],
	specialized: [],
	strategy: ["researcher", "writer"],
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
	capabilityTitles: string[];
	boundaries: string[];
	communicationStyle: string;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseFrontmatter(content: string): Record<string, string> | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	const result: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const val = line
			.slice(colon + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
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
			const heading = trimmed
				.replace(/^###\s+/, "")
				.replace(/\*\*/g, "")
				.trim();
			results.push(heading);
		}
	}

	return results;
}

/**
 * First block of body text under the first H2 matching any pattern. Used for
 * communication_style, which fn_validate_personality requires to be non-empty.
 */
function extractBodyUnderSection(
	content: string,
	sectionPatterns: RegExp[],
): string {
	const lines = content.split("\n");
	let inSection = false;
	const buf: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!inSection) {
			if (sectionPatterns.some((p) => p.test(trimmed))) inSection = true;
			continue;
		}
		if (/^#{1,2}\s/.test(trimmed) && !/^###\s/.test(trimmed)) break;
		const text = trimmed
			.replace(/^[-*]\s+/, "")
			.replace(/\*\*/g, "")
			.trim();
		if (text && !/^###\s/.test(text)) buf.push(text);
	}
	return buf.join(" ").trim();
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

	const capabilityTitles = extractH3sUnderSection(content, [
		/^##\s+🎯\s+Your Core Mission/,
		/^#\s+Your Core Mission/,
	]);
	const capabilities = capabilityTitles.map(slugify).filter(Boolean);

	const boundaries = extractH3sUnderSection(content, [
		/^##\s+🚨\s+Critical Rules/,
		/^#\s+Critical Rules/,
	]);

	const communicationStyle = extractBodyUnderSection(content, [
		/^##\s+💭\s+Your Communication Style/,
		/^#\s+Your Communication Style/,
	]);

	const expertise =
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
		capabilityTitles,
		boundaries,
		communicationStyle,
	};
}

interface DivisionScan {
	defs: AgentDef[];
	rawMd: number; // total .md files seen
	skipped: number; // .md files skipped (doc files / no frontmatter)
}

async function scanDivision(
	baseDir: string,
	division: Division,
): Promise<DivisionScan> {
	const dir = join(baseDir, division);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return { defs: [], rawMd: 0, skipped: 0 };
	}

	const defs: AgentDef[] = [];
	let rawMd = 0;
	for (const entry of entries) {
		if (extname(entry) !== ".md") continue;
		rawMd++;
		// Skip documentation files that aren't agent definitions (README,
		// QUICKSTART, EXECUTIVE-BRIEF, nexus-*, CONTRIBUTING — present e.g. in
		// strategy/, which holds only planning docs, not agents).
		if (/^(README|QUICKSTART|EXECUTIVE|NEXUS|CONTRIBUTING)/i.test(entry)) {
			continue;
		}
		const filePath = join(dir, entry);
		const def = await parseAgentFile(filePath, division);
		if (def) defs.push(def); // parseAgentFile returns null when no `name:` frontmatter
	}
	return { defs, rawMd, skipped: rawMd - defs.length };
}

/**
 * AC-17: reconcile the declared IMPORTABLE_DIVISIONS against on-disk reality.
 * Returns divisions declared-but-absent and present-but-unaccounted-for (i.e.
 * neither importable nor explicitly excluded).
 */
export async function reconcileDivisions(root: string): Promise<{
	missingFromDisk: string[];
	extraOnDisk: string[];
}> {
	const entries = await readdir(root, { withFileTypes: true });
	const onDisk = entries
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => e.name);
	const importable = new Set<string>(IMPORTABLE_DIVISIONS);
	const missingFromDisk = IMPORTABLE_DIVISIONS.filter(
		(d) => !onDisk.includes(d),
	);
	const extraOnDisk = onDisk.filter(
		(d) => !importable.has(d) && !EXCLUDED_DIRS.has(d),
	);
	return { missingFromDisk, extraOnDisk };
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
		if (
			typeRes.rows.length > 0 &&
			!typeRes.rows[0].conbin.includes("'agency'")
		) {
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
	// fn_validate_personality is STRICT: vibe non-empty ≤160; core_truths,
	// boundaries, expertise all NON-EMPTY arrays; communication_style non-empty
	// ≤500; expertise ∈ VALID_EXPERTISE. The P1358 spec's `core_truths: []` /
	// `communication_style: ""` shape would be rejected on EVERY insert — derive
	// non-empty values with safe fallbacks.
	const vibe = clamp(def.vibe || def.description || `${def.name} agent`, 160);
	const coreTruths = def.capabilityTitles.length
		? def.capabilityTitles
		: [def.description || `${def.name} — agency-agents catalog seed`];
	const boundaries = def.boundaries.length
		? def.boundaries
		: ["Operates within agency-agents catalog conventions"];
	const expertise = (() => {
		const valid = def.expertise.filter((r) => VALID_EXPERTISE.has(r));
		return valid.length ? valid : ["researcher"];
	})();
	const communication_style = clamp(
		def.communicationStyle || "Professional, domain-focused communication.",
		500,
	);

	const personality = {
		vibe,
		expertise,
		boundaries,
		core_truths: coreTruths,
		communication_style,
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

	console.log(`[import-catalog] source=${localPath} dry-run=${dryRun}`);

	// AC-17: reconcile divisions before any scan or write.
	const { missingFromDisk, extraOnDisk } = await reconcileDivisions(localPath);
	for (const d of missingFromDisk) {
		console.error(`Division ${d} declared but not found in catalog`);
	}
	if (missingFromDisk.length) {
		throw new Error("declared division(s) missing from disk");
	}
	for (const d of extraOnDisk) {
		console.error(
			`Division ${d} present in catalog but not in IMPORTABLE_DIVISIONS — did you mean to exclude it?`,
		);
	}
	if (extraOnDisk.length) {
		throw new Error("unreconciled division(s) on disk");
	}

	if (!dryRun) {
		await preflightCheck();
	}

	// Scan all divisions (track raw .md and skipped non-agent docs per division).
	const allDefs: AgentDef[] = [];
	const scanByDivision: Record<string, DivisionScan> = {};
	let rawTotal = 0;
	let skippedTotal = 0;
	for (const division of IMPORTABLE_DIVISIONS) {
		const scan = await scanDivision(localPath, division);
		scanByDivision[division] = scan;
		allDefs.push(...scan.defs);
		rawTotal += scan.rawMd;
		skippedTotal += scan.skipped;
	}

	console.log(
		`[import-catalog] ${allDefs.length} importable agents (${rawTotal} .md files, ${skippedTotal} non-agent docs skipped)`,
	);

	if (dryRun) {
		console.log("\n[import-catalog] per-division breakdown:");
		for (const division of IMPORTABLE_DIVISIONS) {
			const s = scanByDivision[division];
			console.log(
				`  ${division.padEnd(20)} agents=${String(s.defs.length).padStart(3)} ` +
					`raw=${String(s.rawMd).padStart(3)}` +
					(s.skipped ? `  (${s.skipped} non-agent skipped)` : ""),
			);
		}
		if (EXCLUDED_DIRS.size) {
			console.log(`  excluded dirs: ${[...EXCLUDED_DIRS].join(", ")}`);
		}
		// Parsed sample (AC-2).
		const sample = allDefs[0];
		if (sample) {
			console.log(
				`\n[import-catalog] sample: name="${sample.name}" slug=${sample.identity} ` +
					`caps=${sample.capabilities.length} expertise=${sample.expertise.join(",")} ` +
					`vibe="${clamp(sample.vibe, 60)}"`,
			);
		}
		console.log(
			`\n[import-catalog] total=${allDefs.length} dry-run complete — no writes performed`,
		);
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
	await closePool();
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
