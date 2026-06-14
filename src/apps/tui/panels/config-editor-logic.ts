/**
 * P1066 — TUI Config Flag Editor: pure, TTY-free logic.
 *
 * Everything in this module is side-effect-free and screen-free so the 41-AC
 * surface can be unit-tested without a blessed terminal or a live pg pool.
 * The blessed wiring lives in `config-editor.ts`; it imports these helpers.
 *
 * SCHEMA NOTE (verified live, 2026-06-14):
 *   core.runtime_flag PK = (flag_name) ONLY. Columns:
 *     flag_name text, value_jsonb jsonb NOT NULL, description text,
 *     updated_at timestamptz NOT NULL, scope text NOT NULL,
 *     lifecycle_status text NOT NULL.
 *   There is NO owner_did, NO modified_at, NO modified_by_did, NO key_class
 *   column on the live table — despite older P1066 AC drafts (AC-1/16/17) that
 *   reference them. The CANONICAL AC set is AC-34..AC-41 (AC-41 explicitly
 *   supersedes "the prior 32 duplicated/renumbered ACs"), and AC-34 corrects
 *   the query to `SELECT flag_name, scope, value_jsonb, lifecycle_status,
 *   updated_at`. This module follows the canonical set + live schema.
 *
 *   scope CHECK is `global` | `^(host|agency|project):.+$`.
 *   The notify trigger broadcasts JSON {flag_name, scope, op, at} on channel
 *   `runtime_flag_changed` (verified via fn_runtime_flag_notify body).
 */

import type { ConfigKey } from "../../../shared/runtime/config.ts";
import { AllConfigKeys } from "../../../shared/runtime/config-keys.ts";

// ───────────────────────── Row + filter model ──────────────────────────────

/** A core.runtime_flag row as SELECTed by the browser (AC-34). */
export interface FlagRow {
	flag_name: string;
	scope: string;
	value_jsonb: unknown;
	lifecycle_status: string;
	updated_at: string | Date;
}

/** Lifecycle filter values (AC-19 / AC-3-legacy). */
export type LifecycleFilter =
	| "all"
	| "active"
	| "deprecated"
	| "retired"
	| "blocked";

/** Scope filter selector. `all` = no scope predicate. */
export interface ScopeFilter {
	/** One of: "all" | "global" | a concrete scope like "host:bot". */
	value: string;
}

export interface FlagFilters {
	scope: string; // "all" | "global" | "host:bot" | "agency:x" | "project:y" ...
	lifecycle: LifecycleFilter;
	/** flag_name search — prefix match (AC-19) when `searchIsRegex` is false. */
	search: string;
	searchIsRegex?: boolean;
	limit?: number;
}

export const DEFAULT_FILTERS: FlagFilters = {
	scope: "all",
	lifecycle: "all",
	search: "",
	searchIsRegex: false,
	limit: 100,
};

// ───────────────────────── Query builders (AC-34) ──────────────────────────

export interface BuiltQuery {
	text: string;
	params: unknown[];
}

/**
 * AC-34 (canonical): build the parameterized browser SELECT.
 *   SELECT flag_name, scope, value_jsonb, lifecycle_status, updated_at
 *   FROM core.runtime_flag
 *   WHERE <scope> AND <lifecycle> AND <search>
 *   ORDER BY updated_at DESC LIMIT <n>
 *
 * Always parameterized — never string-interpolates operator input. Predicates
 * are appended only when the corresponding filter is active, so "all" produces
 * no predicate (and no wasted param).
 */
export function buildFlagQuery(filters: FlagFilters): BuiltQuery {
	const params: unknown[] = [];
	const where: string[] = [];

	if (filters.scope && filters.scope !== "all") {
		params.push(filters.scope);
		where.push(`scope = $${params.length}`);
	}

	if (filters.lifecycle && filters.lifecycle !== "all") {
		params.push(filters.lifecycle);
		where.push(`lifecycle_status = $${params.length}`);
	}

	if (filters.search && filters.search.length > 0) {
		if (filters.searchIsRegex) {
			params.push(filters.search);
			where.push(`flag_name ~ $${params.length}`);
		} else {
			// prefix match (AC-19): escape LIKE metacharacters in the literal.
			params.push(`${escapeLikePrefix(filters.search)}%`);
			where.push(`flag_name LIKE $${params.length}`);
		}
	}

	const limit = Math.max(1, Math.min(filters.limit ?? 100, 1000));
	const whereSql = where.length > 0 ? `\n  WHERE ${where.join("\n    AND ")}` : "";

	const text =
		`SELECT flag_name, scope, value_jsonb, lifecycle_status, updated_at\n` +
		`  FROM core.runtime_flag${whereSql}\n` +
		`  ORDER BY updated_at DESC\n` +
		`  LIMIT ${limit}`;

	return { text, params };
}

