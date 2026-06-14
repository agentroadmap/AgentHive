/**
 * P1139 — Screen-lifecycle state machine (pure, TTY-free).
 *
 * BACKGROUND / WHY THIS MODULE EXISTS
 * -----------------------------------
 * The unified TUI (`roadmap board` → runUnifiedView) cycles five views with
 * Tab: proposal-list → kanban → cockpit → headlines → chat → (back to)
 * proposal-list. Today each view renderer calls `createScreen()` (a fresh
 * blessed program + screen) and, on Tab, calls `screen.destroy()` before the
 * loop advances and the NEXT renderer calls `createScreen()` again.
 *
 * P247 asked Tab to cycle views without that per-view destroy/recreate churn.
 * A prior P1139 attempt (main commits b665e98f / 6425d700, REVERTED as
 * 86521590 / 3e0bfd31) tried to make every renderer share one cached screen
 * and hide/show containers. It regressed to BLACK SCREENS because:
 *   1. blessed allows many screens but only ONE program owns the terminal;
 *      destroy()+recreate handed stdout ownership around and a later screen
 *      never fully re-claimed it.
 *   2. several renderers (headlines.ts, chat.ts) do
 *      `screen.children.forEach(c => c.destroy())` on render — which, on a
 *      SHARED screen, destroyed OTHER views' cached containers.
 *   3. there was no headless test asserting the load-bearing invariant
 *      (destroy-exactly-once), so the regression shipped.
 *
 * This module fixes cause (3) at the root and makes the policy enforceable in
 * ONE place rather than "remembered" in five renderers (the
 * wrapper-enforced-concerns principle, CONVENTIONS §4). It is pure: no blessed,
 * no TTY, no timers. The renderer loop consults it to decide, per Tab/quit:
 *   - which view is next (the P247 cycle), and
 *   - whether to destroy the shared screen now (ONLY at final exit).
 *
 * The matching test (screen-lifecycle.test.ts) drives this machine through full
 * Tab cycles plus quit against a fake screen and asserts `destroy` is called
 * EXACTLY ONCE — the guard the reverted attempt lacked.
 *
 * Integration is intentionally additive: this is the decision core. Wiring the
 * live renderers onto a shared screen is a separate, terminal-verified step
 * (see the integration notes at the bottom) so we do not repeat the blind
 * TTY rewrite that got reverted.
 */

/** The five cyclable views, in P247 Tab order. */
export type LifecycleView =
	| "proposal-list"
	| "proposal-detail"
	| "kanban"
	| "cockpit"
	| "headlines"
	| "chat";

/** Why a view yielded control back to the loop. */
export type ViewResult = "switch" | "exit";

/** What the loop should do with the shared screen after a view yields. */
export interface LifecycleStep {
	/** The view to render next (unchanged on exit). */
	nextView: LifecycleView;
	/**
	 * Whether the CURRENT view's container should be hidden (kept alive) rather
	 * than destroyed. True on every "switch"; false on "exit".
	 */
	hideCurrent: boolean;
	/**
	 * Whether the shared screen itself must be destroyed now. True ONLY on the
	 * terminal "exit" transition — never on a view switch. This is the
	 * load-bearing flag the black-screen regression violated.
	 */
	destroyScreen: boolean;
	/** Whether the loop should keep running. False once the screen is destroyed. */
	keepRunning: boolean;
}

/**
 * The Tab cycle order. proposal-detail collapses into the proposal slot: from
 * either proposal view, Tab advances to kanban (mirrors ViewSwitcher.switchView
 * and the unified-view loop's switch table).
 */
export function nextViewInCycle(current: LifecycleView): LifecycleView {
	switch (current) {
		case "proposal-list":
		case "proposal-detail":
			return "kanban";
		case "kanban":
			return "cockpit";
		case "cockpit":
			return "headlines";
		case "headlines":
			return "chat";
		case "chat":
			return "proposal-list";
		default:
			return current;
	}
}

