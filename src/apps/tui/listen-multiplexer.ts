/**
 * P1067 AC-3 / AC-16 — ListenMultiplexer.
 *
 * ONE pg LISTEN client per shell, regardless of panel count. Multiple panels
 * may subscribe to the same channel; the multiplexer issues exactly one
 * `LISTEN <channel>` to Postgres and fans a notification out to every handler.
 * When the last handler for a channel unsubscribes it issues `UNLISTEN`.
 *
 * The pg driver is injected (a `ListenDriver`) so the aggregation/dedup logic is
 * unit-testable with an in-memory fake; pg-listen-driver.ts is the production
 * implementation that owns the single direct (PgBouncer-bypass) connection and
 * reconnect loop (AC-16).
 */

export type NotificationHandler = (payload: string | undefined) => void;

/** The side of the multiplexer that talks to Postgres. */
export interface ListenDriver {
	/** Issue `LISTEN <channel>`. Called at most once per distinct channel. */
	listen(channel: string): Promise<void> | void;
	/** Issue `UNLISTEN <channel>` when the last subscriber leaves. */
	unlisten(channel: string): Promise<void> | void;
}

export class ListenMultiplexer {
	private readonly handlers = new Map<string, Set<NotificationHandler>>();
	/** Channels for which a LISTEN has been issued (AC-3 dedup). */
	private readonly listening = new Set<string>();
	private readonly driver: ListenDriver;

	constructor(driver: ListenDriver) {
		this.driver = driver;
	}

	/**
	 * Subscribe `handler` to `channel`. Issues exactly ONE LISTEN per channel
	 * even when many panels subscribe to it (AC-3).
	 */
	subscribe(channel: string, handler: NotificationHandler): void {
		let set = this.handlers.get(channel);
		if (!set) {
			set = new Set();
			this.handlers.set(channel, set);
		}
		set.add(handler);
		if (!this.listening.has(channel)) {
			this.listening.add(channel);
			void this.driver.listen(channel);
		}
	}

	/**
	 * Remove a handler. When the last handler for a channel leaves, issue
	 * UNLISTEN and forget the channel (AC-5 unsubscribe-on-deactivate).
	 */
	unsubscribe(channel: string, handler: NotificationHandler): void {
		const set = this.handlers.get(channel);
		if (!set) return;
		set.delete(handler);
		if (set.size === 0) {
			this.handlers.delete(channel);
			if (this.listening.delete(channel)) {
				void this.driver.unlisten(channel);
			}
		}
	}

	/**
	 * Dispatch a notification to every handler subscribed to `channel`. Called by
	 * the driver's pg "notification" event. A throwing handler does not starve
	 * its siblings.
	 */
	dispatch(channel: string, payload: string | undefined): void {
		const set = this.handlers.get(channel);
		if (!set) return;
		for (const h of [...set]) {
			try {
				h(payload);
			} catch {
				/* one bad handler must not break the fan-out */
			}
		}
	}

	/** Number of LISTENs actually issued (AC-3: equals distinct channels). */
	listenCount(): number {
		return this.listening.size;
	}

	/** Distinct channels currently listened on. */
	channels(): string[] {
		return [...this.listening];
	}

	/** Handler count for a channel (test/introspection helper). */
	handlerCount(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}

	/**
	 * Re-issue LISTEN for every active channel — called by the driver after a
	 * reconnect so subscriptions survive a dropped connection (AC-16).
	 */
	resubscribeAll(): void {
		for (const channel of this.listening) {
			void this.driver.listen(channel);
		}
	}
}
