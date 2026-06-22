/**
 * P4668 AC-2/AC-4/AC-13: Canonical transition operation.
 *
 * The ONLY permitted write path for proposal state/maturity changes during and
 * after the P4668 dual-write window. Wraps the SECURITY DEFINER function
 * `roadmap.fn_canonical_transition_insert(JSONB)` installed by mig 306.
 *
 * Usage:
 *   const eventId = await canonicalTransition(pool, {
 *     proposalId: 42,
 *     eventKind: 'status_transition',
 *     toStatus: 'develop',
 *     fromStatus: 'review',
 *     actorPrincipalId: 'claude-bot-gary',
 *     actorLayer: 'liaison',
 *     agentProfile: 'gate-evaluator',
 *     reasonCode: 'decision',
 *     rationale: 'All ACs verified.',
 *     gateDecisionId: 1234n,
 *     runId: 5678n,
 *     idempotencyKey: `gate-1234-advance-${proposalId}`,
 *   });
 *
 * Provider identity (AC-14): resolved_provider MUST be sourced from
 * agent_runs / route_decision_log, never from self-report. Pass resolvedRunId
 * and the helper will join against agent_runs to populate provider fields.
 */

import type { Pool, PoolClient, QueryResultRow } from "./pool.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActorLayer =
	| "operator"
	| "orchestrator"
	| "agency"
	| "liaison"
	| "spawn-agent"
	| "system-trigger";

export type EventKind =
	| "status_transition"
	| "maturity_change"
	| "maturity_reset_on_status_change"
	| "maturity_set"
	| "break_glass"
	| "compensating_correction"
	| "federation_sync"
	| "gate_pause_demotion";

export type ReasonCode =
	| "canonical"
	| "submit"
	| "decision"
	| "system"
	| "break_glass"
	| "compensating_correction"
	| "federation_sync";

export type SourceConfidence = "high" | "medium" | "low";

/**
 * Resolved actor route identity (Axis 3, AC-13/AC-14).
 * Populated exclusively from agent_runs / route_decision_log — never self-report.
 */
export interface ResolvedRouteIdentity {
	resolvedProvider?: string;
	claimedProvider?: string;
	providerMismatch?: boolean;
	modelUsed?: string;
	routeId?: bigint;
	actorHost?: string;
	/** 'high' when from agent_runs; 'medium' when from env/registry snapshot. */
	sourceConfidence?: SourceConfidence;
}

export interface CanonicalTransitionParams {
	// Required
	proposalId: bigint | number;
	eventKind: EventKind;
	actorPrincipalId: string;
	actorLayer: ActorLayer;

	// State change (at least one of status or maturity should be set)
	fromStatus?: string;
	toStatus?: string;
	fromMaturity?: string;
	toMaturity?: string;

	// Classification
	reasonCode?: ReasonCode;
	rationale?: string;

	// Axis 2 — expert profile
	agentProfile?: string;

	// Axis 3 — resolved route (AC-14: sourced from DB, not self-report)
	route?: ResolvedRouteIdentity;

	// Actor snapshot (full agent_registry row at write time)
	actorIdentitySnapshot?: Record<string, unknown>;

	// Agency/session context
	agencyIdentity?: string;
	sessionId?: string;
	delegatedAuthority?: Record<string, unknown>;

	// Governance evidence
	gateDecisionId?: bigint | number;
	reviewIds?: (bigint | number)[];
	acEvidenceSnapshot?: Record<string, unknown>;
	acEvidenceHash?: string;
	dependencySnapshot?: Record<string, unknown>;
	dependencySnapshotHash?: string;

	// Correlation
	leaseId?: bigint | number;
	runId?: bigint | number;
	dispatchId?: bigint | number;
	requestId?: string;
	correlationId?: string;
	idempotencyKey?: string;

	// Ancillary state changes (AC-35/AC-38): non-state-machine column mutations
	// that co-occur with a transition and should be captured in the audit trail.
	// Canonical use: gate_scanner_paused, gate_paused_by, gate_paused_at when
	// a premature-gate demotion clears pause state. Any proposal column whose
	// value changes as a side-effect of the transition belongs here.
	additionalStateChanges?: Record<string, unknown>;