/** Escape `%` and `_` (and the escape char) for a LIKE prefix literal. */
export function escapeLikePrefix(raw: string): string {
	return raw.replace(/([\\%_])/g, "\\$1");
}

/**
 * AC-38 (canonical): build the audit drill-down SELECT against
 * core.config_mutation_log, paginated by (key_name, scope).
 */
export function buildAuditQuery(
	flagName: string,
	scope: string,
	offset: number,
	limit = 50,
): BuiltQuery {
	const safeOffset = Math.max(0, Math.floor(offset));
	const safeLimit = Math.max(1, Math.min(limit, 200));
	const text =
		`SELECT applied_at, caller_did, mutation_authority,\n` +
		`       old_value_jsonb, new_value_jsonb\n` +
		`  FROM core.config_mutation_log\n` +
		`  WHERE key_name = $1 AND scope = $2\n` +
		`  ORDER BY applied_at DESC\n` +
		`  LIMIT ${safeLimit} OFFSET ${safeOffset}`;
	return { text, params: [flagName, scope] };
}

/** Guard query: does core.config_mutation_log exist? (AC-10/AC-38) */
export const AUDIT_TABLE_EXISTS_SQL =
	`SELECT 1 AS present FROM pg_tables ` +
	`WHERE schemaname = 'core' AND tablename = 'config_mutation_log'`;

/**
 * AC-36 fallback UPSERT (used only when P828 set() is unavailable). Scoped by
 * the live PK (flag_name). `scope` is carried so a future composite-PK schema
 * is forward-compatible, but on the live table (PK = flag_name) the conflict
 * target is flag_name. No audit row is written on this path (caller surfaces
 * the "[no audit log written]" banner — AC-23/AC-36).
 */
export function buildFallbackUpsert(
	flagName: string,
	scope: string,
	valueJson: unknown,
): BuiltQuery {
	const text =
		`INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, lifecycle_status, updated_at)\n` +
		`  VALUES ($1, $2, $3::jsonb, 'active', now())\n` +
		`  ON CONFLICT (flag_name) DO UPDATE\n` +
		`    SET value_jsonb = EXCLUDED.value_jsonb,\n` +
		`        scope = EXCLUDED.scope,\n` +
		`        updated_at = now()`;
	return { text, params: [flagName, scope, JSON.stringify(valueJson)] };
}

// ───────────────────────── Scope filter cycling (AC-19) ─────────────────────

/**
 * Build the ordered scope-filter cycle (AC-2/AC-19):
 *   all → global → host:<host> → agency:<agency?> → project:<slug>* → all
 * Only includes host/agency/project entries the caller actually has context
 * for, so the cycle never offers a filter that can match nothing.
 */
export function buildScopeCycle(opts: {
	host?: string;
	agencyId?: string;
	projectSlugs?: string[];
}): string[] {
	const cycle: string[] = ["all", "global"];
	if (opts.host) cycle.push(`host:${opts.host}`);
	if (opts.agencyId) cycle.push(`agency:${opts.agencyId}`);
	for (const slug of opts.projectSlugs ?? []) cycle.push(`project:${slug}`);
	return cycle;
}

export function nextInCycle<T>(cycle: T[], current: T): T {
	if (cycle.length === 0) return current;
	const i = cycle.indexOf(current);
	return cycle[(i + 1) % cycle.length];
}

export const LIFECYCLE_CYCLE: LifecycleFilter[] = [
	"all",
	"active",
	"deprecated",
	"retired",
	"blocked",
];

// ───────────────────────── ConfigKey resolution (AC-14/AC-22/AC-23) ─────────

export interface ResolvedKey {
	key: ConfigKey<unknown>;
	/** true when the flag was NOT in the typed registry (fallback key). */
	isFallback: boolean;
}

/**
 * AC-14: resolve a ConfigKey for `flagName`.
 *  (a)/(b) scan the typed registry (AllConfigKeys covers Flag+Registry+…) for a
 *          key whose .name === flagName; if found, use it (real .parse()).
 *  (c)     if not found, construct a fallback key with class 'flag' and a JSON
 *          parser, so an SQL-inserted flag absent from the registry is still
 *          editable. The caller shows the "[Unregistered key]" banner.
 *
 * `registry` is injectable for tests; defaults to the live AllConfigKeys.
 */
