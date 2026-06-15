/**
 * P1139 — headless tests for the per-view timer lifecycle (AC-4).
 * Proves timers PAUSE when hidden, RESUME when shown, never double-arm, and
 * leak nothing on dispose — all with a fake clock, no real intervals/TTY.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import {
	type IntervalHandle,
	type TimerHooks,
	ViewTimerRegistry,
} from "./view-timer-registry.ts";

/** Deterministic fake clock: armed callbacks fire only when we tick(). */
class FakeClock {
	private next = 1;
	private readonly live = new Map<number, () => void>();
	setCount = 0;
	clearCount = 0;

	hooks: TimerHooks = {
		set: (fn) => {
			this.setCount += 1;
			const id = this.next++;
			this.live.set(id, fn);
			return id as unknown as IntervalHandle;
		},
		clear: (handle) => {
			this.clearCount += 1;
			this.live.delete(handle as unknown as number);
		},
	};

	/** Fire every currently-armed timer once. */
	tick(): void {
		for (const fn of this.live.values()) fn();
	}

	get liveCount(): number {
		return this.live.size;
	}
}

describe("P1139 AC-4 ViewTimerRegistry — pause on hide, resume on show", () => {
	test("a registered timer does not fire until the view is shown", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		let fires = 0;
		reg.register(() => fires++, 1000);

		// Not shown yet → nothing armed, nothing fires.
		assert.strictEqual(reg.activeCount, 0);
		clock.tick();
		assert.strictEqual(fires, 0, "hidden timer must not fire");

		reg.show();
		assert.strictEqual(reg.activeCount, 1);
		clock.tick();
		assert.strictEqual(fires, 1, "shown timer fires");
	});

	test("hiding clears live timers so they stop firing", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		let fires = 0;
		reg.register(() => fires++, 500);
		reg.show();
		clock.tick();
		assert.strictEqual(fires, 1);

		reg.hide();
		assert.strictEqual(reg.activeCount, 0, "no live timers while hidden");
		assert.strictEqual(clock.liveCount, 0);
		clock.tick();
		assert.strictEqual(fires, 1, "no fire while hidden (AC-4)");
	});

	test("show → hide → show resumes without leaking a second interval", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		let fires = 0;
		reg.register(() => fires++, 100);

		reg.show();
		reg.hide();
		reg.show(); // resume
		// Exactly one live interval after resume — not two.
		assert.strictEqual(reg.activeCount, 1, "exactly one live timer after resume");
		assert.strictEqual(clock.liveCount, 1);
		clock.tick();
		assert.strictEqual(fires, 1, "single fire per tick, no duplicate interval");
	});

	test("registering while shown arms immediately; while hidden stays dormant", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		reg.show();
		reg.register(() => {}, 100); // arms now
		assert.strictEqual(reg.activeCount, 1);
		reg.hide();
		reg.register(() => {}, 100); // dormant
		assert.strictEqual(reg.activeCount, 0);
		assert.strictEqual(reg.size, 2);
	});
});

describe("P1139 AC-4 ViewTimerRegistry — no leaked intervals on dispose", () => {
	test("dispose clears every live timer and forgets registrations", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		reg.register(() => {}, 100);
		reg.register(() => {}, 200);
		reg.show();
		assert.strictEqual(clock.liveCount, 2);

		reg.dispose();
		assert.strictEqual(clock.liveCount, 0, "all intervals cleared on dispose");
		assert.strictEqual(reg.activeCount, 0);
		assert.strictEqual(reg.size, 0, "registrations forgotten");
	});

	test("dispose is idempotent and blocks late registers", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		reg.register(() => {}, 100);
		reg.show();
		reg.dispose();
		reg.dispose(); // no throw, no extra clears
		reg.register(() => {}, 100); // no-op after dispose
		reg.show();
		assert.strictEqual(reg.activeCount, 0);
		assert.strictEqual(clock.liveCount, 0);
	});

	test("hide before any show is a safe no-op", () => {
		const clock = new FakeClock();
		const reg = new ViewTimerRegistry(clock.hooks);
		reg.register(() => {}, 100);
		reg.hide(); // never shown
		assert.strictEqual(reg.activeCount, 0);
		assert.strictEqual(clock.clearCount, 0);
	});
});
