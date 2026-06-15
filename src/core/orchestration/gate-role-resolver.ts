/**
 * P609: Per-(type × gate) gate-role resolver.
 *
 * BOUNDARY (P909 / CONVENTIONS.md §6.0f): this file is NOT a duplicate of
 * role-resolver.ts (P748). It owns a distinct key space and semantic layer:
 *   - Key:   (proposal_type, gate) — e.g. ("feature", "D1")
 *   - Table: roadmap_proposal.gate_role
 *   - Cache: NOTIFY gate_role_changed (live invalidation)
 *   - Stores complete agent personas (D1–D4 behavioral checklists)
 * role-resolver.ts uses (workflow_template_id, stage, maturity) and has no
 * gate-D1–D4 enumeration concept. Do not merge these two resolvers.
 *
 * Resolves the agent profile for a given (proposal_type, gate) pair.
 * Two-tier lookup: DB cache → BUILTIN_FALLBACK (identical to GATE_ROLES in orchestrator.ts).
 * Two-level mutex mirrors StateNamesRegistry pattern in state-names.ts:
 *   - Instance-level inner guard: GateRoleRegistry.loadInFlight serializes load() calls.
 *   - Module-level outer guard: resolvingPromise serializes getGateRoleRegistry() calls.
 *
 * NOTIFY-triggered cache invalidation: GateRoleRegistry subscribes to the
 * 'gate_role_changed' channel and reloads on each notification.
 *
 * Phase 1 (P609): shadow-mode only. orchestrator.ts still uses GATE_ROLES as
 * authoritative source and logs divergence. Phase 2 removes GATE_ROLES after
 * ≥24h shadow-mode zero-divergence window (AC-17).
 */

import type { Pool, PoolClient } from "pg";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";

/**
 * Minimal query function type for test injection and internal use.
 */
export type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface GateRoleProfile {
	role: string;
	persona: string;
	outputContract: string;
	modelPreference: string | null;
	toolAllowList: string[] | null;
	fallbackRole: string | null;
	source: "db-cache" | "db-fresh" | "builtin-fallback";
}

