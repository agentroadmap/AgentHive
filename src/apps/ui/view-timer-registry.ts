/**
 * P1139 — per-view timer lifecycle (AC-4), pure + injectable, TTY-free.
 *
 * THE PROBLEM
 * -----------
 * cockpit / headlines / chat each arm a `setInterval` refresh (see
 * unified-view.ts:496/799/867/1009). Today every Tab destroys that view's whole
 * screen, which incidentally tears the interval down via the view's own
 * clearInterval. Once P1139 stops destroying the screen per view (single-screen
 * refactor), those intervals would KEEP FIRING for hidden views — wasting work,
 * racing renders against detached widgets, and leaking handles that keep Node's
 * event loop alive (the same class of hang noted at unified-view.ts:1087).
 *
 * THE RULE (AC-4)
 * ---------------
 * A view's timers PAUSE when the view is hidden and RESUME when it is shown
 * again — and there are never two live intervals for the same view, nor a
 * leaked interval after final teardown.
 *
 * This registry owns that invariant in one place. It takes injectable
 * `setInterval`/`clearInterval` (default to the globals) so the whole pause /
 * resume / dispose state machine is unit-testable with a fake clock — no blessed
 * and no real timers required. The live views register their refresh callback
 * here instead of calling setInterval directly; show/hide of the view's
 * container drives resume()/pause().
 */

export type IntervalHandle = ReturnType<typeof setInterval>;

export interface TimerHooks {
	set: (fn: () => void, ms: number) => IntervalHandle;
	clear: (handle: IntervalHandle) => void;
}

const defaultHooks: TimerHooks = {
	set: (fn, ms) => setInterval(fn, ms),
	clear: (handle) => clearInterval(handle),
};

interface RegisteredTimer {
	fn: () => void;
	ms: number;
	handle: IntervalHandle | null; // non-null only while running
}

/**
 * Tracks the refresh timers for ONE view's container. The view registers each
 * recurring callback once; the registry guarantees at most one live interval per
 * registration and flips them all on show()/hide().
 */
export class ViewTimerRegistry {
	private readonly timers: RegisteredTimer[] = [];
	private running = false;
	private disposed = false;

	constructor(private readonly hooks: TimerHooks = defaultHooks) {}

	/** True while this view is shown and its timers are live. */
	get isRunning(): boolean {
		return this.running;
	}

	/** How many distinct recurring callbacks are registered. */
	get size(): number {
		return this.timers.length;
	}

	/** Count of intervals currently armed (tests assert 0 while hidden). */
	get activeCount(): number {
		return this.timers.filter((t) => t.handle !== null).length;
	}

	/**
	 * Register a recurring callback. If the view is currently shown, the timer
	 * starts immediately; otherwise it stays dormant until show(). Registering
	 * after dispose() is a no-op (defensive against late mounts).
	 */
	register(fn: () => void, ms: number): void {
		if (this.disposed) return;
		const timer: RegisteredTimer = { fn, ms, handle: null };
		this.timers.push(timer);
		if (this.running) {
			timer.handle = this.hooks.set(timer.fn, timer.ms);
		}
	}

	/** Show the view: arm every registered timer that is not already live. */
	show(): void {
		if (this.disposed || this.running) return;
		this.running = true;
		for (const timer of this.timers) {
			if (timer.handle === null) {
				timer.handle = this.hooks.set(timer.fn, timer.ms);
			}
		}
	}

	/** Hide the view: clear every live timer so nothing fires while hidden. */
	hide(): void {
		if (!this.running) return;
		this.running = false;
		for (const timer of this.timers) {
			if (timer.handle !== null) {
				this.hooks.clear(timer.handle);
				timer.handle = null;
			}
		}
	}

	/**
	 * Final teardown for this view. Clears all live timers and forgets the
	 * registrations so no interval survives the TUI exit (no leaked handles).
	 * Idempotent.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.hide();
		this.disposed = true;
		this.timers.length = 0;
	}
}
