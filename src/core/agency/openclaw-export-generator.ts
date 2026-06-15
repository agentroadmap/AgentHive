/**
 * P1357 (P1355-B): OpenClaw workspace export adapter.
 *
 * Amends Article 1 §4 — Agent Identity and External Interop. Generates the three
 * standard OpenClaw workspace files from an AgentHive agent_registry row so an
 * external contributor running OpenClaw can stand up an AgentHive agency as a
 * first-class workspace without DB access.
 *
 * Pure generator: `generateOpenClawWorkspace()` is a total function of its input
 * profile (no DB, no clock) so it is unit-testable from a fixture row. The DB
 * read lives in `loadAgentProfile()`; the file write + CLI gate live in
 * src/apps/hive-cli/commands/export-openclaw.ts.
 *
 * Schema note: personality + display_metadata are JSONB columns ON
 * roadmap_workforce.agent_registry (NOT a separate agent_profile table — the
 * original P1355-B design predated the P1356 migration that put them inline).
 * Capabilities come from roadmap_workforce.agent_capability (agent_id FK,
 * capability text, proficiency 1-5). There is no `category` column, so AC-4's
 * "grouped by category" is realized as grouping by proficiency band.
 */

import { query } from "../../infra/postgres/pool.ts";
import type {
	AgentDisplayMetadata,
	AgentPersonality,
} from "../identity/agent-registry/types.ts";

/** One capability row as read from roadmap_workforce.agent_capability. */
export interface AgentCapabilityRow {
	capability: string;
	proficiency: number;
}

/**
 * Everything the generator needs to render an OpenClaw workspace. Assembled by
 * loadAgentProfile() from agent_registry + agent_capability, or hand-built in
 * tests.
 */
export interface OpenClawAgentProfile {
	agent_identity: string;
	display_alias: string;
	display_name: string | null;
	personality: AgentPersonality | null;
	display_metadata: AgentDisplayMetadata | null;
	capabilities: AgentCapabilityRow[];
}

export interface OpenClawWorkspace {
	soul_md: string;
	identity_md: string;
	agents_md: string;
}

/** Standard AgentHive continuity preamble — every exported SOUL.md shares it. */
const CONTINUITY_PREAMBLE =
	"Stateless across sessions; state management via roadmap.proposal_discussion. " +
	"You carry no memory between runs — reconstruct context from proposal discussions, " +
	"acceptance criteria, and the message ledger before acting.";

/** Standard "Every Session" startup checklist for AGENTS.md. */
const EVERY_SESSION_CHECKLIST = [
	"Read the roadmap://workflow/overview resource to refresh the proposal lifecycle.",
	"Claim (lease) a proposal via the AgentHive MCP before writing to it.",
	"Reconstruct context from the proposal's discussion + acceptance criteria.",
	"Log an issue immediately on any blocker; never bypass an architectural constraint silently.",
	"Commit with specific file references on task completion — no mega-commits.",
];

/** Proficiency band labels (proficiency is 1-5 on agent_capability). */
function proficiencyBand(proficiency: number): string {
	if (proficiency >= 5) return "Expert";
	if (proficiency >= 4) return "Advanced";
	if (proficiency >= 3) return "Proficient";
	if (proficiency >= 2) return "Familiar";
	return "Exposure";
}

/** Order bands strongest-first for deterministic, readable output. */
const BAND_ORDER = ["Expert", "Advanced", "Proficient", "Familiar", "Exposure"];

function groupCapabilitiesByBand(
	caps: AgentCapabilityRow[],
): Array<{ band: string; capabilities: string[] }> {
	const byBand = new Map<string, string[]>();
	for (const c of caps) {
		const band = proficiencyBand(c.proficiency);
		const list = byBand.get(band) ?? [];
		list.push(c.capability);
		byBand.set(band, list);
	}
	return BAND_ORDER.filter((b) => byBand.has(b)).map((band) => ({
		band,
		// Sort capabilities alphabetically within a band for stable output.
		capabilities: (byBand.get(band) as string[]).slice().sort(),
	}));
}

/**
 * AC-2: SOUL.md — Core Truths, Boundaries, Continuity.
 */
function renderSoulMd(p: OpenClawAgentProfile): string {
	const name = p.display_name ?? p.display_alias;
	const truths = p.personality?.core_truths ?? [];
	const boundaries = p.personality?.boundaries ?? [];
	const style = p.personality?.communication_style;

	const lines: string[] = [];
	lines.push(`# SOUL — ${name}`);
	lines.push("");
	if (p.personality?.vibe) {
		lines.push(`> ${p.personality.vibe}`);
		lines.push("");
	}
	lines.push("## Core Truths");
	lines.push("");
	if (truths.length > 0) {
		for (const t of truths) lines.push(`- ${t}`);
	} else {
		lines.push("_No core truths recorded._");
	}
	lines.push("");
	lines.push("## Boundaries");
	lines.push("");
	if (boundaries.length > 0) {
		for (const b of boundaries) lines.push(`- ${b}`);
	} else {
		lines.push("_No boundaries recorded._");
	}
	lines.push("");
	if (style) {
		lines.push("## Communication Style");
		lines.push("");
		lines.push(style);
		lines.push("");
	}
	lines.push("## Continuity");
	lines.push("");
	lines.push(CONTINUITY_PREAMBLE);
	lines.push("");
	return lines.join("\n");
}

