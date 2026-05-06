/**
 * A2A trust gate — pure logic over `roadmap_workforce.agent_trust`.
 *
 * Extracted from `scripts/a2a-dispatcher.ts` so the trust decision is testable
 * without starting the dispatcher service. Dispatcher imports the same two
 * functions and applies its own logging on top.
 *
 * Trust resolution rules:
 *   - sender === 'system'  → 'authority' (no DB lookup)
 *   - recipient === sender → 'trusted'   (self-message bypass)
 *   - row in agent_trust with non-expired expires_at → row.trust_level
 *   - otherwise (no row, expired row, or DB error) → 'known' (default-open)
 *
 * Gate decision:
 *   - 'blocked'    → drop
 *   - 'restricted' → drop unless sender is authoritative ('system'/'gary')
 *                    OR the message is task/command/gate
 *   - 'known' / 'trusted' / 'authority' → accept
 */

import { query } from "../postgres/pool.ts";

export type TrustLevel = "authority" | "trusted" | "known" | "restricted" | "blocked";

const AUTHORITATIVE_SENDERS: readonly string[] = ["system", "gary"];
const RESTRICTED_ALLOWED_TYPES: readonly string[] = ["task", "command", "gate"];

export async function getTrustLevel(
	recipient: string,
	sender: string,
): Promise<TrustLevel> {
	if (sender === "system") return "authority";
	if (recipient === sender) return "trusted";

	try {
		const { rows } = await query<{ trust_level: string }>(
			`SELECT trust_level FROM roadmap_workforce.agent_trust
			 WHERE agent_identity = $1 AND trusted_agent = $2
			   AND (expires_at IS NULL OR expires_at > now())
			 LIMIT 1`,
			[recipient, sender],
		);
		if (rows.length > 0) return rows[0].trust_level as TrustLevel;
	} catch {
		// table missing / permission error → fall through to default-open
	}

	return "known";
}

export async function trustGate(
	recipient: string,
	sender: string,
	messageType: string,
): Promise<boolean> {
	const level = await getTrustLevel(recipient, sender);
	if (level === "blocked") return false;
	if (level === "restricted") {
		if (
			!AUTHORITATIVE_SENDERS.includes(sender) &&
			!RESTRICTED_ALLOWED_TYPES.includes(messageType)
		) {
			return false;
		}
	}
	return true;
}
