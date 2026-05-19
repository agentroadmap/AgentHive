/**
 * P674 notification-router entrypoint.
 *
 * Drains roadmap.notification_queue and dispatches via transport adapters
 * resolved from roadmap.notification_route. Wakes on
 * pg_notify('notification_enqueued') with a 30s polling fallback.
 */

import { Client } from "pg";

import { NotificationRouter } from "../src/core/notifications/router.ts";
import {
	closePool,
	getPool,
	setPoolLifecycleMode,
	startPoolPoisonWatchdog,
} from "../src/infra/postgres/pool.ts";

async function main(): Promise<void> {
	setPoolLifecycleMode("long-running");
	startPoolPoisonWatchdog("agenthive-notification-router");
	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[notification-router] db ok");

	const router = new NotificationRouter({
		pool,
		listenerFactory: async () => {
			// Dedicated client for LISTEN — must NOT come from the pool because
			// LISTEN clients are pinned for the process lifetime.
			const cfg = (pool as unknown as { options: Record<string, unknown> }).options;
			const client = new Client({
				host: cfg.host as string,
				port: cfg.port as number,
				user: cfg.user as string,
				password: cfg.password as string,
				database: cfg.database as string,
			});
			await client.connect();
			return client;
		},
	});

	await router.run();

	const shutdown = async (signal: string) => {
		console.log(`[notification-router] ${signal} received, stopping`);
		try {
			await router.stop();
		} catch (err) {
			console.error("[notification-router] stop error:", err);
		}
		try {
			await closePool();
		} catch (err) {
			console.error("[notification-router] pool close error:", err);
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("uncaughtException", (err) => {
		console.error("[notification-router] uncaught:", err);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error("[notification-router] unhandled rejection:", reason);
	});
}

main().catch((err) => {
	console.error("[notification-router] fatal:", err);
	process.exit(1);
});