	// Source tracing
	sourceSurface?: string;
	serviceIdentity?: string;
	transactionId?: string;

	// Timing (defaults to NOW() in DB function)
	occurredAt?: Date;

	// Project context
	projectId?: bigint | number;
}

/**
 * Options for resolveRouteFromRun():
 * queries agent_runs to populate the Axis-3 provider identity fields.
 */
export interface RunResolutionOptions {
	/** agent_runs.id to join against for authoritative provider identity. */
	runId: bigint | number;
	/** DB client or pool — must have SELECT on roadmap_workforce.agent_runs. */
	db: Pool | PoolClient;
}

// ── Route resolution from agent_runs (AC-14) ─────────────────────────────────

interface AgentRunRow {
	resolved_provider: string | null;
	claimed_provider: string | null;
	provider_mismatch: boolean;
	model_used: string | null;
	route_id: string | null;
	agency_identity: string | null;
}

/**
 * AC-14: Populate Axis-3 provider identity from agent_runs — the authoritative
 * source. Never accept self-reported provider from the agent payload.
 *
 * Returns null when the run is not found (caller must decide whether to proceed
 * with source_confidence='low' or fail hard).
 */
export async function resolveRouteFromRun(
	opts: RunResolutionOptions,
): Promise<ResolvedRouteIdentity | null> {
	const { runId, db } = opts;
	const res = await (db as any).query<AgentRunRow>(
		`SELECT
			resolved_provider,
			claimed_provider,
			provider_mismatch,
			model_used,
			route_id,
			agency_identity
		FROM roadmap_workforce.agent_runs
		WHERE id = $1
		LIMIT 1`,
		[String(runId)],
	);
	if (!res.rows.length) return null;
	const row = res.rows[0];
	return {
		resolvedProvider: row.resolved_provider ?? undefined,
		claimedProvider: row.claimed_provider ?? undefined,
		providerMismatch: row.provider_mismatch,
		modelUsed: row.model_used ?? undefined,
		routeId: row.route_id ? BigInt(row.route_id) : undefined,
		sourceConfidence: "high",
	};
}

// ── JSONB payload builder ─────────────────────────────────────────────────────

function buildPayload(params: CanonicalTransitionParams): Record<string, unknown> {
	const {
		proposalId,
		eventKind,
		actorPrincipalId,
		actorLayer,
		fromStatus,
		toStatus,
		fromMaturity,
		toMaturity,
		reasonCode,
		rationale,
		agentProfile,
		route,
		actorIdentitySnapshot,
		agencyIdentity,
		sessionId,
		delegatedAuthority,
		gateDecisionId,
		reviewIds,
		acEvidenceSnapshot,
		acEvidenceHash,
		dependencySnapshot,
		dependencySnapshotHash,
		leaseId,
		runId,
		dispatchId,
		requestId,
		correlationId,
		idempotencyKey,
		additionalStateChanges,
		sourceSurface,
		serviceIdentity,
		transactionId,
		occurredAt,
		projectId,
	} = params;

	const payload: Record<string, unknown> = {
		proposal_id: String(proposalId),
		event_kind: eventKind,
		actor_principal_id: actorPrincipalId,
		actor_layer: actorLayer,
		reason_code: reasonCode ?? "canonical",
	};

	if (fromStatus != null) payload.from_status = fromStatus;
	if (toStatus != null) payload.to_status = toStatus;
	if (fromMaturity != null) payload.from_maturity = fromMaturity;
	if (toMaturity != null) payload.to_maturity = toMaturity;
	if (rationale != null) payload.rationale = rationale;
	if (agentProfile != null) payload.agent_profile = agentProfile;
	if (actorIdentitySnapshot != null)
		payload.actor_identity_snapshot = actorIdentitySnapshot;
	if (agencyIdentity != null) payload.agency_identity = agencyIdentity;
	if (sessionId != null) payload.session_id = sessionId;
	if (delegatedAuthority != null) payload.delegated_authority = delegatedAuthority;
	if (gateDecisionId != null) payload.gate_decision_id = String(gateDecisionId);
	if (reviewIds != null) payload.review_ids = reviewIds.map(String);
	if (acEvidenceSnapshot != null) payload.ac_evidence_snapshot = acEvidenceSnapshot;
	if (acEvidenceHash != null) payload.ac_evidence_hash = acEvidenceHash;
	if (dependencySnapshot != null) payload.dependency_snapshot = dependencySnapshot;
	if (dependencySnapshotHash != null)
		payload.dependency_snapshot_hash = dependencySnapshotHash;
	if (leaseId != null) payload.lease_id = String(leaseId);
	if (runId != null) payload.run_id = String(runId);
	if (dispatchId != null) payload.dispatch_id = String(dispatchId);
	if (requestId != null) payload.request_id = requestId;
	if (correlationId != null) payload.correlation_id = correlationId;
	if (idempotencyKey != null) payload.idempotency_key = idempotencyKey;
	if (additionalStateChanges != null)
		payload.additional_state_changes = additionalStateChanges;
	if (sourceSurface != null) payload.source_surface = sourceSurface;
	if (serviceIdentity != null) payload.service_identity = serviceIdentity;
	if (transactionId != null) payload.transaction_id = transactionId;
	if (occurredAt != null) payload.occurred_at = occurredAt.toISOString();
	if (projectId != null) payload.project_id = String(projectId);

	// Axis 3 route identity (AC-14: must come from authoritative source)
	if (route != null) {
		if (route.resolvedProvider != null)
			payload.resolved_provider = route.resolvedProvider;
		if (route.claimedProvider != null)
			payload.claimed_provider = route.claimedProvider;
		if (route.providerMismatch != null)
			payload.provider_mismatch = String(route.providerMismatch);
		if (route.modelUsed != null) payload.model_used = route.modelUsed;
		if (route.routeId != null) payload.route_id = String(route.routeId);
		if (route.actorHost != null) payload.actor_host = route.actorHost;
		if (route.sourceConfidence != null)
			payload.source_confidence = route.sourceConfidence;
	}

	return payload;
}

