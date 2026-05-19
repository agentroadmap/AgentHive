export interface PermanentAgentMapping {
	/** Human-friendly registration name, lower-case. */
	name: string;
	/** Optional expertise suffix, e.g. dev, ts, test. */
	expertise?: string;
	/** Provider-qualified permanent role suffix: a=agency, l=liaison. */
	permanentRole?: "agency" | "liaison";
	/** Stable routing identity stored in agent_registry and used for A2A. */
	agentIdentity: string;
	/** Agent provider / CLI family. */
	provider: PermanentAgentProvider;
	/** Host where the permanent agent is expected to run. */
	host: string;
	/** Human display label. */
	displayName: string;
	/** Human-facing short label, e.g. clark.dev or alan.dev@iMac. */
	label: string;
	/** Coarse role family used by Claude name pools. */
	roleFamily?: "builder" | "skeptic";
}

export type PermanentAgentProvider =
	| "claude"
	| "codex"
	| "gemini"
	| "copilot"
	| "hermes";

const CLAUDE_BOT_NAMES = [
	"adam",
	"andy",
	"alan",
	"alex",
	"andrew",
	"alice",
	"ana",
] as const;

const CLAUDE_BUILDER_NAMES = ["adam", "andy", "alan", "alex", "andrew"] as const;
const CLAUDE_SKEPTIC_NAMES = ["alice", "ana"] as const;

const CODEX_BOT_NAMES = [
	"cooper",
	"carter",
	"calvin",
	"clark",
	"cory",
	"chloe",
] as const;

const GEMINI_BOT_NAMES = ["gabriel", "george", "graham", "grant", "grace", "gwen"] as const;
const COPILOT_BOT_NAMES = ["peter", "patrick", "paul", "preston", "paige", "piper"] as const;
const HERMES_BOT_NAMES = ["henry", "harry", "harrison", "hudson", "hannah", "hazel"] as const;

const PROVIDER_BY_INITIAL: Record<string, PermanentAgentProvider> = {
	a: "claude",
	c: "codex",
	g: "gemini",
	p: "copilot",
	h: "hermes",
};

const PROVIDERS = new Set<PermanentAgentProvider>([
	"claude",
	"codex",
	"gemini",
	"copilot",
	"hermes",
]);

const PERMANENT_ROLE_BY_SUFFIX = {
	a: "agency",
	l: "liaison",
} as const;

function titleCaseName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function slugToken(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function normalizeHost(host: string): string {
	return slugToken(host) || "bot";
}

function buildAgentIdentity(
	provider: PermanentAgentProvider,
	name: string,
	expertise: string | undefined,
	host: string,
): string {
	const local = expertise ? `${name}.${expertise}` : name;
	return host === "bot" ? `${provider}/${local}` : `${provider}/${local}:${host}`;
}

function buildLabel(name: string, expertise: string | undefined, host: string): string {
	const local = expertise ? `${name}.${expertise}` : name;
	return host === "bot" ? local : `${local}@${host}`;
}

function inferRoleFamily(name: string): PermanentAgentMapping["roleFamily"] {
	if ((CLAUDE_BUILDER_NAMES as readonly string[]).includes(name)) return "builder";
	if ((CLAUDE_SKEPTIC_NAMES as readonly string[]).includes(name)) return "skeptic";
	return undefined;
}

function buildMappings(
	provider: PermanentAgentProvider,
	names: readonly string[],
): PermanentAgentMapping[] {
	return names.map((name) => ({
		name,
		agentIdentity: buildAgentIdentity(provider, name, undefined, "bot"),
		provider,
		host: "bot",
		displayName: titleCaseName(name),
		label: name,
		roleFamily: provider === "claude" ? inferRoleFamily(name) : undefined,
	}));
}

export const PERMANENT_AGENT_MAPPINGS: readonly PermanentAgentMapping[] = [
	...buildMappings("claude", CLAUDE_BOT_NAMES),
	...buildMappings("codex", CODEX_BOT_NAMES),
	...buildMappings("gemini", GEMINI_BOT_NAMES),
	...buildMappings("copilot", COPILOT_BOT_NAMES),
	...buildMappings("hermes", HERMES_BOT_NAMES),
];

const BY_NAME = new Map(
	PERMANENT_AGENT_MAPPINGS.map((mapping) => [mapping.name, mapping]),
);
const BY_IDENTITY = new Map(
	PERMANENT_AGENT_MAPPINGS.map((mapping) => [
		mapping.agentIdentity,
		mapping,
	]),
);

function parsePermanentAgentLabel(input: string): PermanentAgentMapping | null {
	const [localRaw, hostRaw] = input.trim().split("@", 2);
	if (!localRaw) return null;
	const parts = localRaw.split(".");
	const providerQualified = parseProviderQualifiedLabel(parts, hostRaw);
	if (providerQualified) return providerQualified;

	const [nameRaw, expertiseRaw] = parts;
	const name = slugToken(nameRaw);
	if (!name) return null;
	const provider = PROVIDER_BY_INITIAL[name.charAt(0)];
	if (!provider) return null;
	const expertise = expertiseRaw ? slugToken(expertiseRaw) : undefined;
	const host = hostRaw ? normalizeHost(hostRaw) : "bot";
	const roleFamily = provider === "claude" ? inferRoleFamily(name) : undefined;
	return {
		name,
		expertise,
		agentIdentity: buildAgentIdentity(provider, name, expertise, host),
		provider,
		host,
		displayName: titleCaseName(name),
		label: buildLabel(name, expertise, hostRaw?.trim() || host),
		roleFamily,
	};
}

function parseProviderQualifiedLabel(
	parts: string[],
	hostRaw: string | undefined,
): PermanentAgentMapping | null {
	if (parts.length < 2 || parts.length > 3) return null;
	const provider = slugToken(parts[0]) as PermanentAgentProvider;
	if (!PROVIDERS.has(provider)) return null;
	const roleSuffix = slugToken(parts[parts.length - 1]);
	const permanentRole =
		PERMANENT_ROLE_BY_SUFFIX[
			roleSuffix as keyof typeof PERMANENT_ROLE_BY_SUFFIX
		];
	if (!permanentRole) return null;
	const owner = parts.length === 3 ? slugToken(parts[1]) : undefined;
	if (parts.length === 3 && !owner) return null;
	const host = hostRaw ? normalizeHost(hostRaw) : "bot";
	const local = owner
		? `${provider}.${owner}.${roleSuffix}`
		: `${provider}.${roleSuffix}`;
	return {
		name: owner ?? provider,
		permanentRole,
		agentIdentity: host === "bot" ? local : `${local}:${host}`,
		provider,
		host,
		displayName: owner ? titleCaseName(owner) : titleCaseName(provider),
		label: hostRaw?.trim() ? `${local}@${hostRaw.trim()}` : local,
	};
}

export function resolvePermanentAgentMapping(
	input: string | undefined | null,
): PermanentAgentMapping | null {
	const raw = input?.trim();
	if (!raw) return null;
	const key = raw.toLowerCase();
	return BY_NAME.get(key) ?? BY_IDENTITY.get(key) ?? parsePermanentAgentLabel(raw);
}

export function resolvePermanentAgentIdentity(input: string): string {
	return resolvePermanentAgentMapping(input)?.agentIdentity ?? input;
}

export function isPermanentAgent(input: string): boolean {
	return resolvePermanentAgentMapping(input) !== null;
}
