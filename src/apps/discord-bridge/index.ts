/**
 * Discord Bridge — entry point.
 *
 * Starts the DiscordBridgeService and exposes an HTTP health-check endpoint.
 *
 * AC-9:  Systemd service starts at boot via scripts/discord-bridge-runner.js
 * AC-10: GET /discord-bridge/health → JSON health snapshot
 */

import http from "node:http";
import { DiscordBridgeService } from "./discord-bridge.ts";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
	console.error(
		"[discord-bridge] DISCORD_BOT_TOKEN environment variable is required",
	);
	process.exit(1);
}

const HEALTH_PORT = Number(
	process.env.DISCORD_BRIDGE_HEALTH_PORT ?? 6422,
);

const bridge = new DiscordBridgeService(token);

const healthServer = http.createServer(
	async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> => {
		if (req.method === "GET" && req.url === "/discord-bridge/health") {
			try {
				const health = await bridge.healthChecker.checkHealth();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						status: health.status,
						queue_length: health.message_queue_length,
						last_heartbeat: health.last_heartbeat,
						connected: health.connected,
						failed_acks: health.failed_acks,
						channel_mappings: health.channel_mappings,
						uptime_seconds: health.uptime_seconds,
					}),
				);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			}
		} else {
			res.writeHead(404);
			res.end("Not Found");
		}
	},
);

async function shutdown(): Promise<void> {
	console.log("[discord-bridge] Shutting down...");
	await bridge.stop();
	healthServer.close();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

healthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
	console.log(
		`[discord-bridge] Health check listening on http://127.0.0.1:${HEALTH_PORT}/discord-bridge/health`,
	);
});

bridge
	.start()
	.then(() => {
		console.log("[discord-bridge] Service started successfully");
	})
	.catch((err: Error) => {
		console.error("[discord-bridge] Failed to start:", err.message);
		process.exit(1);
	});