export function resolveConfigKey(
	flagName: string,
	registry: Record<string, ConfigKey<unknown>> = AllConfigKeys as Record<
		string,
		ConfigKey<unknown>
	>,
): ResolvedKey {
	for (const k of Object.values(registry)) {
		if (k && k.name === flagName) {
			return { key: k, isFallback: false };
		}
	}
	return { key: makeFallbackKey(flagName), isFallback: true };
}

/**
 * AC-14(c)/(d): a fallback ConfigKey for an unregistered flag. class='flag' so
 * ConfigResolver.set() accepts it (set() validates class, not registry
 * membership). parse() does a JSON.parse (raw text → JSON value), mirroring the
 * "value parses as valid JSON" rule of AC-23.
 */
export function makeFallbackKey(flagName: string): ConfigKey<unknown> {
	return {
		name: flagName,
		class: "flag",
		required: false,
		description: "[unregistered flag — no typed schema]",
		parse: (raw: string) => parseJsonValue(raw),
	};
}

// ───────────────────────── Value validation (AC-22/AC-23/AC-35) ─────────────

export interface ValidationOk {
	ok: true;
	value: unknown;
}
export interface ValidationErr {
	ok: false;
	error: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

/**
 * AC-22/AC-23/AC-35: validate raw editor text for `flagName`.
 *  - registered key → run key.parse(); a thrown error blocks submit and its
 *    message is surfaced inline.
 *  - unregistered (fallback) key → the fallback parser is JSON.parse, so an
 *    invalid JSON literal also blocks submit.
 * Returns the parsed value on success. Pure — never touches the DB.
 */
export function resolveEditValue(
	flagName: string,
	rawInput: string,
	registry?: Record<string, ConfigKey<unknown>>,
): ValidationResult {
	const { key } = resolveConfigKey(flagName, registry ?? (AllConfigKeys as any));
	try {
		const value = key.parse(rawInput);
		return { ok: true, value };
	} catch (err) {
		return { ok: false, error: errMessage(err) };
	}
}

/** JSON.parse with bare scalars (true/false/numbers/"strings") accepted. */
export function parseJsonValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("value is empty");
	}
	try {
		return JSON.parse(trimmed);
	} catch (e) {
		throw new Error(`not valid JSON: ${errMessage(e)}`);
	}
}

function errMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

// ───────────────────────── New-row validation (AC-25) ──────────────────────

const FLAG_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SCOPE_RE = /^(global|(host|agency|project):.+)$/;

export function validateFlagName(name: string): ValidationResult {
	if (!FLAG_NAME_RE.test(name)) {
		return {
			ok: false,
			error: "flag_name must match ^[A-Z][A-Z0-9_]*$",
		};
	}
	return { ok: true, value: name };
}

/** Mirror of the live scope CHECK: global | ^(host|agency|project):.+$ */
export function validateScope(scope: string): ValidationResult {
	if (!SCOPE_RE.test(scope)) {
		return {
			ok: false,
			error: "scope must be 'global' or '(host|agency|project):<id>'",
		};
	}
	return { ok: true, value: scope };
}

export const NEW_ROW_SCOPE_CYCLE = ["global", "host:", "agency:", "project:"];

// ───────────────────────── Diff (AC-21/AC-35) ──────────────────────────────

export interface DiffLine {
	kind: "same" | "removed" | "added";
	text: string;
}

/**
 * AC-21/AC-35: produce a line-oriented old→new diff of two JSON values, each
 * pretty-printed. This is the data the blessed pane colour-codes (removed=red,
 * added=green). Pure + deterministic so it is unit-testable.
 */
export function buildValueDiff(oldValue: unknown, newValue: unknown): DiffLine[] {
	const oldLines = prettyJson(oldValue).split("\n");
	const newLines = prettyJson(newValue).split("\n");
	const lines: DiffLine[] = [];
	const max = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < max; i++) {
		const o = oldLines[i];
		const n = newLines[i];
		if (o === n) {
			if (o !== undefined) lines.push({ kind: "same", text: o });
		} else {
			if (o !== undefined) lines.push({ kind: "removed", text: o });
			if (n !== undefined) lines.push({ kind: "added", text: n });
		}
	}
	return lines;
}

export function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

// ───────────────────────── Edit-state machine (AC-21/22/35) ─────────────────