/**
 * AC-3: IDENTITY.md — YAML-style metadata block (name required; emoji/vibe
 * optional). OpenClaw's install script keys on `name:`.
 */
function renderIdentityMd(p: OpenClawAgentProfile): string {
	const name = p.display_alias;
	// Live data stores emoji on display_metadata; fall back to a personality
	// emoji if a future row carries it there.
	const emoji =
		p.display_metadata?.emoji ??
		(p.personality as { emoji?: string } | null)?.emoji;
	const vibe = p.personality?.vibe;

	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${name}`);
	if (emoji) lines.push(`emoji: ${emoji}`);
	if (vibe) lines.push(`vibe: ${yamlScalar(vibe)}`);
	if (p.display_metadata?.color) lines.push(`color: ${p.display_metadata.color}`);
	lines.push("---");
	lines.push("");
	lines.push(`# ${emoji ? `${emoji} ` : ""}${p.display_name ?? name}`);
	lines.push("");
	if (p.display_metadata?.description) {
		lines.push(p.display_metadata.description);
		lines.push("");
	}
	return lines.join("\n");
}

/** Quote a YAML scalar only when it contains characters that need it. */
function yamlScalar(value: string): string {
	if (/^[^:#\-?&*!|>'"%@`{}\[\],][^:#]*$/.test(value) && !value.includes(": ")) {
		return value;
	}
	return JSON.stringify(value);
}

/**
 * AC-4: AGENTS.md — Every Session checklist, Capabilities (grouped),
 * Multi-agent Coordination (A2A bus + liaison channels).
 */
function renderAgentsMd(p: OpenClawAgentProfile): string {
	const name = p.display_name ?? p.display_alias;
	const grouped = groupCapabilitiesByBand(p.capabilities);

	const lines: string[] = [];
	lines.push(`# AGENTS — ${name}`);
	lines.push("");
	lines.push("## Every Session");
	lines.push("");
	for (const item of EVERY_SESSION_CHECKLIST) lines.push(`- ${item}`);
	lines.push("");
	lines.push("## Capabilities");
	lines.push("");
	if (grouped.length > 0) {
		for (const g of grouped) {
			lines.push(`- **${g.band}:** ${g.capabilities.join(", ")}`);
		}
	} else {
		lines.push("_No capabilities recorded._");
	}
	lines.push("");
	lines.push("## Multi-agent Coordination");
	lines.push("");
	lines.push(
		"Coordinate over the AgentHive A2A message bus (pg_notify-backed message_ledger). " +
			"Reach other agencies and the operator through liaison channels; announce presence " +
			"via heartbeat and respond to task_request / pong protocol frames. Do not poll the " +
			"DB directly — let the liaison route work to you.",
	);
	lines.push("");
	return lines.join("\n");
}

/**
 * AC-1: pure generator. Returns the three OpenClaw workspace files for a profile.
 * Total over its input — never throws, never reads the DB or the clock.
 */
export function generateOpenClawWorkspace(
	profile: OpenClawAgentProfile,
): OpenClawWorkspace {
	return {
		soul_md: renderSoulMd(profile),
		identity_md: renderIdentityMd(profile),
		agents_md: renderAgentsMd(profile),
	};
}

/**
 * Load a complete OpenClaw profile from the live DB by agent_identity.
 * Returns null when the agent is not found or has no display_alias (export
 * requires a stable workspace directory name).
 */
export async function loadAgentProfile(
	agentIdentity: string,
): Promise<OpenClawAgentProfile | null> {
	const reg = await query<{
		id: string;
		agent_identity: string;
		display_alias: string | null;
		display_name: string | null;
		personality: AgentPersonality | null;
		display_metadata: AgentDisplayMetadata | null;
	}>(
		`SELECT id, agent_identity, display_alias, display_name, personality, display_metadata
		   FROM roadmap_workforce.agent_registry
		  WHERE agent_identity = $1`,
		[agentIdentity],
	);
	if (reg.rows.length === 0) return null;
	const row = reg.rows[0];
	if (!row.display_alias) return null;

	const caps = await query<AgentCapabilityRow>(
		`SELECT capability, proficiency
		   FROM roadmap_workforce.agent_capability
		  WHERE agent_id = $1
		  ORDER BY proficiency DESC, capability`,
		[row.id],
	);

	return {
		agent_identity: row.agent_identity,
		display_alias: row.display_alias,
		display_name: row.display_name,
		personality: row.personality,
		display_metadata: row.display_metadata,
		capabilities: caps.rows,
	};
}