// BUILTIN_FALLBACK: identical to GATE_ROLES in orchestrator.ts.
// Used when the DB is unreachable or the row is missing.
// persona = identity + what-to-check checklist (mirrors GATE_ROLES framing up to OUTPUT CONTRACT).
// outputContract = the OUTPUT CONTRACT section of the same framing.
// NOTE: Agent role names ("skeptic-alpha", etc.) are fallback constants; canonical values
// come from roadmap.gate_role table (DB cache). The DB lookup fails gracefully to this table.
const BUILTIN_FALLBACK: Record<string, Omit<GateRoleProfile, "source">> = {
	D1: {
		role: "skeptic-alpha",
		persona:
			"You are SKEPTIC ALPHA gating DRAFT → REVIEW. Your job is to validate the SPEC, not the IMPLEMENTATION. " +
			"At this gate the design + AC list are authoritative; the migration files, TS modules, and tests are NOT YET expected to exist on disk. " +
			"DEVELOP commits them later (D3 is where missing/uncommitted artifacts become a hold).\n\n" +
			"What you check at D1 — every item below is a real P592–P607 failure mode you must call out by name when found:\n" +
			"  1. AC ACCRETION: list_criteria + read the design body. If the body says \"AC-N supersedes AC-M\" or \"Addendum X declares Y VOID\" while AC-M is still a live row in proposal_acceptance_criteria, that's a hard hold — DEVELOP cannot follow two contradictory ACs. Cite both item_numbers and require delete_criteria.\n" +
			"  2. PHANTOM COLUMNS in EXISTING tables: any column the design names on a table that already exists must appear in information_schema.columns. (Columns the design proposes to add via its own migration are fine — those don't exist yet by definition.)\n" +
			"  3. INTERNAL CONTRADICTION: scan the design for sync-vs-async, two hash formulas, two table-name lists, conflicting type signatures. Pick-one-and-delete-the-other is the only valid resolution; annotation prose (\"VOID\", \"superseded\") with both versions still present = hold.\n" +
			"  4. DEAD VOCABULARY: a CHECK constraint that hardcodes a literal list while a sibling table claims to be the canonical vocabulary = hold (the table enforces nothing).\n" +
			"  5. MISSING GRANTS in the proposed migration: if an AC requires UPDATE on a column, the migration's GRANT block must include UPDATE. Read the migration that the proposal SHIPS, not what's already in the repo.\n" +
			"  6. INVALID FK TARGETS: when the design declares `REFERENCES schema.table(col)` against a table that already exists, verify (col) is the PK or a UNIQUE column; if it doesn't exist or isn't unique, hold.\n\n" +
			"What you DO NOT check at D1 (these are D3 concerns — explicitly out of scope here):\n" +
			"  - Whether the migration / DDL / TS / test files have been committed to a branch (git ls-files / git log --all). They don't have to exist yet at DRAFT.\n" +
			"  - Whether the implementation runs, the tests pass, or the spending log shows actual cost.\n" +
			"  - Whether unrelated proposals' artifacts are floating in the worktree (worktree hygiene is an ops concern, not a spec concern).\n" +
			"If you find a coherent, source-verified spec with measurable ACs, ADVANCE — even if not a single line of code has been written.",
		outputContract:
			"Emit a clear final-line decision and structured findings to STDOUT — the orchestrator parses your stdout and persists it into gate_decision_log. " +
			"For HOLD/REJECT, output a `## Failures` section (one bullet per blocker, severity tag, file:line evidence where possible) AND populate `ac_verification.details` JSONB array (each entry: {item_number, status, evidence}). " +
			"Also call `mcp_proposal action=add_discussion context_prefix=gate-decision:` with the same body. The enhancing agent reads stdout AND the discussion thread.",
		modelPreference: null,
		toolAllowList: null,
		fallbackRole: null,
	},
	D2: {
		role: "architecture-reviewer",
		persona:
			"You are the Architecture Reviewer gating REVIEW → DEVELOP. Validate the design is buildable: dependencies satisfied, integration constraints respected, scalability and rollback paths sound. " +
			"At this gate you assume the spec is internally coherent (D1 already enforced that). You're checking whether a developer agent can pick this up and implement without surprises.\n\n" +
			"What you check at D2:\n" +
			"  - Dependency graph: every blocking proposal in proposal_dependencies is resolved or scheduled.\n" +
			"  - Cross-proposal coherence: FK targets, shared schemas, role names, env vars match what sibling proposals expect.\n" +
			"  - Rollback / migration safety: destructive operations are reversible or explicitly accepted.\n" +
			"  - Cost / capacity envelope: any new index, table, or function is sized for current traffic.\n\n" +
			"What you DO NOT check at D2 (deferred to D3):\n" +
			"  - Whether the migration file has been committed yet. The DEVELOP phase that follows D2 is where commits land.\n" +
			"  - Whether the tests pass or coverage is sufficient.",
		outputContract:
			"For non-advance verdicts, emit `## Failures` + `## Remediation` to stdout so the next enhancing agent can act.",
		modelPreference: null,
		toolAllowList: null,
		fallbackRole: null,
	},
	D3: {
		role: "skeptic-beta",
		persona:
			"You are SKEPTIC BETA gating DEVELOP → MERGE. The spec was already validated upstream; you validate the IMPLEMENTATION. " +
			"Files must exist on disk and be tracked by git. Tests must pass. ACs must be met against running code, not against prose.\n\n" +
			"What you check at D3 (this is the right gate for these — they are NOT D1 concerns):\n" +
			"  - ARTIFACT EXISTENCE: every file the design promised must be tracked. Verify with `git log --all -- <path>` returning ≥1 SHA. Untracked files = hold.\n" +
			"  - MIGRATION SLOT COLLISIONS: the migration file's slot number must not be taken by another committed migration. Verify against the migrations directory.\n" +
			"  - WORKTREE HYGIENE: only this proposal's deliverables should be uncommitted in this branch — sibling-proposal artifacts must be moved before merge.\n" +
			"  - TEST COVERAGE: every AC has at least one passing test that exercises its assertion. Run `npm test` (or the relevant suite) and inspect output.\n" +
			"  - RUNTIME CORRECTNESS: apply the migration to a scratch DB, exercise the SECURITY DEFINER functions, confirm no permission-denied errors and no broken FK chains.\n" +
			"  - AC VERIFICATION: each AC must be verified against the live system, not just against its own text. Populate ac_verification.details with item_number, status, and concrete evidence (test name, query result, file:line).",
		outputContract:
			"Emit `## Failures` + `## Remediation` to stdout for non-advance verdicts. ac_verification.details is mandatory at D3.",
		modelPreference: null,
		toolAllowList: null,
		fallbackRole: null,
	},
	D4: {
		role: "gate-reviewer",
		persona:
			"You are the Integration Reviewer. Validate that the merge is clean, tests pass, and the feature is deployable. " +
			"Only advance if the integration is stable.",
		outputContract:
			"Emit `## Failures` + `## Remediation` to stdout for non-advance verdicts.",
		modelPreference: null,
		toolAllowList: null,
		fallbackRole: null,
	},
};

type CacheKey = string; // `${proposalType}:${gate}`

class GateRoleRegistry {
	private profiles = new Map<CacheKey, GateRoleProfile>();
	private notifySubscription: {
		client: PoolClient;
		unsubscribe: () => Promise<void>;
	} | null = null;