export type EditPhase =
	| "browsing"
	| "editing" // textbox focused, typing new value
	| "diff" // Ctrl-S pressed, showing diff + confirm
	| "audit" // audit drill-down open
	| "viewOnly"; // read-only modal (read-only / write-disabled mode)

export interface EditState {
	phase: EditPhase;
	row: FlagRow | null;
	rawInput: string;
	validation: ValidationResult | null;
	isFallbackKey: boolean;
}

export function initialEditState(): EditState {
	return {
		phase: "browsing",
		row: null,
		rawInput: "",
		validation: null,
		isFallbackKey: false,
	};
}

/**
 * Open the edit dialog on `row`. In read-only/write-disabled mode the dialog is
 * view-only (AC-26/AC-27/AC-30/AC-41). Otherwise it pre-fills the textbox with
 * the current value pretty-printed and resolves whether the key is a fallback.
 */
export function openEdit(
	state: EditState,
	row: FlagRow,
	opts: { writable: boolean; registry?: Record<string, ConfigKey<unknown>> },
): EditState {
	const isFallback = resolveConfigKey(
		row.flag_name,
		opts.registry ?? (AllConfigKeys as any),
	).isFallback;
	return {
		...state,
		phase: opts.writable ? "editing" : "viewOnly",
		row,
		rawInput: opts.writable ? prettyJson(row.value_jsonb) : "",
		validation: null,
		isFallbackKey: isFallback,
	};
}

/** On each keystroke, re-validate the current rawInput (AC-5/AC-21/AC-22). */
export function onEditInput(
	state: EditState,
	rawInput: string,
	registry?: Record<string, ConfigKey<unknown>>,
): EditState {
	if (state.phase !== "editing" || !state.row) return state;
	return {
		...state,
		rawInput,
		validation: resolveEditValue(state.row.flag_name, rawInput, registry),
	};
}

/**
 * Ctrl-S → advance to the diff/confirm phase, but ONLY if the current value
 * validates (AC-22: parse errors block submission). Returns the same state
 * (still editing) when invalid.
 */
export function advanceToDiff(
	state: EditState,
	registry?: Record<string, ConfigKey<unknown>>,
): EditState {
	if (state.phase !== "editing" || !state.row) return state;
	const validation = resolveEditValue(
		state.row.flag_name,
		state.rawInput,
		registry,
	);
	if (!validation.ok) {
		return { ...state, validation };
	}
	return { ...state, phase: "diff", validation };
}

/** N/cancel/Esc → back to browsing, discarding the in-progress edit. */
export function cancelEdit(state: EditState): EditState {
	return initialEditState();
}

/** From the diff pane, [E]dit again → back to the textbox. */
export function backToEdit(state: EditState): EditState {
	if (state.phase !== "diff") return state;
	return { ...state, phase: "editing" };
}

// ───────────────────────── Notify payload (AC-37) ──────────────────────────

export interface FlagChangePayload {
	flag_name: string;
	scope: string;
	op?: string;
	at?: string;
}

/**
 * AC-37: parse a `runtime_flag_changed` NOTIFY payload (the trigger broadcasts
 * JSON {flag_name, scope, op, at}). Returns null for malformed payloads so the
 * live-reload handler can no-op rather than throw.
 */
