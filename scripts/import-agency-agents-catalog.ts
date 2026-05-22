#!/usr/bin/env node
/**
 * P1358: Agency-agents catalog import
 *
 * Parses 144+ agent definitions from the msitarzewski/agency-agents repository
 * and upserts them as inactive agent_registry rows with associated capabilities.
 * Also applies the P1355-A schema migration (personality + display_metadata columns)
 * if those columns don't yet exist.
 *
 * Usage:
 *   node --import jiti/register scripts/import-agency-agents-catalog.ts [options]
 *
 * Options:
 *   --local-path <dir>   Path to agency-agents repo (default: /data/code/agency-agents)
 *   --dry-run            Parse + report without writing to DB
 *   --division <name>    Only import one division
 *   --help
 *
 * Idempotent: ON CONFLICT (agent_identity) DO UPDATE — safe to re-run.
 * Imported rows are status='inactive'; the orchestrator ignores them until an
 * operator explicitly activates via mcp_agent action=activate_catalog_agent.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { closePool, query } from "../src/infra/postgres/pool.ts";

// Division folder → ExpertiseRole mapping
const DIVISION_ROLE: Record<string, string> = {
	engineering: "coder",
	design: "designer",
	"paid-media": "researcher",
	sales: "researcher",
	marketing: "researcher",
	product: "researcher",
	"project-management": "coordinator",
	testing: "tester",
	support: "researcher",
	"spatial-computing": "coder",
	specialized: "researcher",
	"game-development": "coder",
	academic: "researcher",
	strategy: "researcher",
};

// All known divisions (in deterministic order)
const DIVISIONS = Object.keys(DIVISION_ROLE);

interface AgentPersonality {
	vibe: string;
	core_truths: string[];
	boundaries: string[];
	communication_style: string;
	expertise: string[];
}

interface AgentDisplayMetadata {
	emoji: string;
	color: string;
	vibe: string;
	description: string;
	source: "agency-agents";
	division: string;
}

interface AgentDef {
	filePath: string;
	division: string;
	agentIdentity: string;
	displayName: string;
	role: string;
	description: string;
	capabilities: string[];
	personality: AgentPersonality;
	displayMetadata: AgentDisplayMetadata;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};

	const result: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let val = line.slice(colonIdx + 1).trim();
		// Strip surrounding quotes
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		result[key] = val;
	}
	return result;
}

function extractCapabilities(content: string): string[] {
	// Find the Core Mission section (stop at the next ## section)
	const missionMatch = content.match(
		/##[^\n]*Core Mission[^\n]*\n([\s\S]*?)(?=\n##[^#]|\n## |$)/i,
	);
	if (!missionMatch) return [];

	const body = missionMatch[1];
	let caps: string[] = [];

	// Strategy 1: ### subsection headers (most common in longer agent files)
	for (const m of body.matchAll(/^###\s+(.+)$/gm)) {
		caps.push(slugify(m[1].trim()));
	}
	if (caps.length > 0) return caps.filter(Boolean).slice(0, 20);

	// Strategy 2: Numbered **Bold** items
	for (const m of body.matchAll(/^\d+\.\s+\*\*([^*]+)\*\*/gm)) {
		caps.push(slugify(m[1].trim()));
	}
	if (caps.length > 0) return caps.filter(Boolean).slice(0, 20);

	// Strategy 3: **Bold** text at start of bullet items
	for (const m of body.matchAll(/^[-*]\s+\*\*([^*]+)\*\*/gm)) {
		caps.push(slugify(m[1].trim()));
	}

	// Strategy 4: **Primary domains:** bullet list
	const domainsMatch = body.match(/\*\*Primary domains[^:]*:\*\*([\s\S]*?)(?:\n\n|\n##|$)/i);
	if (domainsMatch) {
		for (const m of domainsMatch[1].matchAll(/^[-*]\s+(.+)$/gm)) {
			caps.push(slugify(m[1].split("(")[0].trim()));
		}
	}

	return caps.filter(Boolean).slice(0, 20);
}

function extractBoundaries(content: string): string[] {
	// Critical Rules section — extract rule names
	const rulesMatch = content.match(
		/##[^\n]*Critical Rules[^\n]*\n([\s\S]*?)(?=\n##[^#]|\n## |$)/i,
	);
	if (!rulesMatch) return [];

	const body = rulesMatch[1];
	const boundaries: string[] = [];

	// Numbered bold items
	for (const m of body.matchAll(/^\d+\.\s+\*\*([^*]+)\*\*/gm)) {
		boundaries.push(m[1].trim());
	}
	if (boundaries.length > 0) return boundaries.slice(0, 8);

	// ### subsection headers
	for (const m of body.matchAll(/^###\s+(.+)$/gm)) {
		boundaries.push(m[1].trim());
	}

	return boundaries.slice(0, 8);
}

function extractCoreTruths(content: string): string[] {
	// Identity & Memory section — extract personality/experience lines
	const memMatch = content.match(
		/##[^\n]*(Identity|Memory)[^\n]*\n([\s\S]*?)(?=\n##[^#]|\n## |$)/i,
	);
	if (!memMatch) return [];

	const body = memMatch[2];
	const truths: string[] = [];

	for (const m of body.matchAll(/^\s*[-*]\s+\*\*([^*]+)\*\*[:\s]+(.+)$/gm)) {
		const label = m[1].toLowerCase();
		if (label.includes("personality") || label.includes("experience") || label.includes("role")) {
			truths.push(m[2].trim());
		}
	}

	return truths.slice(0, 5);
}

function parseAgentFile(filePath: string, division: string): AgentDef | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const fm = parseFrontmatter(content);
	if (!fm.name) return null;

	const capabilities = extractCapabilities(content);
	const boundaries = extractBoundaries(content);
	const coreTruths = extractCoreTruths(content);
	const role = DIVISION_ROLE[division] ?? "researcher";

	return {
		filePath,
		division,
		agentIdentity: `agency-agents/${slugify(fm.name)}`,
		displayName: fm.name,
		role,
		description: fm.description ?? "",
		capabilities,
		personality: {
			vibe: fm.vibe ?? "",
			core_truths: coreTruths,
			boundaries,
			communication_style: "",
			expertise: [role],
		},
		displayMetadata: {
			emoji: fm.emoji ?? "",
			color: fm.color ?? "",
			vibe: fm.vibe ?? "",
			description: fm.description ?? "",
			source: "agency-agents",
			division,
		},
	};
}

async function ensureColumns(): Promise<void> {
	// P1355-A migration: add personality + display_metadata columns if absent
	await query(`
		ALTER TABLE agent_registry
			ADD COLUMN IF NOT EXISTS personality JSONB,
			ADD COLUMN IF NOT EXISTS display_metadata JSONB
	`);
}

async function upsertAgent(def: AgentDef): Promise<{ isNew: boolean; capCount: number }> {
	const result = await query<{ id: string; is_new: boolean }>(
		`INSERT INTO agent_registry
		   (agent_identity, agent_type, role, status, display_name, preferred_provider,
		    personality, display_metadata)
		 VALUES ($1, 'agency', $2, 'inactive', $3, NULL, $4, $5)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   role             = EXCLUDED.role,
		   display_name     = EXCLUDED.display_name,
		   personality      = EXCLUDED.personality,
		   display_metadata = EXCLUDED.display_metadata,
		   updated_at       = now()
		 RETURNING id, (xmax = 0) AS is_new`,
		[
			def.agentIdentity,
			def.role,
			def.displayName,
			JSON.stringify(def.personality),
			JSON.stringify(def.displayMetadata),
		],
	);

	const row = result.rows[0];
	if (!row) throw new Error(`No RETURNING row for ${def.agentIdentity}`);

	const agentId = BigInt(row.id);
	let capCount = 0;

	for (const cap of def.capabilities) {
		if (!cap) continue;
		await query(
			`INSERT INTO agent_capability (agent_id, capability, proficiency)
			 VALUES ($1, $2, 3)
			 ON CONFLICT (agent_id, capability) DO NOTHING`,
			[agentId, cap],
		);
		capCount++;
	}

	return { isNew: row.is_new, capCount };
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"local-path": { type: "string" },
			"dry-run": { type: "boolean", default: false },
			division: { type: "string" },
			help: { type: "boolean", default: false },
		},
	});

	if (values.help) {
		console.log(
			`Usage: import-agency-agents-catalog [--local-path <dir>] [--dry-run] [--division <name>] [--help]`,
		);
		process.exit(0);
	}

	const repoPath = (values["local-path"] as string | undefined) ?? "/data/code/agency-agents";
	const dryRun = values["dry-run"] as boolean;
	const divisionFilter = values.division as string | undefined;

	if (!existsSync(repoPath)) {
		console.error(`Error: agency-agents repo not found at ${repoPath}`);
		console.error(
			`Clone with: git clone https://github.com/msitarzewski/agency-agents ${repoPath}`,
		);
		process.exit(1);
	}

	const activeDivisions = DIVISIONS.filter((d) => !divisionFilter || d === divisionFilter);

	// Parse all agent definition files
	const agentDefs: AgentDef[] = [];
	const skipped: string[] = [];

	for (const division of activeDivisions) {
		const divPath = join(repoPath, division);
		if (!existsSync(divPath)) continue;

		const files = readdirSync(divPath).filter(
			(f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("."),
		);

		for (const file of files) {
			const def = parseAgentFile(join(divPath, file), division);
			if (def) {
				agentDefs.push(def);
			} else {
				skipped.push(`${division}/${file}`);
			}
		}
	}

	// Summary header
	console.log(`\n=== Agency-Agents Catalog Import ===`);
	console.log(`Repo:      ${repoPath}`);
	console.log(`Mode:      ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
	console.log(`Divisions: ${activeDivisions.join(", ")}`);
	console.log(`Parsed:    ${agentDefs.length} agents`);
	if (skipped.length) console.log(`Skipped:   ${skipped.length} files (missing frontmatter name)`);

	// Division breakdown
	const byDivision: Record<string, number> = {};
	for (const def of agentDefs) {
		byDivision[def.division] = (byDivision[def.division] ?? 0) + 1;
	}
	console.log(`\nBy division:`);
	for (const [div, count] of Object.entries(byDivision)) {
		console.log(`  ${div.padEnd(22)}: ${count}`);
	}

	// Capability extraction sample
	const withCaps = agentDefs.filter((d) => d.capabilities.length > 0);
	console.log(
		`\nCapabilities extracted: ${agentDefs.reduce((s, d) => s + d.capabilities.length, 0)} total across ${withCaps.length}/${agentDefs.length} agents`,
	);

	if (dryRun) {
		console.log(`\nSample (first 5):`);
		for (const def of agentDefs.slice(0, 5)) {
			console.log(
				`  ${def.agentIdentity.padEnd(50)} role=${def.role.padEnd(12)} caps=${def.capabilities.length}`,
			);
			if (def.capabilities.length) {
				console.log(`    capabilities: ${def.capabilities.slice(0, 4).join(", ")}`);
			}
		}
		console.log(`\nDry run complete — no DB writes.`);
		return;
	}

	// Apply schema migration
	console.log(`\nApplying schema migration (personality + display_metadata columns)...`);
	await ensureColumns();
	console.log(`  done.`);

	// Upsert all agents
	console.log(`\nImporting ${agentDefs.length} agents...`);
	let inserted = 0;
	let updated = 0;
	let capTotal = 0;
	const errors: Array<{ identity: string; err: string }> = [];

	for (const def of agentDefs) {
		try {
			const r = await upsertAgent(def);
			if (r.isNew) inserted++;
			else updated++;
			capTotal += r.capCount;
			process.stdout.write(r.isNew ? "+" : ".");
		} catch (err) {
			errors.push({
				identity: def.agentIdentity,
				err: err instanceof Error ? err.message : String(err),
			});
			process.stdout.write("E");
		}
	}

	// Results
	console.log(`\n`);
	console.log(`Results:`);
	console.log(`  Inserted (new):      ${inserted}`);
	console.log(`  Updated (existing):  ${updated}`);
	console.log(`  Capabilities added:  ${capTotal}`);
	console.log(`  Errors:              ${errors.length}`);

	if (errors.length) {
		console.log(`\nErrors:`);
		for (const e of errors) {
			console.log(`  ${e.identity}: ${e.err}`);
		}
	}

	// DB verification
	const { rows: countRows } = await query<{ total: string; caps: string }>(
		`SELECT
		   (SELECT COUNT(*)::text FROM agent_registry WHERE agent_identity LIKE 'agency-agents/%') AS total,
		   (SELECT COUNT(*)::text FROM agent_capability ac
		      JOIN agent_registry ar ON ar.id = ac.agent_id
		      WHERE ar.agent_identity LIKE 'agency-agents/%') AS caps`,
	);
	const counts = countRows[0];
	console.log(`\nDB verification:`);
	console.log(`  agent_registry rows:    ${counts?.total ?? "?"}`);
	console.log(`  agent_capability rows:  ${counts?.caps ?? "?"}`);

	if (errors.length > 0) {
		process.exit(1);
	}
}

main()
	.catch((err) => {
		console.error("Fatal:", err instanceof Error ? err.message : String(err));
		process.exit(1);
	})
	.finally(() => closePool());