	// Instance-level inner mutex — serializes concurrent load() calls (mirrors
	// StateNamesRegistry.loadInFlight at state-names.ts:107).
	private loadInFlight: Promise<void> | null = null;

	async load(pool: Pool): Promise<void> {
		if (this.loadInFlight) {
			return this.loadInFlight;
		}
		this.loadInFlight = this.loadInner(pool).finally(() => {
			this.loadInFlight = null;
		});
		return this.loadInFlight;
	}

	private async loadInner(pool: Pool): Promise<void> {
		const result = await pool.query<{
			proposal_type: string;
			gate: string;
			role: string;
			persona: string;
			output_contract: string;
			model_preference: string | null;
			tool_allow_list: string[] | null;
			fallback_role: string | null;
		}>(
			`SELECT proposal_type, gate, role, persona, output_contract,
			        model_preference, tool_allow_list, fallback_role
			   FROM roadmap_proposal.gate_role
			  WHERE lifecycle_status = 'active'
			  ORDER BY proposal_type, gate`,
		);

		this.profiles.clear();
		for (const row of result.rows) {
			const key: CacheKey = `${row.proposal_type}:${row.gate}`;
			this.profiles.set(key, {
				role: row.role,
				persona: row.persona,
				outputContract: row.output_contract,
				modelPreference: row.model_preference,
				toolAllowList: row.tool_allow_list,
				fallbackRole: row.fallback_role,
				source: "db-cache",
			});
		}

		// Subscribe to NOTIFY for cache invalidation. Mirrors StateNamesRegistry
		// pattern — one PoolClient per registry instance, replaced on reload.
		await this.setupNotify(pool);
	}

	private async setupNotify(pool: Pool): Promise<void> {
		// Release prior subscription if any (prevents PoolClient leak on reload).
		if (this.notifySubscription) {
			try {
				await this.notifySubscription.unsubscribe();
			} catch {
				// Best-effort; the client may already be gone.
			}
			this.notifySubscription = null;
		}

		const client = await pool.connect();
		try {
			await client.query("LISTEN gate_role_changed");
			const onNotify = () => {
				// Fire-and-forget reload; inner mutex serializes concurrent notifications.
				this.load(pool).catch((err) => {
					console.error("[GateRoleResolver] NOTIFY reload failed:", err);
				});
			};
			client.on("notification", onNotify);

			this.notifySubscription = {
				client,
				unsubscribe: async () => {
					client.removeListener("notification", onNotify);
					try {
						await client.query("UNLISTEN gate_role_changed");
					} finally {
						client.release();
					}
				},
			};
		} catch (err) {
			client.release();
			throw err;
		}
	}

	resolve(
		proposalType: string,
		gate: string,
	): GateRoleProfile {
		const specific = this.profiles.get(`${proposalType}:${gate}`);
		if (specific) return specific;

		const fallback = BUILTIN_FALLBACK[gate];
		if (fallback) return { ...fallback, source: "builtin-fallback" };

		return {
			role: "gate-reviewer",
			persona: "Generic gate reviewer.",
			outputContract: "Emit ADVANCE/HOLD.",
			modelPreference: null,
			toolAllowList: null,
			fallbackRole: null,
			source: "builtin-fallback",
		};
	}

	async dispose(): Promise<void> {
		if (this.notifySubscription) {
			try {
				await this.notifySubscription.unsubscribe();
			} catch {
				// Best-effort.
			}
			this.notifySubscription = null;
		}
	}
}

// ─── Module-level state ───────────────────────────────────────────────────────

let globalGateRoleRegistry: GateRoleRegistry | null = null;

// Module-level outer mutex — serializes concurrent getGateRoleRegistry() calls
// (mirrors loadingPromise at state-names.ts:417).
let resolvingPromise: Promise<GateRoleRegistry> | null = null;

/**
 * Load (or reload) the gate-role registry from the DB.
 *
 * Concurrent callers receive the same in-flight Promise — only ONE
 * GateRoleRegistry is created per "load wave". Subsequent waves dispose the
 * prior global before installing a new one.
 *
 * AC-33: if the DB is unreachable at startup, catches the error, logs a WARNING,
 * resets resolvingPromise to null (so a subsequent call can retry), and returns a
 * registry whose resolve() always falls back to BUILTIN_FALLBACK.
 */
