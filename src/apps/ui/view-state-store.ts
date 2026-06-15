/**
 * P1139 — per-view UI state retention (AC-3), pure + TTY-free.
 *
 * THE PROBLEM
 * -----------
 * Because the reverted attempt destroyed and recreated each view's screen on
 * Tab, all transient UI position was lost: tabbing away from kanban and back
 * reset the column/row cursor; the proposal list lost its scroll offset; the
 * cockpit forgot which panel was focused. P247 wants Tab to feel like flipping
 * between *living* views, so this state must SURVIVE a Tab away-and-back.
 *
 * On a single shared screen the natural home for that state is the live blessed
 * widget itself (its `selected` index / `childBase` scroll), which we keep alive
 * by hiding rather than destroying. But two cases still need an explicit store:
 *   1. views that ARE rebuilt cheaply on show (so the widget is new each time),
 *   2. headless verification — we cannot assert against a live widget's cursor
 *      without a TTY, but we CAN assert the retention contract against this
 *      store with a fake clock / no blessed.
 *
 * So this module is the single, injectable place that snapshots and restores a
 * view's cursor/scroll/focus. The live show*() handlers read from it on mount
 * and write to it on hide; the unit tests drive it directly to prove the
 * "preserved across Tab" contract (AC-3) without a live render.
 */

import type { LifecycleView } from "./screen-lifecycle.ts";

/** Retained UI position for a single view. All fields optional per view kind. */
export interface ViewUiState {
	/** kanban: selected column index. */
	kanbanColumn?: number;
	/** kanban: selected row within the column. */
	kanbanRow?: number;
	/** proposal-list: scroll offset (blessed childBase) and selected index. */
	listScroll?: number;
	listSelected?: number;
	/** cockpit: focused panel id and its scroll. */
	cockpitPanel?: string;
	cockpitScroll?: number;
	/** kanban: active workflow filter (so W-cycling survives a Tab too). */
	workflow?: string;
}

/**
 * Holds the last-known UI state for every view across Tab switches. A single
 * instance lives for the whole runUnifiedView lifetime (alongside the single
 * screen and the ScreenLifecycleController).
 */
export class ViewStateStore {
	private readonly states = new Map<LifecycleView, ViewUiState>();

	/**
	 * Merge a partial snapshot into a view's retained state. Called on hide (Tab
	 * away) with whatever cursor/scroll the live widget currently holds. Undefined
	 * fields are ignored so a partial write never clobbers other retained fields.
	 */
	save(view: LifecycleView, patch: ViewUiState): void {
		const prev = this.states.get(view) ?? {};
		const next: ViewUiState = { ...prev };
		for (const [k, v] of Object.entries(patch) as [
			keyof ViewUiState,
			ViewUiState[keyof ViewUiState],
		][]) {
			if (v !== undefined) {
				(next[k] as ViewUiState[keyof ViewUiState]) = v;
			}
		}
		this.states.set(view, next);
	}

	/**
	 * Read a view's retained state for restore on show (Tab back). Returns a
	 * COPY so callers can't mutate the store by reference. Empty object if the
	 * view has never been shown.
	 */
	restore(view: LifecycleView): ViewUiState {
		return { ...(this.states.get(view) ?? {}) };
	}

	/** Whether any state has been retained for a view yet. */
	has(view: LifecycleView): boolean {
		return this.states.has(view);
	}

	/** Drop a view's retained state (e.g. after a hard data reload invalidates it). */
	clear(view: LifecycleView): void {
		this.states.delete(view);
	}

	/** Forget everything (final teardown). */
	reset(): void {
		this.states.clear();
	}
}
