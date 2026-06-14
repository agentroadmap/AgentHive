/**
 * P1067 AC-16 — production ListenDriver backed by a single direct pg client.
 *
 * Owns exactly ONE pg `Client` (session mode, PGPORT_DIRECT=5432 PgBouncer
 * bypass — LISTEN/NOTIFY require a sticky session connection, not a transaction-
 * pooled one). On disconnect it reconnects and re-issues every LISTEN within the
 * reconnect window via `multiplexer.resubscribeAll()`.
 *
 * This file performs real I/O and is therefore exercised by `npm run tui`, not by
 * the headless unit tests — the dedup/fan-out logic those tests cover lives in
 * listen-multiplexer.ts behind the injected ListenDriver seam.
 */

import { Client, type ClientConfig } from "pg";
import { ConfigResolver } from "../../shared/runtime/config.ts";
import type { ListenDriver, ListenMultiplexer } from "./listen-multiplexer.ts";

const RECONNECT_DELAY_MS = 2_000;

/**
 * Build the LISTEN client config. Forces the DIRECT Postgres port (PGPORT_DIRECT,
 * default 5432) so we bypass PgBouncer transaction pooling — a pooled connection
 * cannot hold a LISTEN. Mirrors src/memory/memory-event-consumer.ts.
 */
export function buildTuiListenConfig(
	env: NodeJS.ProcessEnv = process.env,
): ClientConfig {
	const host = env.PGHOST ?? "127.0.0.1";
	const port = Number(env.PGPORT_DIRECT ?? env.PGPORT ?? 5432);
	const user = env.PGUSER ?? "";
	const database = env.PGDATABASE ?? "agenthive";
	const password = ConfigResolver.resolvePasswordSync({
		host,
		port: String(port),
		database,
		user,
	});
	return {
		host,
		port,
		user,
		password: password ?? undefined,
		database,
		options:
			"-c search_path=roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public",
	};
}

export class PgListenDriver implements ListenDriver {
	private client: Client | null = null;
	private mux: ListenMultiplexer | null = null;
	private closed = false;
	private connecting: Promise<void> | null = null;
	private readonly config: ClientConfig;
	private readonly debug: boolean;

	constructor(opts: { config?: ClientConfig; debug?: boolean } = {}) {
		this.config = opts.config ?? buildTuiListenConfig();
		this.debug = opts.debug ?? false;
	}

	/** Bind the multiplexer that owns dispatch/resubscribe. */
	attach(mux: ListenMultiplexer): void {
		this.mux = mux;
	}

	async connect(): Promise<void> {
		if (this.connecting) return this.connecting;
		this.connecting = this._connect();
		try {
			await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	private async _connect(): Promise<void> {
		const client = new Client(this.config);
		client.on("notification", (msg) => {
			this.mux?.dispatch(msg.channel, msg.payload ?? undefined);
		});
		client.on("error", (err) => {
			if (this.debug) console.error("[tui-listen] client error", err);
			this.scheduleReconnect();
		});
		client.on("end", () => {
			if (!this.closed) this.scheduleReconnect();
		});
		await client.connect();
		this.client = client;
		// AC-16: after a (re)connect, re-arm every active subscription.
		this.mux?.resubscribeAll();
	}

	private scheduleReconnect(): void {
		if (this.closed) return;
		const dead = this.client;
		this.client = null;
		if (dead) {
			dead.removeAllListeners();
			void dead.end().catch(() => {});
		}
		setTimeout(() => {
			if (this.closed) return;
			void this.connect().catch((err) => {
				if (this.debug) console.error("[tui-listen] reconnect failed", err);
				this.scheduleReconnect();
			});
		}, RECONNECT_DELAY_MS).unref?.();
	}

	async listen(channel: string): Promise<void> {
		if (!this.client) return; // resubscribeAll re-arms after reconnect
		await this.client.query(`LISTEN ${quoteIdent(channel)}`);
	}

	async unlisten(channel: string): Promise<void> {
		if (!this.client) return;
		await this.client.query(`UNLISTEN ${quoteIdent(channel)}`);
	}

	async close(): Promise<void> {
		this.closed = true;
		const c = this.client;
		this.client = null;
		if (c) {
			c.removeAllListeners();
			await c.end().catch(() => {});
		}
	}
}

/**
 * Quote a NOTIFY channel identifier defensively. Channels come from panel code,
 * not operator input, but LISTEN takes an identifier (not a bind param) so we
 * still guard against injection by rejecting anything but [a-zA-Z0-9_].
 */
export function quoteIdent(channel: string): string {
	if (!/^[a-zA-Z0-9_]+$/.test(channel)) {
		throw new Error(`invalid LISTEN channel: ${JSON.stringify(channel)}`);
	}
	return channel;
}
