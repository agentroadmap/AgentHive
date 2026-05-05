/**
 * Discord Bridge — process entry point.
 *
 * Reads DISCORD_BOT_TOKEN from env, starts DiscordBridgeService,
 * and serves a JSON health endpoint on port 6422.
 */

import http from "node:http";
import { DiscordBridgeService } from "./discord-bridge.ts";
import { HealthChecker } from "./health-check.ts";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const HEALTH_PORT = Number(process.env.DISCORD_BRIDGE_HEALTH_PORT ?? "6422");

if (!DISCORD_BOT_TOKEN) {
	console.error("[DiscordBridge] DISCORD_BOT_TOKEN is not set");
	process.exit(1);
}

const healthChecker = new HealthChecker();
const bridge = new DiscordBridgeService(DISCORD_BOT_TOKEN, healthChecker);

bridge.start().catch((err) => {
	console.error("[DiscordBridge] Failed to start:", err);
	process.exit(1);
});

const server = http.createServer(async (req, res) => {
	if (req.method === "GET" && req.url === "/discord-bridge/health") {
		try {
			const health = await healthChecker.checkHealth();
			const code = health.status === "healthy" ? 200 : 503;
			res.writeHead(code, { "Content-Type": "application/json" });
			res.end(JSON.stringify(health));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "error", message: String(err) }));
		}
		return;
	}
	res.writeHead(404);
	res.end();
});

server.listen(HEALTH_PORT, () => {
	console.log(`[DiscordBridge] Health endpoint: http://localhost:${HEALTH_PORT}/discord-bridge/health`);
});

const shutdown = (signal: string) => {
	console.log(`[DiscordBridge] ${signal} — shutting down`);
	server.close();
	bridge.stop().finally(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