// ── Main canonical operation ──────────────────────────────────────────────────

/**
 * Emit one canonical ledger event for a proposal transition.
 *
 * Returns the UUID of the newly created (or pre-existing idempotent) ledger row.
 *
 * Throws on validation failures (missing required fields, gated-transition
 * without rationale, etc.) — the DB function raises EXCEPTION for these cases.
 *
 * @param db     Pool or PoolClient — must be connected to agenthive DB.
 * @param params Transition parameters.
 */
export async function canonicalTransition(
	db: Pool | PoolClient,
	params: CanonicalTransitionParams,
): Promise<string> {
	const payload = buildPayload(params);

	const res = await (db as any).query<{ fn_canonical_transition_insert: string }>(
		`SELECT roadmap.fn_canonical_transition_insert($1::jsonb) AS fn_canonical_transition_insert`,
		[JSON.stringify(payload)],
	);

	return res.rows[0].fn_canonical_transition_insert;
}

/**
 * Emit a ledger event + proposal_event row atomically (dual-write phase).
 *
 * During the mig-306–310 window both the old proposal_event path and the new
 * ledger path are written. The proposal_event.ledger_event_id column (mig 307)
 * cross-links them.
 *
 * Callers that already own a transaction (PoolClient) should pass it directly
 * so both writes share the same transaction boundary.
 *
 * @param db             PoolClient within a transaction (strongly recommended).
 * @param params         Ledger event params.
 * @param proposalEventType proposal_event.event_type value (must be in CHECK).
 * @param proposalEventPayload Optional JSONB payload for proposal_event.
 */
export async function canonicalTransitionWithEvent(
	db: Pool | PoolClient,
	params: CanonicalTransitionParams,
	proposalEventType: string,
	proposalEventPayload?: Record<string, unknown>,
): Promise<{ eventId: string; proposalEventId: bigint }> {
	const eventId = await canonicalTransition(db, params);

	const evtRes = await (db as any).query<{ id: string }>(
		`INSERT INTO roadmap_proposal.proposal_event
			(proposal_id, event_type, payload, ledger_event_id)
		VALUES ($1, $2, $3::jsonb, $4::uuid)
		RETURNING id`,
		[
			String(params.proposalId),
			proposalEventType,
			JSON.stringify(proposalEventPayload ?? {}),
			eventId,
		],
	);

	return {
		eventId,
		proposalEventId: BigInt(evtRes.rows[0].id),
	};
}
