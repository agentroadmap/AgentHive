/**
 * V3-C5 (P1437) AC-3: canonical pg_notify channel contract registry.
 *
 * Single source of truth for every LISTEN/NOTIFY channel used by orchestration:
 * its channel-name pattern, the producer (trigger/function), the payload id-type,
 * a short payload schema, and the listener. validateChannelRegistry() FAILS when
 * two producers share a channel-name pattern with INCOMPATIBLE payload id-types —
 * exactly the P1408 collision, where fn_a2a_message_notify (msg_<id>, BIGINT
 * message_id) and fn_liaison_notify_new_message (then also msg_<id>, UUID
 * message_id) emitted to the same namespace and crashed the bigint listener.
 *
 * Call validateChannelRegistry() at boot (and in tests) so a future channel
 * collision is caught before it silently crashes a listener again.
 */

export type PayloadIdType = "bigint" | "uuid" | "none";

export interface ChannelContract {
	/** Channel-name pattern. `<x>` marks the templated suffix (e.g. msg_<identity>). */
	pattern: string;
	/** What emits to it. */
	producer: string;
	/** Type of the payload's primary id field (the field listeners coerce). */
	payloadIdType: PayloadIdType;
	/** Human-readable payload shape. */
	payloadSchema: string;
	/** What consumes it. */
	listener: string;
}

/**
 * The canonical registry. Keep in sync when adding a NOTIFY channel; the
 * validator + test guard against incompatible reuse of a pattern.
 */
export const CHANNEL_REGISTRY: readonly ChannelContract[] = [
	{
		pattern: "msg_<agent_identity>",
		producer: "fn_a2a_message_notify (trigger on roadmap.message_ledger)",
		payloadIdType: "bigint",
		payloadSchema: "{ message_id: bigint, from_agent, to_agent, message_type }",
		listener: "liaison-agent.ts (agentNotifyChannel) -> fetchMessage(id::bigint)",
	},
	{
		pattern: "liaison_message_<agency_id>",
		producer: "fn_liaison_notify_new_message (trigger on roadmap.liaison_message)",
		payloadIdType: "uuid",
		payloadSchema: "{ message_id: uuid, direction, kind, sequence }",
		listener: "liaison-message-service.ts (LISTEN_CHANNEL_PREFIX)",
	},
	{
		pattern: "work_offers",
		producer: "postWorkOffer + fn_reap_expired_offers (reissue)",
		payloadIdType: "bigint",
		payloadSchema: "{ event: 'reissued', dispatch_id: bigint }",
		listener: "offer-claim-loop.ts (work_offers)",
	},
	{
		pattern: "proposal_gate_ready",
		producer: "proposal maturity/gate triggers",
		payloadIdType: "none",
		payloadSchema: "{ proposal_id }",
		listener: "orchestrator.ts LISTEN",
	},
	{
		pattern: "proposal_maturity_changed",
		producer: "proposal maturity trigger",
		payloadIdType: "none",
		payloadSchema: "{ proposal_id, maturity }",
		listener: "orchestrator.ts LISTEN",
	},
	{
		pattern: "runtime_flag_changed",
		producer: "core.runtime_flag trigger",
		payloadIdType: "none",
		payloadSchema: "{ name }",
		listener: "orchestrator.ts / config loader LISTEN",
	},
];

export class ChannelContractError extends Error {
	constructor(message: string) {
		super(`ChannelContractError: ${message}`);
		this.name = "ChannelContractError";
	}
}

/**
 * Fail if any channel-name pattern is registered by >1 producer with conflicting
 * payload id-types. Returns the validated registry on success.
 */
export function validateChannelRegistry(
	registry: readonly ChannelContract[] = CHANNEL_REGISTRY,
): readonly ChannelContract[] {
	const byPattern = new Map<string, Set<PayloadIdType>>();
	const producersByPattern = new Map<string, string[]>();
	for (const c of registry) {
		if (!byPattern.has(c.pattern)) {
			byPattern.set(c.pattern, new Set());
			producersByPattern.set(c.pattern, []);
		}
		byPattern.get(c.pattern)!.add(c.payloadIdType);
		producersByPattern.get(c.pattern)!.push(c.producer);
	}
	for (const [pattern, idTypes] of byPattern) {
		if (idTypes.size > 1) {
			throw new ChannelContractError(
				`channel pattern '${pattern}' has conflicting payload id-types ` +
					`{${[...idTypes].join(", ")}} across producers ` +
					`[${producersByPattern.get(pattern)!.join(" | ")}]. ` +
					`This is the P1408 collision class — a listener will crash coercing ` +
					`the wrong id-type. Give one producer a distinct channel pattern.`,
			);
		}
	}
	return registry;
}