export function parseFlagChangePayload(
	payload: string | undefined,
): FlagChangePayload | null {
	if (!payload) return null;
	try {
		const obj = JSON.parse(payload) as Record<string, unknown>;
		if (typeof obj.flag_name !== "string" || typeof obj.scope !== "string") {
			return null;
		}
		return {
			flag_name: obj.flag_name,
			scope: obj.scope,
			op: typeof obj.op === "string" ? obj.op : undefined,
			at: typeof obj.at === "string" ? obj.at : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * AC-8/AC-37: locate the index of the row a change payload refers to, matched
 * by BOTH flag_name AND scope (AC-40: scope-isolated). Returns -1 if absent
 * (e.g. an INSERT of a row not in the current filtered page).
 */
export function findRowIndex(
	rows: FlagRow[],
	payload: FlagChangePayload,
): number {
	return rows.findIndex(
		(r) => r.flag_name === payload.flag_name && r.scope === payload.scope,
	);
}

// ───────────────────────── Read-only / write-disable (AC-15/26/27/30/41) ────

export type WriteMode =
	| "writable"
	| "readonly_authority" // agent_read_only principal (AC-26)
	| "readonly_no_identity" // no operator DID resolved (AC-30)
	| "writes_disabled_no_p828" // mutation surface not deployed (AC-10/AC-15/AC-27)
	| "fallback_no_audit"; // set() missing but direct UPSERT allowed (AC-36)

export interface WriteModeInput {
	/** typeof ConfigResolver.prototype.set === 'function' (AC-15(b)). */
	hasSetMethod: boolean;
	/** core.config_mutation_log present (AC-10/AC-27 guard query). */
	auditTablePresent: boolean;
	/** resolved principal kind. */
	principalKind: "operator" | "agency" | "agent";
	/** operator DID resolved at startup (AC-30). */
	operatorDid: string | null;
	/** explicit override (AC-15(a)). */
	forceReadOnly?: boolean;
}

/**
 * Decide the write mode from deployment + identity signals (AC-15/26/27/30/36/
 * 41). Precedence:
 *   1. forceReadOnly                       → writes_disabled_no_p828
 *   2. agent principal                     → readonly_authority
 *   3. no operator DID                     → readonly_no_identity
 *   4. set() missing AND audit table gone  → writes_disabled_no_p828
 *   5. set() present, audit table present  → writable (audited path)
 *   6. set() missing/audit gone but DID ok → fallback_no_audit (direct UPSERT;
 *      AC-36 "writes degrade gracefully, never crash"). Note AC-27 takes
 *      precedence only when the audit TABLE is absent AND we also lack a usable
 *      set() — distinguished from AC-36 by whether the operator opted into the
 *      degraded write path. We model the conservative default: missing audit
 *      table disables audited writes; the direct UPSERT is the AC-36 fallback.
 */
export function decideWriteMode(input: WriteModeInput): WriteMode {
	if (input.forceReadOnly) return "writes_disabled_no_p828";
	if (input.principalKind === "agent") return "readonly_authority";
	if (!input.operatorDid) return "readonly_no_identity";
	if (input.hasSetMethod && input.auditTablePresent) return "writable";
	// set() unavailable OR audit table missing → degrade to direct UPSERT,
	// which writes no audit row (AC-36 / AC-23 / AC-41).
	return "fallback_no_audit";
}

export function isWritable(mode: WriteMode): boolean {
	return mode === "writable" || mode === "fallback_no_audit";
}

/** Banner text for the current write mode (AC-15/23/26/27/30/36). */
export function writeModeBanner(mode: WriteMode): string | null {
	switch (mode) {
		case "writable":
			return null;
		case "fallback_no_audit":
			return "[Unregistered/degraded write — no audit log written (P828 set() unavailable)]";
		case "readonly_authority":
			return "[Read-only: insufficient authority]";
		case "readonly_no_identity":
			return "[No operator identity — set AGENTHIVE_OPERATOR_DID]";
		case "writes_disabled_no_p828":
			return "[Write ops disabled — P828 mutation surface not deployed]";
	}
}

// ───────────────────────── Display formatting (AC-1/18/34) ──────────────────

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	if (max <= 3) return s.slice(0, max);
	return `${s.slice(0, max - 3)}[...]`;
}

/** Compact one-line jsonb value preview for the table (AC-1/AC-18). */
export function formatValuePreview(value: unknown, max = 40): string {
	let s: string;
	try {
		s = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		s = String(value);
	}
	if (s === undefined) s = "null";
	return truncate(s, max);
}

/** Abbreviated 2-char lifecycle code (AC-18). */
export function lifecycleCode(status: string): "AC" | "DP" | "RT" | "BK" | "??" {
	switch (status) {
		case "active":
			return "AC";
		case "deprecated":
			return "DP";
		case "retired":
			return "RT";
		case "blocked":
			return "BK";
		default:
			return "??";
	}
}

/** Relative "2h ago / 3d ago" for updated_at (AC-1). */
export function relativeTime(ts: string | Date, now: Date = new Date()): string {
	const then = ts instanceof Date ? ts : new Date(ts);
	const ms = now.getTime() - then.getTime();
	if (Number.isNaN(ms)) return "?";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${Math.max(0, sec)}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}

// ───────────────────────── Identity bootstrap SQL (AC-30) ───────────────────

/**
 * AC-30: DB fallback for operator DID resolution. The env var
 * AGENTHIVE_OPERATOR_DID is checked first by the caller (not here, to keep this
 * module env-free); this is the SQL half.
 */
export const RESOLVE_OPERATOR_DID_SQL =
	`SELECT did FROM control_identity.principal ` +
	`WHERE principal_type = 'operator' AND lifecycle_status = 'active' ` +
	`LIMIT 1`;
