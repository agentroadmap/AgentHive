/**
 * P1139 — headless tests for the screen-lifecycle state machine.
 *
 * The blessed render itself needs a live TTY and is verified via the snapshot
 * harness (AC-2/AC-4). Here we exercise the pure transition + the destroy-once
 * controller that the unified-view loop consults — the guard the REVERTED
 * P1139 attempt lacked (it shipped a black-screen regression with no headless
 * coverage of the destroy-exactly-once invariant).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import {
	type DestroyableScreen,
	type LifecycleView,
	ScreenLifecycleController,
	nextViewInCycle,
	stepLifecycle,
} from "./screen-lifecycle.ts";

/** Fake screen that counts destroy() calls (the load-bearing assertion). */
class FakeScreen implements DestroyableScreen {
	destroyCalls = 0;
	destroy(): void {
		this.destroyCalls += 1;
	}
}

describe("P1139 nextViewInCycle — P247 Tab order", () => {
	test("full cycle returns to the start in exactly 5 hops", () => {
		const order: LifecycleView[] = [];
		let v: LifecycleView = "proposal-list";
		for (let i = 0; i < 5; i++) {
			v = nextViewInCycle(v);
			order.push(v);
		}
		assert.deepStrictEqual(order, [
			"kanban",
			"cockpit",
			"headlines",
			"chat",
			"proposal-list",
		]);
	});

	test("proposal-detail collapses into the proposal slot → kanban", () => {
		assert.strictEqual(nextViewInCycle("proposal-detail"), "kanban");
		assert.strictEqual(nextViewInCycle("proposal-list"), "kanban");
	});
});

describe("P1139 stepLifecycle — switch never destroys, exit always does", () => {
	test("switch hides current, advances view, keeps screen + loop alive", () => {
		const step = stepLifecycle("cockpit", "switch");
		assert.strictEqual(step.nextView, "headlines");
		assert.strictEqual(step.hideCurrent, true);
		assert.strictEqual(step.destroyScreen, false);
		assert.strictEqual(step.keepRunning, true);
	});

	test("exit destroys the screen and stops the loop, view unchanged", () => {
		const step = stepLifecycle("chat", "exit");
		assert.strictEqual(step.nextView, "chat");
		assert.strictEqual(step.hideCurrent, false);
		assert.strictEqual(step.destroyScreen, true);
		assert.strictEqual(step.keepRunning, false);
	});
});

describe("P1139 ScreenLifecycleController — destroy EXACTLY once (AC-5/AC-6)", () => {
	test("a full Tab cycle then quit destroys the screen exactly once", () => {
		const screen = new FakeScreen();
		const controller = new ScreenLifecycleController(screen);

		// Cycle through all five views via Tab. None of these may destroy.
		let view: LifecycleView = "proposal-list";
		for (let i = 0; i < 5; i++) {
			const step = stepLifecycle(view, "switch");
			const keepRunning = controller.apply(step);
			assert.strictEqual(keepRunning, true, `switch ${i} kept running`);
			assert.strictEqual(
				screen.destroyCalls,
				0,
				`no destroy during switch ${i}`,
			);
			view = step.nextView;
		}
		assert.strictEqual(view, "proposal-list", "cycle returned to start");

		// Now quit.
		const exitStep = stepLifecycle(view, "exit");
		const keepRunning = controller.apply(exitStep);
		assert.strictEqual(keepRunning, false, "loop stops after exit");
		assert.strictEqual(screen.destroyCalls, 1, "destroyed exactly once");
		assert.strictEqual(controller.destroyCallCount, 1);
		assert.strictEqual(controller.isDestroyed, true);
	});

	test("many cycles before exit still destroy exactly once", () => {
		const screen = new FakeScreen();
		const controller = new ScreenLifecycleController(screen);
		let view: LifecycleView = "kanban";
		for (let i = 0; i < 23; i++) {
			controller.apply(stepLifecycle(view, "switch"));
			view = nextViewInCycle(view);
		}
		assert.strictEqual(screen.destroyCalls, 0, "23 switches, zero destroys");
		controller.apply(stepLifecycle(view, "exit"));
		assert.strictEqual(screen.destroyCalls, 1);
	});

	test("idempotent: double-resolve / repeated exit cannot double-destroy", () => {
		const screen = new FakeScreen();
		const controller = new ScreenLifecycleController(screen);
		const exitStep = stepLifecycle("chat", "exit");
		controller.apply(exitStep);
		controller.apply(exitStep); // simulate a double-resolve race
		controller.requestDestroy(); // and a stray direct teardown
		assert.strictEqual(
			screen.destroyCalls,
			1,
			"destroy is idempotent across exit paths",
		);
	});

	test("apply after destruction never revives the loop", () => {
		const screen = new FakeScreen();
		const controller = new ScreenLifecycleController(screen);
		controller.apply(stepLifecycle("chat", "exit"));
		// A late switch step arriving after teardown must not keep running.
		const keepRunning = controller.apply(stepLifecycle("chat", "switch"));
		assert.strictEqual(keepRunning, false);
		assert.strictEqual(screen.destroyCalls, 1);
	});
});
