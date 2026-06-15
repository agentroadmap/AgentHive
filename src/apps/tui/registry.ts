/**
 * P1067 — panel registry + focus/switch state machine (pure, TTY-free).
 *
 * Holds the ordered list of registered panels, the active index, and per-panel
 * preserved state (AC-15: cursor/filters survive switches via a Map<route,
 * state>). All blessed rendering lives in shell.ts; this module is pure so the
 * switch semantics (AC-5/AC-6/AC-15) are unit-testable headlessly.
 */

import type { TuiPanel } from "./types.ts";

export class DuplicateRouteError extends Error {
	constructor(route: string) {
		super(`panel route already registered: ${route}`);
		this.name = "DuplicateRouteError";
	}
}

/** A single lifecycle transition the shell must apply to blessed. */
export interface SwitchPlan {
	/** Route to deactivate (LISTEN unsub + keybind teardown), or null. */
	deactivate: string | null;
	/** Route to activate (mount/keybind wire-up), or null if no-op. */
	activate: string | null;
	/** True when from === to (caller should skip work). */
	noop: boolean;
}

export class PanelRegistry {
	private readonly panels: TuiPanel[] = [];
	private readonly byRoute = new Map<string, TuiPanel>();
	/** AC-15: preserved opaque per-panel state, keyed by route. */
	private readonly state = new Map<string, unknown>();
	private activeIndex = -1;

	/** Register a panel. Throws on duplicate route (AC-2 uniqueness). */
	register(panel: TuiPanel): void {
		if (this.byRoute.has(panel.route)) {
			throw new DuplicateRouteError(panel.route);
		}
		this.byRoute.set(panel.route, panel);
		this.panels.push(panel);
	}

	count(): number {
		return this.panels.length;
	}

	routes(): string[] {
		return this.panels.map((p) => p.route);
	}

	get(route: string): TuiPanel | undefined {
		return this.byRoute.get(route);
	}

	at(index: number): TuiPanel | undefined {
		return this.panels[index];
	}

	activeRoute(): string | null {
		return this.activeIndex >= 0
			? (this.panels[this.activeIndex]?.route ?? null)
			: null;
	}

	activePanel(): TuiPanel | null {
		return this.activeIndex >= 0
			? (this.panels[this.activeIndex] ?? null)
			: null;
	}

	indexOf(route: string): number {
		return this.panels.findIndex((p) => p.route === route);
	}

	/**
	 * Plan a switch to `route`. Returns the deactivate/activate transition the
	 * shell applies to blessed; sets the active index as a side effect (unless
	 * the route is unknown, which is a no-op so a stray Ctrl-N never clears the
	 * screen). Crucially this NEVER destroys a screen (AC-5).
	 */
	switchTo(route: string): SwitchPlan {
		const target = this.indexOf(route);
		if (target < 0) {
			return { deactivate: null, activate: null, noop: true };
		}
		const fromRoute = this.activeRoute();
		if (target === this.activeIndex) {
			return { deactivate: null, activate: route, noop: true };
		}
		this.activeIndex = target;
		return { deactivate: fromRoute, activate: route, noop: false };
	}

	/**
	 * AC-15: Ctrl-N switch. `n` is 1-based (Ctrl-1 → first panel). Returns a
	 * no-op plan when out of range.
	 */
	switchToNth(n: number): SwitchPlan {
		const panel = this.panels[n - 1];
		if (!panel) return { deactivate: null, activate: null, noop: true };
		return this.switchTo(panel.route);
	}

	// ── AC-15 preserved state ──────────────────────────────────────────────
	saveState(route: string, value: unknown): void {
		this.state.set(route, value);
	}

	loadState<T = unknown>(route: string): T | undefined {
		return this.state.get(route) as T | undefined;
	}

	hasState(route: string): boolean {
		return this.state.has(route);
	}
}
