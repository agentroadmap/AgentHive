/**
 * P435 / P443 — Control Panel Observability: causal ID schema, feed events, operator control types.
 *
 * Causal chain: proposal_id → dispatch_id → claim_id → run_id
 * Every feed event carries the full chain so a single causal query can replay
 * any dispatch or claim sequence end-to-end.
 *
 * P443 adds v2 causal context fields: transition_id, auth_source_class,
 * provider_account_id, message, severity. All new fields are optional/nullable
 * for backward compatibility — old events with NULL values are tolerated as partial.
 */

// ─── Auth source class (P443) ─────────────────────────────────────────────────

/**
 * Classification of the auth source used when an event was emitted.
 * Sensitive credentials MUST NOT appear in feed events — only this class label.
 */
export type AuthSourceClass = "token_plan" | "api_key_plan" | "subscription" | "local";

// ─── Feed event severity (P443) ───────────────────────────────────────────────

export type FeedEventSeverity = "debug" | "info" | "warn" | "error" | "critical";

// ─── Stop scope ───────────────────────────────────────────────────────────────

export type StopScopeType =
	| "project"
	| "proposal"
	| "dispatch"
	| "agency"
	| "worker"
	| "host"
	| "route";

// ─── Causal ID chain ─────────────────────────────────────────────────────────

/**
 * AC#4: all events linked by chain(proposal_id, dispatch_id, claim_id, run_id).
 * Any field may be null when the event originates before that entity exists.
 */
export interface CausalId {
	proposal_id: number | null;
	dispatch_id: string | null; // UUID string
	claim_id: string | null;    // UUID string
	run_id: string | null;      // UUID string
}

// ─── Feed event ───────────────────────────────────────────────────────────────

/**
 * Feed event v2 schema (P435 base + P443 causal context extensions).
 * Written to roadmap_control.feed_event; broadcast via pg_notify('control_feed').
 *
 * Required fields: event_class (NOT NULL in DB; emitted_at defaults to now()).
 * All other fields are nullable — partial events (NULL causal fields) are valid.
 * Consumers MUST handle NULL for every optional field.
 */
export interface FeedEvent {
	event_id?: number;

	// Causal chain (P435)
	proposal_id: number | null;
	dispatch_id: string | null;
	claim_id: string | null;
	run_id: string | null;

	// Full context (P435)
	project_id: string | null;
	agency_id: string | null;
	worker_id: string | null;
	host: string | null;
	route: string | null;
	model: string | null;
	budget_scope: string | null;
	event_class: FeedEventClass;
	recommended_stop_scope: StopScopeType | null;

	emitted_at?: string;
	metadata?: Record<string, unknown>;

	// v2 causal context (P443) — nullable for backward compat with old events
	transition_id?: number | null;
	provider_account_id?: string | null;
	auth_source_class?: AuthSourceClass | null;
	message?: string | null;
	severity?: FeedEventSeverity;
}

export type FeedEventClass =
	| "dispatch_created"
	| "dispatch_started"
	| "dispatch_completed"
	| "dispatch_cancelled"
	| "dispatch_failed"
	| "claim_acquired"
	| "claim_released"
	| "claim_expired"
	| "claim_cancelled"
	| "run_started"
	| "run_completed"
	| "run_failed"
	| "run_terminated"
	| "run_timeout"
	| "agency_suspended"
	| "agency_resumed"
	| "host_drained"
	| "operator_stop"
	| "operator_cancel"
	| "operator_terminate";

// ─── Dispatch record ──────────────────────────────────────────────────────────

export type DispatchStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface DispatchRecord {
	dispatch_id: string;
	proposal_id: number | null;
	project_id: string | null;
	agency_id: string | null;
	worker_id: string | null;
	host: string | null;
	route: string | null;
	model: string | null;
	provider: string | null;
	agent_cli: string | null;
	budget_scope: string | null;
	status: DispatchStatus;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
}

// ─── Claim record ─────────────────────────────────────────────────────────────

export type ClaimStatus = "active" | "expired" | "released" | "cancelled";

export interface ClaimRecord {
	claim_id: string;
	dispatch_id: string;
	agent_identity: string;
	claimed_at: string;
	expires_at: string | null;
	released_at: string | null;
	release_reason: string | null;
	status: ClaimStatus;
}

