/**
 * discordSend — push a message to the Discord bridge via pg_notify.
 *
 * Any agent can call this to surface a message in the Discord home channel
 * without making any direct HTTP or Discord API calls.  The running
 * hermes-discord-bridge service picks up the `discord_send` pg_notify event
 * and forwards it to the channel.
 *
 * Usage:
 *   import { discordSend } from "../infra/discord/notify.ts";
 *   await discordSend("claude/one", "Gate pipeline resumed after outage", "warning");
 *
 * Level icons rendered by the bridge:
 *   info    → 💬
 *   success → ✅
 *   warning → ⚠️
 *   error   → ❌
 */

import { query } from "../postgres/pool.ts";

export type DiscordLevel = "info" | "success" | "warning" | "error";

/**
 * Fire a pg_notify('discord_send', ...) so the Discord bridge forwards
 * the message to the Discord home channel.  Zero LLM tokens consumed.
 */
export async function discordSend(
	from: string,
	message: string,
	level: DiscordLevel = "info",
): Promise<void> {
	const payload = JSON.stringify({ from, message, level });
	await query(`SELECT pg_notify('discord_send', $1)`, [payload]);
}
