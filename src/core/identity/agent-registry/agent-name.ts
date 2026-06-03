/**
 * P852: Readable agent identity assembly.
 *
 * An agent identity is composed of four hyphen-delimited segments:
 *
 *   {rt}-{host}-{exp}-{n}
 *
 *   rt    Route abbreviation (e.g. "ccs45ant" = claude-code · sonnet-4-5 · anthropic).
 *         Computed deterministically from agent_provider + model_name + route_provider.
 *   host  Spawning host (e.g. "mac", "bot", "srv"). From AGENTHIVE_HOST env.
 *   exp   Expertise hint, mapped to a 2-5 char code (e.g. "ts", "gate", "lsn").
 *   n     Slot character allocated by resolveInstanceId in registry.ts.
 *         Liaison agents use 0..9; expert agents use a..z.
 *
 * This module is pure (no DB, no I/O) so the spawner can call it before
 * pre-claiming a slot, and the registry can call it during fallback paths.
 */

const AGENCY_MAP: Record<string, string> = {
	claude: "cc",
	"claude-code": "cc",
	hermes: "hm",
	openclaw: "oc",
	codex: "cd",
	copilot: "cp",
	"gemini-cli": "gm",
	gemini: "gm",
};

const PROVIDER_MAP: Record<string, string> = {
	anthropic: "ant",
	openai: "oai",
	azure: "az",
	google: "ggl",
	aws: "bdr",
	bedrock: "bdr",
	github: "gh",
};

export const EXPERTISE: Record<string, string> = {
	typescript: "ts",
	javascript: "js",
	postgres: "pg",
	python: "py",
	research: "res",
	qa: "qa",
	"gate-review": "gate",
	architecture: "arch",
	merge: "mrg",
	develop: "dev",
	review: "rev",
	infrastructure: "infra",
	liaison: "lsn",
};

/** Encode an agent_provider value to its 2-char code. Unknown → first 2 chars. */
export function encodeAgency(agentProvider: string): string {
	const key = agentProvider.toLowerCase();
	return AGENCY_MAP[key] ?? key.replace(/[^a-z0-9]/g, "").slice(0, 2);
}

/** Encode a route_provider value to its 2-3 char code. Unknown → first 3 chars. */
export function encodeProvider(routeProvider: string): string {
	const key = routeProvider.toLowerCase();
	return PROVIDER_MAP[key] ?? key.replace(/[^a-z0-9]/g, "").slice(0, 3);
}

/**
 * Encode a model_name to its compact code.
 *
 * The goal is uniqueness across concurrent routes, not human-readability of
 * the model itself — that lives in display_name. So we extract:
 *   family letter (s/o/h for sonnet/opus/haiku, gp for gpt, etc.)
 *   + major-minor digits when present
 *
 * Examples:
 *   claude-sonnet-4-5*  → s45
 *   claude-opus-4-7*    → o47
 *   claude-haiku-4-5*   → h45
 *   gpt-4o*             → gp4o
 *   gpt-4*              → gp4
 *   o1*, o3*            → o1, o3
 *   gemini-2-flash*     → g2
 */
export function encodeModel(modelName: string): string {
	const m = modelName.toLowerCase();

	// claude-{family}-{major}-{minor}-... → letter + major + minor
	const claude = m.match(/^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d+))?/);
	if (claude) {
		const letter = claude[1][0]; // s | o | h
		const major = claude[2];
		const minor = claude[3] ?? "";
		return `${letter}${major}${minor}`;
	}

	// gpt-{N}{suffix?} → "gp" + N + optional letter
	const gpt = m.match(/^gpt-(\d+)([a-z])?/);
	if (gpt) {
		return `gp${gpt[1]}${gpt[2] ?? ""}`;
	}

	// o-series (o1, o3, o4-mini, …) → "o" + N
	const oSeries = m.match(/^o(\d+)/);
	if (oSeries) {
		return `o${oSeries[1]}`;
	}

	// gemini-{N}* → "g" + N
	const gemini = m.match(/^gemini-(\d+)/);
	if (gemini) {
		return `g${gemini[1]}`;
	}

	// Unknown family — first 4 alphanumerics, lowercase
	return m.replace(/[^a-z0-9]/g, "").slice(0, 4);
}

/**
 * Compute the route abbreviation token from the three identity dimensions.
 * Pure string transform; safe to call without any DB lookup.
 */
export function computeAbbr(
	agentProvider: string,
	modelName: string,
	routeProvider: string,
): string {
	return (
		encodeAgency(agentProvider) +
		encodeModel(modelName) +
		encodeProvider(routeProvider)
	);
}

/** Well-known acronyms that render fully uppercased in display aliases (e.g. qa→QA, ai→AI). */
export const ALL_CAPS_TOKENS = new Set(["qa", "ai", "ml", "sre", "ux", "ui", "api"]);

/**
 * Convert a raw expertise hint to PascalCase for display alias.
 * Hyphen-delimited parts are joined without separator.
 * Parts that are well-known acronyms are fully uppercased.
 *
 *   "documenter"   → "Documenter"
 *   "gate-review"  → "GateReview"
 *   "qa"           → "QA"
 *   "ai-architect" → "AIArchitect"
 */
