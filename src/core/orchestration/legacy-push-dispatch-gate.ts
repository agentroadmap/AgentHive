/**
 * P1438 C6 AC-14 (no mechanical presence floor).
 *
 * The legacy "offer_dispatch downlink" push (orchestrator → the first
 * listDispatchableAgencies()) selected a dispatch target from
 * v_agency_status.dispatchable, which is computed from agency.last_heartbeat_at
 * (written by the a2a-host presence timer). That is a heartbeat-derived
 * dispatchability path — a mechanical presence floor that routes work by a
 * timer-asserted heartbeat instead of by an actual atomic claim.
 *
 * In C6 the open-pool work offer is already posted and dispatch is decided by
 * fn_claim_work_offer (emergent presence: availability is revealed by the claim,
 * not by a heartbeat). The downlink push is therefore both redundant and a
 * violation of "no heartbeat-derived dispatchability path remains for open-pool
 * offers." It is gated OFF by default; flip
 * ORCHESTRATOR_LEGACY_PUSH_DISPATCH_ENABLED=true only to roll back to legacy
 * push-dispatch (no code revert needed).
 */

import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";

/**
 * True only when an operator has explicitly re-enabled legacy push-dispatch. If
 * the runtime config resolver is not initialized (some entrypoints skip
 * initConfig), this fails CLOSED to false — which is also the C6-safe default
 * (no heartbeat-derived push).
 */
export async function isLegacyPushDispatchEnabled(): Promise<boolean> {
	try {
		return await runtimeConfig.get(
			FlagKeys.ORCHESTRATOR_LEGACY_PUSH_DISPATCH_ENABLED,
		);
	} catch {
		return false;
	}
}
