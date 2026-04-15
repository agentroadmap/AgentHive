/**
 * Discord Notify — zero-cost outbound Discord messaging via pg_notify.
 *
 * Any agent or process can call discordSend() to push a message to
 * Discord through the discord-bridge process. The bridge listens on
 * the 'discord_send' pg_notify channel and forwards to the Discord API.
 *
 * Zero LLM calls, zero token cost.
 */

import { query } from "../postgres/pool.ts";

export type DiscordLevel = "info" | "success" | "warning" | "error";

interface DiscordSendPayload {
	from: string;
	message: string;
	level: DiscordLevel;
	ts: string;
}

/**
 * Send a message to Discord via pg_notify.
 *
 * The discord-bridge process listens on the 'discord_send' channel
 * and forwards the payload to the Discord API.
 *
 * @param from Agent or sender identity
 * @param message Message content
 * @param level Message level (determines icon in Discord)
 */
export async function discordSend(
	from: string,
	message: string,
	level: DiscordLevel = "info",
): Promise<void> {
	const payload: DiscordSendPayload = {
		from,
		message,
		level,
		ts: new Date().toISOString(),
	};

	await query(`SELECT pg_notify('discord_send', $1::text)`, [
		JSON.stringify(payload),
	]);
}