export function titleCaseExpertise(raw: string): string {
	return raw
		.split(/[-_\s]+/)
		.filter((part) => part.length > 0)
		.map((part) => {
			const lower = part.toLowerCase();
			return ALL_CAPS_TOKENS.has(lower)
				? lower.toUpperCase()
				: lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join("");
}

/** Returns true when the string looks like a dense route abbreviation (e.g. "ccs46ant"). */
function isAbbrShape(s: string): boolean {
	return /^[a-z]{2,4}\d/.test(s);
}

/**
 * Map a capability or stage hint to its expertise code.
 * Unknown → first 5 chars of the raw string (slug-safe).
 */
export function encodeExpertise(hint: string): string {
	const key = hint.toLowerCase();
	return EXPERTISE[key] ?? key.replace(/[^a-z0-9-]/g, "").slice(0, 5);
}

/**
 * Build the base name (everything except the slot character).
 *
 *   buildBaseName("ccs45ant", "mac", ["typescript"]) === "ccs45ant-mac-ts"
 *   buildBaseName("hms45ant", "bot", ["gate-review"]) === "hms45ant-bot-gate"
 *   buildBaseName("ccs45ant", "mac", []) === "ccs45ant-mac"
 *
 * The first non-empty hint wins. Pass capabilities[0] when present, else
 * the workflow stage, else nothing.
 */
export function buildBaseName(
	routeAbbr: string,
	host: string,
	hints: ReadonlyArray<string | undefined>,
): string {
	const firstHint = hints.find((h) => typeof h === "string" && h.length > 0);
	const exp = firstHint ? encodeExpertise(firstHint) : null;
	return [routeAbbr, host, exp].filter(Boolean).join("-");
}

/**
 * Liaison singletons get the 0..9 slot range. Expert agents get a..z.
 * Pass the same hint array used for buildBaseName.
 */
export function isLiaisonHint(
	hints: ReadonlyArray<string | undefined>,
): boolean {
	const first = hints.find((h) => typeof h === "string" && h.length > 0);
	return first?.toLowerCase() === "liaison";
}

export const LIAISON_SLOTS = "0123456789";
export const EXPERT_SLOTS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Dense route-abbr shape: all lowercase+digits, at least one digit, no
 * spaces or hyphens. Matches "ccs46ant", "hms45ant". Does NOT match
 * "Claude", "claude", or "claude code".
 */
const ABBR_SHAPE = /^[a-z][a-z0-9]*\d[a-z0-9]*$/;

/**
 * P919: Assign a human-readable display alias for an agent.
 *
 * Tier 1 (Liaison): "{Provider}-{Host}" (e.g., "Claude-Bot", "Codex-Hermes")
 * Tier 2 (Expert slot-0): "{Provider}-{Host}-{Expertise}" (e.g., "Claude-Bot-Architect")
 * Tier 3+: No alias (rotated slots return empty/null)
 *
 * @param agencyName - Human-friendly provider name from model_routes.agent_provider
 *                     (e.g. "Claude", "Codex"). Must NOT be the dense P852 routeAbbr
 *                     ("ccs46ant") — this function throws on abbr-shape input.
 * @param hostId - Spawning host (e.g., "bot", "hermes", "mac")
 * @param expertise - Optional expertise hint (e.g., "architecture", "typescript")
 * @param slotChar - The slot character assigned (0..9 for liaison, a..z for expert)
 * @returns The display alias, or null if not applicable
 */
export function assignDisplayAlias(
	agentProvider: string,
	hostId: string,
	expertise?: string,
	slotChar?: string,
): string | null {
	// Reject dense route abbreviation shapes (e.g. "ccs46ant") — must be the
	// human-friendly model_routes.agent_provider value (e.g. "Claude", "Codex").
	if (isAbbrShape(agentProvider.trim())) {
		throw new Error(
			`assignDisplayAlias: received route abbreviation '${agentProvider}' as agentProvider. ` +
			`Pass model_routes.agent_provider (e.g. 'Claude', 'Codex') instead.`,
		);
	}

	// Normalize provider name (trim, PascalCase each whitespace-delimited word)
	const normalizedProvider = agentProvider
		.trim()
		.split(/\s+/)
		.map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
		.join("");

	// Tier 1: Liaison (slot 0..9, no expertise hint)
	if (slotChar && LIAISON_SLOTS.includes(slotChar) && !expertise) {
		return `${normalizedProvider}-${hostId}`;
	}

	// Tier 2: Expert slot-a with expertise — use algorithmic Title-Case, not
	// the EXPERTISE code table (which is for routing, not display).
	if (slotChar === "a" && expertise) {
		const expLabel = titleCaseExpertise(expertise);
		return `${normalizedProvider}-${hostId}-${expLabel}`;
	}

	// Tier 3+: Rotated slots (b, c, ...) → no alias
	return null;
}

/**
 * P932: Normalise a host token into PascalCase for display aliases.
 *   "bot" → "Bot"
 *   "hermes-srv" → "HermesSrv"
 *   "agency-bot" → "AgencyBot"
 * Idempotent on already-PascalCase input ("Bot" → "Bot").
 */
export function pascalCaseHost(host: string): string {
	return host
		.split(/[-_]+/)
		.filter(Boolean)
		.map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
		.join("");
}
