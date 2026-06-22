// P4509: Canonical operator-action vocabulary + shared validation.
//
// This module is the SINGLE source of truth for which action strings an
// operator token may carry in `roadmap.operator_token.allowed_actions`. It is
// imported by:
//   * the API token-issue endpoint (src/apps/server/index.ts handleIssueOperatorToken)
//   * the CLI bootstrap script    (scripts/operator-token.ts)
//   * the authorization path tests (src/apps/server/operator-auth.test.ts)
//
// Sharing one validator is AC-2 of P4509: an unknown / typo'd action string
// (e.g. "suspendagency", "drain_host", "control.stp") is rejected at issue/
// update time on BOTH surfaces, so a token can never be minted with a scope
// that no handler will ever check.
//
// ── Background ───────────────────────────────────────────────────────────────
// Before P4509 the four destructive control endpoints (suspend-agency,
// drain-host, cancel-dispatch, terminate-worker) all authorized on the single
// coarse `control.stop` scope. P4509 narrows each to its own canonical action
// so a token can be granted exactly the blast radius it needs (least
// privilege). The generic `POST /api/operator/control/stop` verb keeps
// `control.stop`.
//
// IMPORTANT — `control.stop` is NOT a parent/umbrella scope. After the P4509
// migration, an EXACT-MATCH `control.stop` grant authorizes ONLY the generic
// stop endpoint. The four granular endpoints require their own granular action
// (or the `*` wildcard). The migration (scripts/migrations/316-…) is what
// preserves backward compatibility for pre-existing `control.stop` tokens by
// expanding them to also carry the four granular actions.

/**
 * The four canonical granular destructive control actions introduced by P4509.
 * Each maps 1:1 to a destructive operator control endpoint.
 */
export const GRANULAR_CONTROL_ACTIONS = [
	"suspend-agency",
	"drain-host",
	"cancel-dispatch",
	"terminate-worker",
] as const;

export type GranularControlAction = (typeof GRANULAR_CONTROL_ACTIONS)[number];

/**
 * The generic stop scope. Retained by `POST /api/operator/control/stop` only.
 * Explicitly NOT a parent of the granular actions (no implicit expansion).
 */
export const GENERIC_STOP_ACTION = "control.stop";

/**
 * The full wildcard grant. A token carrying this authorizes every action but
 * is a "concentrated credential" — its use against a destructive endpoint is
 * audited explicitly (AC-6 of P4509).
 */
export const WILDCARD_ACTION = "*";

/**
 * The complete set of action strings a token may legitimately carry.
 *
 * This is intentionally an allowlist of the operator-control vocabulary plus
 * the broader operator surface actions already in production use (config/flag/
 * token/agent/cubic/state-machine/gate/etc.). The validation accepts:
 *   - the wildcard `*`
 *   - any action containing a dot (namespaced, e.g. `config.read`, `agency.pause`)
 *     OR ending with a recognized verb — these are the pre-P4509 conventions
 *   - the four explicit granular control actions
 *
 * The strict-canonical set below is what the granular control authorization
 * checks against; the broader acceptance rule below it keeps existing scopes
 * (config.read, token.issue, agent.message, …) valid without enumerating all
 * of them (that surface is large and evolving — see index.ts route table).
 */
const STRICT_CANONICAL_CONTROL_ACTIONS: ReadonlySet<string> = new Set<string>([
	GENERIC_STOP_ACTION,
	...GRANULAR_CONTROL_ACTIONS,
]);

// Pre-P4509 operator actions are dotted/namespaced (e.g. `config.read`,
// `agency.pause`, `state-machine.halt`). The granular control actions are the
// ONLY non-dotted multi-word actions we mint, so the acceptance rule is:
//   * `*` wildcard, OR
//   * a known strict-canonical control action, OR
//   * a dotted namespaced action matching the existing convention.
// Everything else (typos, unknown bare words) is rejected.
const NAMESPACED_ACTION_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;

export interface ActionValidationResult {
	ok: boolean;
	/** Normalized (trimmed) actions when ok. */
	actions: string[];
	/** The offending entries when not ok. */
	invalid: string[];
	/** Human-readable message describing the failure. */
	message: string | null;
}

/** True if a single action string is canonical / acceptable. */
export function isValidOperatorAction(action: string): boolean {
	const a = action.trim();
	if (a.length === 0) return false;
	if (a === WILDCARD_ACTION) return true;
	if (STRICT_CANONICAL_CONTROL_ACTIONS.has(a)) return true;
	return NAMESPACED_ACTION_RE.test(a);
}