export async function getGateRoleRegistry(pool: Pool): Promise<GateRoleRegistry> {
	if (resolvingPromise) return resolvingPromise;

	resolvingPromise = (async () => {
		try {
			if (globalGateRoleRegistry) {
				await globalGateRoleRegistry.dispose();
			}
			const reg = new GateRoleRegistry();
			await reg.load(pool);
			globalGateRoleRegistry = reg;
			return reg;
		} catch (err) {
			// AC-33: DB unavailable at startup — fall back silently.
			console.warn(
				"[GateRoleResolver] gate_role DB unavailable at startup — falling back to BUILTIN_FALLBACK:",
				err instanceof Error ? err.message : err,
			);
			// Install an empty registry that will resolve everything via BUILTIN_FALLBACK.
			const fallbackReg = new GateRoleRegistry();
			globalGateRoleRegistry = fallbackReg;
			return fallbackReg;
		} finally {
			// Always reset so a subsequent call can retry (AC-33).
			resolvingPromise = null;
		}
	})();

	return resolvingPromise;
}

/**
 * Resolve the gate-role profile for (proposalType, gate).
 *
 * Uses the module-level cached registry. Falls back to BUILTIN_FALLBACK if the
 * registry is not yet loaded or the DB row is missing. Never throws.
 */
export async function resolveGateRole(
	proposalType: string,
	gate: "D1" | "D2" | "D3" | "D4",
	pool: Pool,
): Promise<GateRoleProfile> {
	try {
		const registry = globalGateRoleRegistry ?? (await getGateRoleRegistry(pool));
		return registry.resolve(proposalType, gate);
	} catch (err) {
		console.warn(
			`[GateRoleResolver] resolve failed for ${proposalType}:${gate}, using BUILTIN_FALLBACK:`,
			err instanceof Error ? err.message : err,
		);
		const fallback = BUILTIN_FALLBACK[gate];
		return fallback
			? { ...fallback, source: "builtin-fallback" }
			: {
					role: "gate-reviewer",
					persona: "Generic gate reviewer.",
					outputContract: "Emit ADVANCE/HOLD.",
					modelPreference: null,
					toolAllowList: null,
					fallbackRole: null,
					source: "builtin-fallback",
				};
	}
}

/**
 * Resolve a behavioral persona string from a role name alone (no proposal_type/gate pair).
 *
 * Precedence order (P1392):
 *   1. File-based Tier-1 (~/. claude/agents/*.md) — new in P1392, highest priority.
 *   2. BUILTIN_FALLBACK — match on role name (e.g. 'skeptic-alpha' → D1 persona).
 *   3. gate_role table   — WHERE role = $1 AND lifecycle_status = 'active' LIMIT 1.
 *   4. agent_role_profile — WHERE role = $1, reads prompt_template->>'system' LIMIT 1.
 *
 * Returns null when no persona is found (caller degrades gracefully — no persona
 * prepended to the task string).  Never throws.
 */
export async function resolvePersonaByRoleName(
	roleName: string,
	queryFn: QueryFn = defaultQuery as QueryFn,
): Promise<string | null> {
	// P1392: 1. File-based Tier-1 — highest priority
	try {
		const { resolveFilePersona } = await import(
			"./file-persona-resolver.ts"
		);
		const filePersona = await resolveFilePersona(roleName);
		if (filePersona) {
			return filePersona.body;
		}
	} catch (err) {
		console.warn(
			`[GateRoleResolver] file-based persona lookup failed for '${roleName}' (non-fatal):`,
			err instanceof Error ? err.message : err,
		);
	}

	// 2. BUILTIN_FALLBACK: scan values to find a matching role name.
	for (const entry of Object.values(BUILTIN_FALLBACK)) {
		if (entry.role === roleName) return entry.persona;
	}

	try {
		// 3. gate_role table — keyed by (proposal_type, gate) but also has role column.
		const gateResult = await queryFn(
			`SELECT persona
			   FROM roadmap_proposal.gate_role
			  WHERE role = $1 AND lifecycle_status = 'active'
			  LIMIT 1`,
			[roleName],
		);
		const gatePersona = gateResult.rows[0]?.persona;
		if (typeof gatePersona === "string" && gatePersona.length > 0) {
			return gatePersona;
		}

		// 4. agent_role_profile — wider role registry; system prompt lives in JSONB.
		const profileResult = await queryFn(
			`SELECT prompt_template->>'system' AS persona
			   FROM roadmap.agent_role_profile
			  WHERE role = $1
			  LIMIT 1`,
			[roleName],
		);
		const profilePersona = profileResult.rows[0]?.persona;
		if (typeof profilePersona === "string" && profilePersona.length > 0) {
			return profilePersona;
		}
	} catch (err) {
		console.warn(
			`[GateRoleResolver] resolvePersonaByRoleName(${roleName}) DB lookup failed — returning null:`,
			err instanceof Error ? err.message : err,
		);
	}

	return null;
}

export { BUILTIN_FALLBACK, GateRoleRegistry };
