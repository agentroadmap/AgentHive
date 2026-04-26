/**
 * P468: Two-way orchestrator↔liaison messaging protocol
 * Message types, envelopes, and catalog definitions
 */

import { z } from 'zod';

// ─── Message Envelope ───────────────────────────────────────────────────────

export const LiaisonMessageDirectionSchema = z.enum([
    'orchestrator->liaison',
    'liaison->orchestrator',
]);
export type LiaisonMessageDirection = z.infer<typeof LiaisonMessageDirectionSchema>;

export const LiaisonMessageAckOutcomeSchema = z.enum([
    'ok',
    'reject',
    'noop',
]);
export type LiaisonMessageAckOutcome = z.infer<typeof LiaisonMessageAckOutcomeSchema>;

export const LiaisonMessageSchema = z.object({
    message_id: z.string().uuid(),
    agency_id: z.string(),
    sequence: z.bigint(),
    direction: LiaisonMessageDirectionSchema,
    kind: z.string(),
    correlation_id: z.string().uuid(),
    payload: z.record(z.any()).default({}),
    signed_at: z.string().datetime(),
    signature: z.string(),
    acked_at: z.string().datetime().nullable().optional(),
    ack_outcome: LiaisonMessageAckOutcomeSchema.nullable().optional(),
    ack_error: z.string().nullable().optional(),
    created_at: z.string().datetime().optional(),
});

export type LiaisonMessage = z.infer<typeof LiaisonMessageSchema>;

// ─── Control Plane: Orchestrator → Liaison ──────────────────────────────────

export const OfferDispatchPayloadSchema = z.object({
    offer_id: z.string().uuid(),
    role: z.string(),
    required_capabilities: z.array(z.string()),
    route_hint: z.string(),
});
export type OfferDispatchPayload = z.infer<typeof OfferDispatchPayloadSchema>;

export const ClaimRevokePayloadSchema = z.object({
    claim_id: z.string().uuid(),
    reason: z.string(),
});
export type ClaimRevokePayload = z.infer<typeof ClaimRevokePayloadSchema>;

export const LiaisonPausePayloadSchema = z.object({
    until_iso: z.string().datetime().nullable().optional(),
});
export type LiaisonPausePayload = z.infer<typeof LiaisonPausePayloadSchema>;

export const LiaisonResumePayloadSchema = z.object({});
export type LiaisonResumePayload = z.infer<typeof LiaisonResumePayloadSchema>;

export const LiaisonDrainPayloadSchema = z.object({
    reason: z.string(),
});
export type LiaisonDrainPayload = z.infer<typeof LiaisonDrainPayloadSchema>;

export const AgencyRetirePayloadSchema = z.object({
    reason: z.string(),
});
export type AgencyRetirePayload = z.infer<typeof AgencyRetirePayloadSchema>;

export const ProtocolPingPayloadSchema = z.object({
    nonce: z.string(),
});
export type ProtocolPingPayload = z.infer<typeof ProtocolPingPayloadSchema>;

export const QueryCapacityPayloadSchema = z.object({});
export type QueryCapacityPayload = z.infer<typeof QueryCapacityPayloadSchema>;

// ─── Control Plane: Liaison → Orchestrator ──────────────────────────────────

export const LiaisonRegisterPayloadSchema = z.object({
    agency_id: z.string(),
    provider: z.string(),
    host_id: z.string(),
    capabilities: z.array(z.string()),
    public_key: z.string(),
});
export type LiaisonRegisterPayload = z.infer<typeof LiaisonRegisterPayloadSchema>;

export const ClaimOfferPayloadSchema = z.object({
    offer_id: z.string().uuid(),
    agent_identity: z.string(),
    briefing_id: z.string().uuid(),
});
export type ClaimOfferPayload = z.infer<typeof ClaimOfferPayloadSchema>;

export const ClaimReleasePayloadSchema = z.object({
    claim_id: z.string().uuid(),
    reason: z.string(),
});
export type ClaimReleasePayload = z.infer<typeof ClaimReleasePayloadSchema>;

export const ClaimPausedPayloadSchema = z.object({
    claim_id: z.string().uuid(),
    reason: z.string(),
    resume_eligible_at: z.string().datetime(),
});
export type ClaimPausedPayload = z.infer<typeof ClaimPausedPayloadSchema>;

export const AgencyThrottlePayloadSchema = z.object({
    until_iso: z.string().datetime(),
    reason: z.string(),
});
export type AgencyThrottlePayload = z.infer<typeof AgencyThrottlePayloadSchema>;

export const AgencyActivePayloadSchema = z.object({});
export type AgencyActivePayload = z.infer<typeof AgencyActivePayloadSchema>;

export const AssistanceRequestPayloadSchema = z.object({
    briefing_id: z.string().uuid(),
    task_id: z.string().uuid(),
    error_signature: z.string(),
    payload: z.record(z.any()),
});
export type AssistanceRequestPayload = z.infer<typeof AssistanceRequestPayloadSchema>;

export const EscalatePayloadSchema = z.object({
    kind: z.string(),
    severity: z.string(),
    payload: z.record(z.any()),
});
export type EscalatePayload = z.infer<typeof EscalatePayloadSchema>;

// ─── Telemetry Plane: Liaison → Orchestrator ────────────────────────────────

export const HeartbeatPayloadSchema = z.object({
    capacity_envelope: z.record(z.any()),
    in_flight_count: z.number().int(),
    last_error: z.string().nullable().optional(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

export const ProgressNotePayloadSchema = z.object({
    briefing_id: z.string().uuid(),
    summary: z.string(),
    confidence: z.number().min(0).max(1),
});
export type ProgressNotePayload = z.infer<typeof ProgressNotePayloadSchema>;

export const ClaimStatusPayloadSchema = z.object({
    claim_id: z.string().uuid(),
    ac_progress: z.record(z.any()),
    eta_minutes: z.number().int().nullable().optional(),
});
export type ClaimStatusPayload = z.infer<typeof ClaimStatusPayloadSchema>;

export const ProtocolPongPayloadSchema = z.object({
    nonce: z.string(),
});
export type ProtocolPongPayload = z.infer<typeof ProtocolPongPayloadSchema>;

// ─── Protocol Errors & Special Messages ──────────────────────────────────────

export const ProtocolResyncPayloadSchema = z.object({
    max_buffered_sequence: z.bigint(),
    dropped_count: z.number().int(),
});
export type ProtocolResyncPayload = z.infer<typeof ProtocolResyncPayloadSchema>;

// ─── Message Construction Helpers ───────────────────────────────────────────

export interface CreateMessageOptions {
    agencyId: string;
    direction: LiaisonMessageDirection;
    kind: string;
    payload: Record<string, any>;
    correlationId?: string;
    sequence?: bigint;
}

/**
 * Create a new unsigned message envelope
 */
export function createMessageEnvelope(options: CreateMessageOptions): Partial<LiaisonMessage> {
    return {
        message_id: crypto.randomUUID(),
        agency_id: options.agencyId,
        direction: options.direction,
        kind: options.kind,
        correlation_id: options.correlationId || crypto.randomUUID(),
        payload: options.payload,
        signed_at: new Date().toISOString(),
    };
}