/**
 * Validate (and normalize) an `allowed_actions` list at token issue/update time.
 *
 * Rejects empty lists, non-string entries, and any unrecognized / typo'd
 * action. Returns the trimmed list on success. This is the SHARED validator
 * referenced by AC-2 — both the CLI and the API call it before INSERT.
 */
export function validateAllowedActions(raw: unknown): ActionValidationResult {
	if (!Array.isArray(raw) || raw.length === 0) {
		return {
			ok: false,
			actions: [],
			invalid: [],
			message: "allowed_actions must be a non-empty array of action strings",
		};
	}
	const invalid: string[] = [];
	const actions: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			invalid.push(String(entry));
			continue;
		}
		const a = entry.trim();
		if (!isValidOperatorAction(a)) {
			invalid.push(entry);
			continue;
		}
		actions.push(a);
	}
	if (invalid.length > 0) {
		return {
			ok: false,
			actions: [],
			invalid,
			message:
				`unknown or malformed operator action(s): ${invalid.join(", ")}. ` +
				`Granular control actions are: ${GRANULAR_CONTROL_ACTIONS.join(", ")}; ` +
				`use '${WILDCARD_ACTION}' for full powers or a dotted namespaced action ` +
				`(e.g. config.read, agency.pause).`,
		};
	}
	return { ok: true, actions, invalid: [], message: null };
}

/**
 * AC-6 support: is this action one of the destructive control actions whose
 * use under a wildcard grant should emit a concentrated-credential audit event?
 */
export function isDestructiveControlAction(action: string): boolean {
	return STRICT_CANONICAL_CONTROL_ACTIONS.has(action.trim());
}

/**
 * Canonical filename of the P4509 token-backfill migration. The granular
 * handler authorization MUST NOT activate until this migration is recorded in
 * the canonical migration ledger (roadmap.schema_migration), otherwise a
 * pre-existing `control.stop`-only token would lose access to the four
 * destructive endpoints (AC-7 deployment ordering).
 */
export const P4509_BACKFILL_MIGRATION_FILENAME =
	"316-p4509-operator-granular-control-backfill.sql";

// Module-scoped memo so the ledger lookup runs at most once per process after
// it first succeeds (the migration is immutable once applied). A failed/absent
// lookup is re-checked on the next call so a mid-flight deploy can flip it on
// without a restart.
let _backfillLedgeredMemo: boolean | null = null;

/**
 * AC-7: returns true once the P4509 token-backfill migration is recorded in the
 * canonical migration ledger. When false, destructive handlers stay on the
 * legacy `control.stop` check (no cutover) so backward compatibility holds.
 *
 * `runQuery` is injected to avoid a hard import cycle with the pg pool and to
 * keep this module unit-testable.
 */
export async function isGranularControlCutoverEnabled(
	runQuery: <T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	) => Promise<{ rows: T[] }>,
): Promise<boolean> {
	if (_backfillLedgeredMemo === true) return true;
	// Allow operators to force-disable the cutover during a rollback window
	// without touching the ledger (AC-7 rollback path).
	if (process.env.AGENTHIVE_P4509_GRANULAR_DISABLE === "1") return false;
	try {
		const { rows } = await runQuery<{ cnt: string }>(
			`SELECT COUNT(*)::int AS cnt
			   FROM roadmap.schema_migration
			  WHERE filename = $1`,
			[P4509_BACKFILL_MIGRATION_FILENAME],
		);
		const ok = Number(rows[0]?.cnt ?? 0) > 0;
		if (ok) _backfillLedgeredMemo = true;
		return ok;
	} catch {
		// Ledger unreachable → fail safe to legacy behavior (no cutover).
		return false;
	}
}

/** Test-only: reset the cutover memo between cases. */
export function __resetCutoverMemoForTests(): void {
	_backfillLedgeredMemo = null;
}

/**
 * Resolve the action a destructive control handler should authorize against,
 * given whether the cutover is enabled. Pre-cutover → legacy `control.stop`;
 * post-cutover → the granular action. Centralizing this keeps all four handlers
 * consistent and makes rollback a one-line behavior flip.
 */
export function resolveControlAction(
	granular: GranularControlAction,
	cutoverEnabled: boolean,
): string {
	return cutoverEnabled ? granular : GENERIC_STOP_ACTION;
}