// ─── Run record ───────────────────────────────────────────────────────────────

export type RunStatus = "running" | "completed" | "failed" | "terminated" | "timeout";

export interface RunRecord {
	run_id: string;
	claim_id: string;
	dispatch_id: string;
	agent_identity: string;
	model: string | null;
	provider: string | null;
	agent_cli: string | null;
	budget_scope: string | null;
	status: RunStatus;
	exit_code: number | null;
	duration_ms: number | null;
	tokens_used: number | null;
	started_at: string;
	ended_at: string | null;
}

// ─── Operator action log ──────────────────────────────────────────────────────

export type OperatorActionType =
	| "stop"
	| "suspend_agency"
	| "resume_agency"
	| "drain_host"
	| "cancel_dispatch"
	| "terminate_worker"
	| "list_active_dispatches"
	| "list_agencies"
	| "list_workers";

export type OperatorActionResult = "success" | "partial" | "failure" | "noop";

export interface OperatorActionLog {
	action_id?: number;
	operator: string;
	acted_at?: string;
	action_type: OperatorActionType;
	scope_type: StopScopeType | null;
	scope_id: string | null;
	reason: string;
	result: OperatorActionResult;
	error_message: string | null;
	affected_count: number;
	dispatch_id: string | null;
	proposal_id: number | null;
	agency_id: string | null;
	worker_id: string | null;
}

// ─── Operator Control API surface ─────────────────────────────────────────────

export interface ListDispatchesOptions {
	project_id?: string;
	status?: DispatchStatus;
	limit?: number;
	offset?: number;
}

export interface ListAgenciesOptions {
	status?: string;
	limit?: number;
	offset?: number;
}

export interface ListWorkersOptions {
	agency_id?: string;
	dispatch_id?: string;
	limit?: number;
	offset?: number;
}

export interface StopOptions {
	scope_type: StopScopeType;
	scope_id: string;
	reason: string;
	operator: string;
}

export interface StopResult {
	affected_count: number;
	dispatch_ids: string[];
	worker_ids: string[];
	action_id: number;
}

export interface SuspendAgencyOptions {
	agency_id: string;
	reason: string;
	operator: string;
}

export interface DrainHostOptions {
	host_id: string;
	reason: string;
	operator: string;
}

export interface CancelDispatchOptions {
	dispatch_id: string;
	reason: string;
	operator: string;
}

export interface TerminateWorkerOptions {
	worker_id: string;
	reason: string;
	operator: string;
}

// ─── Concurrency ceilings (P439) ─────────────────────────────────────────────

export type ConcurrencyScope =
	| "global"
	| "project"
	| "host"
	| "agency"
	| "proposal"
	| "workflow_state"
	| "role";

export interface ConcurrencyLimitRecord {
	id?: number;
	scope_type: ConcurrencyScope;
	scope_id: string;
	max_active_claims: number;
	max_active_workers: number;
	updated_at?: string;
}

export interface ConcurrencyUsageRow {
	scope_type: ConcurrencyScope;
	scope_id: string;
	max_active_claims: number;
	max_active_workers: number;
	current_active_claims: number;
	at_ceiling: boolean;
}

// ─── Replay view ──────────────────────────────────────────────────────────────

/**
 * A single row in a replay view, correlating dispatch+claim+run+route+budget.
 * AC#6: replay test must correlate 5+ records into one view.
 * Includes v2 causal fields (P443); NULL values for old events are valid.
 */
export interface ReplayRow {
	event_id: number;
	event_class: FeedEventClass;
	severity: FeedEventSeverity;
	emitted_at: string;

	// Causal chain (P435)
	proposal_id: number | null;
	transition_id: number | null;
	dispatch_id: string | null;
	claim_id: string | null;
	run_id: string | null;

	// Context at time of event (P435)
	project_id: string | null;
	agency_id: string | null;
	worker_id: string | null;
	host: string | null;
	route: string | null;
	model: string | null;
	budget_scope: string | null;
	recommended_stop_scope: StopScopeType | null;

	// v2 context (P443)
	auth_source_class: AuthSourceClass | null;
	provider_account_id: string | null;
	message: string | null;
}
