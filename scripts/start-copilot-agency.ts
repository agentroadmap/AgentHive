/**
 * Copilot Agency Runtime — provider-pinned wrapper around start-agency.ts.
 *
 * P912 AC-5: this file no longer duplicates registry/session/heartbeat/hub
 * code. It is a small shim that pins AGENTHIVE_AGENT_PROVIDER=copilot
 * (and the Copilot identity default) and then runs the generic start-agency
 * runtime. Adding a third provider follows the same pattern: a small env
 * shim, no fresh OfferProvider instantiation, no per-provider liaison
 * registration block.
 *
 * Operators can equivalently run `start-agency.ts` directly with the same
 * env vars set externally — this script exists only so an existing systemd
 * unit pinned to `start-copilot-agency.ts` continues to work without an
 * env-file edit.
 *
 * Usage:
 *   node --import jiti/register scripts/start-copilot-agency.ts
 */

import { hostname } from "node:os";

// Pin Copilot defaults BEFORE the generic runtime imports anything that
// reads these. The generic runtime falls back to the same identity logic if
// AGENTHIVE_AGENT_IDENTITY is unset, so this default is just for backwards
// compatibility with the old per-provider script's hostname-based fallback.
process.env.AGENTHIVE_AGENT_PROVIDER ??= "copilot";
process.env.AGENTHIVE_AGENT_IDENTITY ??= `copilot/agency-${hostname()}`;

// Delegate to the generic runtime. start-agency.ts owns the lifecycle.
await import("./start-agency.ts");