/**
 * Pure transition: given the current view and why it yielded, decide the next
 * view and the screen-lifecycle actions. The screen is destroyed on, and only
 * on, the terminal exit — guaranteeing destroy-exactly-once across any number
 * of Tab cycles.
 */
export function stepLifecycle(
	current: LifecycleView,
	result: ViewResult,
): LifecycleStep {
	if (result === "exit") {
		return {
			nextView: current,
			hideCurrent: false,
			destroyScreen: true,
			keepRunning: false,
		};
	}
	return {
		nextView: nextViewInCycle(current),
		hideCurrent: true,
		destroyScreen: false,
		keepRunning: true,
	};
}

/** Minimal surface this controller needs from a blessed screen (test-fakeable). */
export interface DestroyableScreen {
	destroy(): void;
}

/**
 * Guards the single-destroy invariant at runtime. The renderer loop owns ONE
 * instance for the whole TUI process; every "destroy the screen" decision must
 * go through `requestDestroy()`, which is idempotent. This is what makes
 * AC-5 ("destroy exactly once") and AC-6 ("no per-view destruction") true by
 * construction instead of by discipline scattered across renderers.
 */
export class ScreenLifecycleController {
	private destroyed = false;
	private destroyCount = 0;

	constructor(private readonly screen: DestroyableScreen) {}

	/** True once the shared screen has been torn down. */
	get isDestroyed(): boolean {
		return this.destroyed;
	}

	/** How many times destroy() was actually invoked (tests assert === 1). */
	get destroyCallCount(): number {
		return this.destroyCount;
	}

	/**
	 * Apply a lifecycle step. Returns whether the loop should keep running.
	 * Destroys the screen at most once across the controller's lifetime, even
	 * if called repeatedly (defensive against double-resolve races).
	 */
	apply(step: LifecycleStep): boolean {
		if (step.destroyScreen) {
			this.requestDestroy();
		}
		return step.keepRunning && !this.destroyed;
	}

	/** Idempotent final teardown. Safe to call from multiple exit paths. */
	requestDestroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.destroyCount += 1;
		this.screen.destroy();
	}
}

/*
 * INTEGRATION NOTES (for the terminal-verified follow-up)
 * -------------------------------------------------------
 * Wiring `runUnifiedView` onto this controller, without repeating the reverted
 * black-screen mistake:
 *
 *   1. Create ONE screen at the top of runUnifiedView and wrap it:
 *        const controller = new ScreenLifecycleController(screen);
 *      Pass `screen` into every show*() renderer instead of calling
 *      createScreen() inside each (removes the 3 createScreen() calls at
 *      unified-view.ts:533/826/892, plus board.ts and proposal-viewer when
 *      launched from the unified loop).
 *
 *   2. Each renderer mounts its widgets under a per-view CONTAINER box
 *      (parent: screen) and, on Tab, resolves "switch" WITHOUT touching the
 *      screen. The loop then calls `stepLifecycle(current, "switch")` →
 *      `controller.apply(step)`; the next renderer `container.show()` +
 *      focus()s its own container.
 *      ⚠️ DO NOT keep the `screen.children.forEach(c => c.destroy())` calls in
 *      headlines.ts:33 and chat.ts:59 — on a shared screen those nuke other
 *      views' containers (root cause #2 of the revert). Replace with
 *      hide()/show() of the OWN container only.
 *
 *   3. On q/Ctrl-C, resolve "exit"; the loop calls stepLifecycle(...,"exit") →
 *      controller.apply → requestDestroy() (the ONLY destroy site, satisfying
 *      AC-6's "exactly one screen.destroy in src/apps/ui/").
 *
 *   4. Timers (cockpit/headlines/chat setInterval) move onto the container:
 *      pause on hide, resume on show (AC-4), rather than clearInterval on a
 *      destroy that no longer happens.
 *
 * Each of those four edits is small and local, but only verifiable on a live
 * TTY (the snapshot harness, AC-2/AC-4) — hence kept out of this pure,
 * unit-tested core.
 */
