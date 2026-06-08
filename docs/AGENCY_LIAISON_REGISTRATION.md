# Agency Registration & Liaison — Canonical Instruction

_Status: 2026-06-07. Supersedes ad-hoc per-agency service setup. Applies to claude, codex, gemini, and any new agency._

## Core principle (read this first)

An agency is registered in the **database**, not by standing up a systemd service.

- The **liaison is a smart AI agent** that represents the agency — it owns judgment: quota-aware claim decisions, matchmaking the right persona to each offer, coordinating fixes when workers fail, and representing the agency in A2A. (Target design: **P1438**.)
- A small **deterministic floor** runs the mechanical invariants that must never fail — atomic claim, lease renewal, heartbeat (V3 **C1/C5**). The floor is **shared per OS-user**, NOT one service per agency.
- **DO NOT** create an `agenthive-agency@<x>` or a new `agenthive-liaison@<agency>` unit per agency. Service proliferation is the anti-pattern we are removing.

## Canonical identity

`<provider>-<host>-<osuser>.a` — e.g. `claude-bot-gary.a`, `codex-bot-andy.a`, `gemini-bot-gary.a`.
The `.a` suffix marks the agency's standing liaison identity.

## Registration = DB rows only

1. `roadmap_workforce.agent_registry`: `agent_identity`, `agent_type='agency'`, `status='active'`, `preferred_provider=<provider>`, `host_affinity=<host>`.
2. `roadmap.agency`: `agency_id`, `provider`, `host_id`, `status='active'`, `capability_tags`, `metadata.standing_liaison=true`.
3. `roadmap_workforce.provider_registry`: `agency_id=<registry id>`, `status='active'`, `is_active=true`, `capabilities={"jobs":["develop","review","design",...],"provider":"<p>"}`, `max_in_flight=N`.
4. `roadmap_workforce.agent_capability`: one row per capability (`develop`, `review`, `design`, `<provider>`, `agent-spawner`, `messaging`, …). **REQUIRED** — empty capabilities trip the empty-capability brake and the claim loop refuses to start.
5. `roadmap.message_acl`: grant `<id> → * (dm + channel_post)` so the liaison can message peers.
6. Add `<id>` to `AGENTHIVE_SELF_CLAIM_AGENCIES` in `/etc/agenthive/env` (the self-claim allowlist).

## Runtime — do NOT add a per-agency service

- There is **one liaison floor per OS-user**, and it self-claims for **every** agency registered under that user. A new agency on an existing OS-user is **DB rows only** — no new service.
- **Per-OS-user auth:** claude + gemini run under `gary` (`~/.claude`, `~/.gemini`); codex runs under `andy` (`~/.codex`). The floor spawns the correct CLI per the agency's `provider`.
- The **smart liaison** (the judgment layer) is the cold-wakeable AI agent of **P1438** — woken by A2A `msg_` on a new offer / worker failure / peer message, idle at ~zero token cost. It is **not** a service and **not** always-on.

## Forbidden

- ❌ `systemctl enable agenthive-agency@<provider>` — legacy runtime; crash-loops as an unregistered bare identity (`Agency <x> not registered`).
- ❌ A new `agenthive-liaison@<agency>` unit per agency.
- ❌ Treating the floor service as "the liaison." The floor is reflexes; the liaison is the brain.

## Transitional note

The three `agenthive-liaison@*.a` services running today (`claude-bot-gary.a`, `codex-bot-andy.a`, `gemini-bot-gary.a`) are the **interim floor** while the AI-agent liaison (P1438) is built. They are the last per-agency units that should exist; do not add more. The end state is one shared floor per OS-user + the wakeable AI-agent liaison on top.
