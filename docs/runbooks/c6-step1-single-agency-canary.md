# C6 Step-1 Canary — single-agency self-claim (P1438)

**Goal:** live proof that ONE agency (`claude-agency-bot`) claims a work offer via the
self-claim path (AgencyClaimLoop → fn_claim_work_offer → handleOfferDispatch → spawn),
with zero orchestrator dispatch involvement, while every other agency stays on the
old orchestrator-dispatch path.

**Status:** runbook only. Do NOT execute the live flip without operator go.
**Prereqs landed:** C6 steps 1-4 + 3b + allowlist (branch feat/p1438-self-claim @ cdc1a4b3),
pending codex gate + merge to main. The flip requires this code RUNNING in the live
a2a-host, i.e. merged to main + a2a-host restarted (services are operator-only).

---

## Why match-all caps is acceptable here
With exactly one self-claiming agency, capability matching is moot — there is no
contention to arbitrate. `claude-agency-bot.skills` is NULL, so the extractor yields
`[]` = match-all; that agency will claim any open offer. This is correct for a
single-agency canary and is WHY step-1 does not need P1129 canonical capabilities
(multi-agency step 5 does). See P1438 #8749/#8751, P1129 #8750.

## Safety preconditions (verify ALL before flip)
1. Branch merged to main and a2a-host running that code (`git -C /data/code/AgentHive log --oneline -1` includes the C6 merge; a2a-host restarted after).
2. **Orchestrator claim path OFF or orchestrator stopped** — avoid double-claim contention.
   - Today orchestrator is `inactive` and `ORCHESTRATOR_OFFER_CLAIM_ENABLED=true`. For the canary, EITHER keep orchestrator stopped, OR (cleaner) set its flag false so if it starts it won't also claim. C1 atomic (fn_claim_work_offer FOR UPDATE + SKIP LOCKED) prevents true double-claim, but avoiding contention keeps the canary signal clean.
   - `psql -U admin -d agenthive -c "SELECT flag_name,value_jsonb FROM core.runtime_flag WHERE flag_name LIKE '%OFFER_CLAIM%';"`
3. `claude-agency-bot` is live: `SELECT dispatchable,liveness_state,has_live_listener FROM roadmap.v_agency_status WHERE agency_id='claude-agency-bot';` → t / live-but-idle / t.
4. a2a-host has `claude-agency-bot` attached (not in its AGENTHIVE_AGENCY_EXCLUDE list).

## The flip (operator)
The canary is TWO settings — a global flag + the per-agency allowlist:
1. Allowlist (env on the a2a-host unit — operator edits EnvironmentFile or unit, then daemon-reload + restart):
   `AGENTHIVE_SELF_CLAIM_AGENCIES=claude-agency-bot`
2. Global flag (DB, live-reload via runtime_config_changed NOTIFY, no restart needed for the flag itself — but the allowlist env DOES need the restart):
   `psql -U admin -d agenthive -c "UPDATE core.runtime_flag SET value_jsonb='true'::jsonb WHERE flag_name='AGENCY_OFFER_CLAIM_ENABLED';"`
Order: set the allowlist env + restart a2a-host FIRST (so the restart picks up the allowlist), THEN flip the flag. If you flip the flag before the allowlist env is in place, EVERY attached agency self-claims — that's the failure mode the allowlist exists to prevent.

## Verify the canary (the bar)
1. a2a-host journal: `[AgencyClaim:claude-agency-bot] listening on work_offers` appears; NO `[AgencyClaim:...]` line for any OTHER agency (allowlist working).
   `journalctl -u agenthive-a2a-host.service --since "2 min ago" | grep -E "AgencyClaim|self-claim flag on but"`
   (other agencies should log "self-claim flag on but <id> not in ... allowlist".)
2. Post a test offer (operator/orchestrator posts a work_offer NOTIFY) for a proposal claude-agency-bot is eligible for.
3. squad_dispatch shows the claim by claude-agency-bot:
   `SELECT agent_identity, dispatch_status, offer_status, claimed_at FROM roadmap_workforce.squad_dispatch WHERE agent_identity='claude-agency-bot' ORDER BY claimed_at DESC LIMIT 3;`
   → exactly one row claimed by claude-agency-bot; offer_status claimed→active→delivered.
4. The spawn happened via the agency path (not orchestrator): agent_runs row with agency_identity='claude-agency-bot'; orchestrator logs show NO offer-claim/dispatch for it.
5. Worker completes (exit 0) and the offer reaches delivered; lease renews don't false-expire (1320s TTL > spawn timeout).
6. NO other agency claimed via self-claim (only claude-agency-bot's AgencyClaimLoop ran).

## Rollback (instant, no code revert)
- Flag: `UPDATE core.runtime_flag SET value_jsonb='false'::jsonb WHERE flag_name='AGENCY_OFFER_CLAIM_ENABLED';` (live-reload).
- Or unset `AGENTHIVE_SELF_CLAIM_AGENCIES` + restart (returns to all-agencies-or-none, but with flag false it's fully inert).
- Orchestrator dispatch path is untouched, so reverting the flag returns the system to exactly the prior behavior.

## What this canary does NOT prove (defer)
- Multi-agency contention / capability matching (needs P1129 canonical caps + C8/P1440).
- The AC-1 cutover (orchestrator stops claiming entirely) — that's step 5, a separate operator-gated change with P1136/P904 obsolete coupling.
- Cross-host offer delivery (single-master NOTIFY; step-4 rollout, orchestrator host-pinning per the 2026-05-31 decision).
