/**
 * P1139 — TUI keybind routing (pure, TTY-free) for AC-8 (P247 Tab-cycle honor).
 *
 * P247 fixed the meaning of the two cycling keys so they stop fighting each
 * other across views:
 *
 *   - **Tab** is ALWAYS the *view* switcher. From any of the five views it
 *     advances proposal-list → kanban → cockpit → headlines → chat → (wrap).
 *     This mirrors the live loop in unified-view.ts and the pure cycle in
 *     screen-lifecycle.ts (`nextViewInCycle`). Tab MUST NOT change the
 *     workflow filter — that confusion is exactly what P247/P1139 untangle.
 *   - **W** is the *workflow* cycler, and ONLY inside the kanban view (where
 *     WORKFLOW_VIEWS / getAvailableWorkflows live, board.ts). Pressing W in
 *     cockpit/headlines/chat/proposal views is a no-op for workflow — there is
 *     no workflow concept to cycle there.
 *   - **q / Ctrl-C** is the single terminal exit (the only path that reaches
 *     ScreenLifecycleController.requestDestroy — AC-5/AC-6).
 *
 * This module is the pure decision table the live key handlers consult, so the
 * "Tab = view, W = workflow-in-kanban" rule is enforced in ONE place and is
 * unit-testable without a live blessed screen (the render itself is deferred to
 * a TTY session). It deliberately has no blessed / no I/O dependency.
 */

import type { LifecycleView } from "./screen-lifecycle.ts";

/** The high-level action a keypress maps to, given the current view. */
export type KeybindAction =
	/** Tab: advance to the next view in the P247 cycle. */
	| { kind: "switch-view" }
	/** W in kanban: advance to the next workflow filter. */
	| { kind: "cycle-workflow" }
	/** q / Ctrl-C: terminal exit (the only destroy path). */
	| { kind: "exit" }
	/** The key has no routed meaning in this view; let the view handle it. */
	| { kind: "ignore" };

/** Views in which the "W" key cycles the workflow filter. Kanban only. */
export function viewSupportsWorkflowCycle(view: LifecycleView): boolean {
	return view === "kanban";
}

/**
 * Normalize a blessed key name to the canonical token we route on. blessed
 * delivers Tab as "tab", Ctrl-C as "C-c"; letters arrive lower/upper depending
 * on shift. We fold case for letters so an unshifted "w" and shifted "W" both
 * route to workflow-cycle, matching the live board handler.
 */
export function normalizeKey(key: string): string {
	const k = key.trim();
	if (k.length === 1) return k.toLowerCase();
	return k.toLowerCase();
}

/**
 * The load-bearing routing decision: given the current view and the pressed
 * key, what should happen? This is the single source of truth that keeps Tab a
 * view switcher and W a workflow switcher (and only in kanban).
 */
export function routeKeybind(
	view: LifecycleView,
	rawKey: string,
): KeybindAction {
	const key = normalizeKey(rawKey);

	// Terminal exit — same keys the live loop binds (unified-view.ts q / C-c).
	if (key === "q" || key === "c-c") {
		return { kind: "exit" };
	}

	// Tab is ALWAYS the view switcher, in every view. Never workflow.
	if (key === "tab") {
		return { kind: "switch-view" };
	}

	// W cycles the workflow filter, but ONLY in kanban. Elsewhere it is inert
	// (no workflow concept) so the view's own handler may use it.
	if (key === "w") {
		return viewSupportsWorkflowCycle(view)
			? { kind: "cycle-workflow" }
			: { kind: "ignore" };
	}

	return { kind: "ignore" };
}

/**
 * Advance a workflow key within an available list (wrap-around). Pure helper
 * for the kanban "W" handler; mirrors board.ts getAvailableWorkflows() cycling.
 * Returns the first entry if the current one is unknown, and the unchanged
 * value when the list is empty.
 */
export function nextWorkflow(
	current: string,
	available: readonly string[],
): string {
	if (available.length === 0) return current;
	const idx = available.indexOf(current);
	if (idx === -1) return available[0];
	return available[(idx + 1) % available.length];
}
