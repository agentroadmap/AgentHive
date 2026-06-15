/**
 * P1067 — unit tests for the pure (TTY-free) operator-shell logic.
 *
 * Covers the headlessly-verifiable ACs:
 *   AC-3  ListenMultiplexer dedup + fan-out
 *   AC-5  switch state machine never destroys; unsub on deactivate
 *   AC-6  universal vs panel keybind routing
 *   AC-7/19  status bar segments + 24-char identity truncation
 *   AC-9/21  theme env/override resolution
 *   AC-11/23 CLI arg parsing
 *   AC-15 per-route state preservation + list/detail cursor math
 *   AC-20 help body sections
 *   AC-22 splash body
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTuiArgs, TuiArgError } from "../../src/apps/tui/cli-args.ts";
import { buildHelpBody } from "../../src/apps/tui/help-overlay.ts";
import {
	isUniversalKey,
	rejectedPanelKeys,
	universalAction,
} from "../../src/apps/tui/keybinds.ts";
import {
	clampCursor,
	emptyListState,
	moveCursor,
	splitListDetail,
	visibleRange,
} from "../../src/apps/tui/list-detail.ts";
import {
	type ListenDriver,
	ListenMultiplexer,
} from "../../src/apps/tui/listen-multiplexer.ts";
import { PanelRegistry } from "../../src/apps/tui/registry.ts";
import { buildSplashBody } from "../../src/apps/tui/splash.ts";
import {
	buildStatusBar,
	truncateIdentity,
} from "../../src/apps/tui/status-bar.ts";
import { getTheme, resolveTheme } from "../../src/apps/tui/theme.ts";
import type { TuiPanel } from "../../src/apps/tui/types.ts";

// ── helpers ────────────────────────────────────────────────────────────────
function recordingDriver(): {
	driver: ListenDriver;
	listened: string[];
	unlistened: string[];
} {
	const listened: string[] = [];
	const unlistened: string[] = [];
	return {
		driver: {
			listen: (c) => {
				listened.push(c);
			},
			unlisten: (c) => {
				unlistened.push(c);
			},
		},
		listened,
		unlistened,
	};
}

function stubPanel(route: string, title = route): TuiPanel {
	return { route, title, render: () => ({}) as never };
}

// ── AC-3 ─────────────────────────────────────────────────────────────────────
describe("AC-3 ListenMultiplexer: one LISTEN per channel, fan-out to all", () => {
	it("panel A subs foo, B subs foo → exactly one LISTEN; both handlers fire", () => {
		const { driver, listened, unlistened } = recordingDriver();
		const mux = new ListenMultiplexer(driver);
		let aCount = 0;
		let bCount = 0;
		const a = () => aCount++;
		const b = () => bCount++;

		mux.subscribe("foo", a);
		mux.subscribe("foo", b);
		assert.equal(mux.listenCount(), 1, "only ONE LISTEN issued");
		assert.deepEqual(listened, ["foo"]);
		assert.equal(mux.handlerCount("foo"), 2);

		mux.dispatch("foo", "payload-1");
		assert.equal(aCount, 1);
		assert.equal(bCount, 1);

		// last subscriber leaving issues UNLISTEN
		mux.unsubscribe("foo", a);
		assert.equal(mux.listenCount(), 1, "still listening while B subscribed");
		assert.deepEqual(unlistened, []);
		mux.unsubscribe("foo", b);
		assert.equal(mux.listenCount(), 0);
		assert.deepEqual(unlistened, ["foo"]);
	});

	it("a throwing handler does not starve siblings", () => {
		const { driver } = recordingDriver();
		const mux = new ListenMultiplexer(driver);
		let bCount = 0;
		mux.subscribe("ch", () => {
			throw new Error("boom");
		});
		mux.subscribe("ch", () => bCount++);
		mux.dispatch("ch", undefined);
		assert.equal(bCount, 1);
	});

	it("resubscribeAll re-issues LISTEN for every active channel (AC-16)", () => {
		const { driver, listened } = recordingDriver();
		const mux = new ListenMultiplexer(driver);
		mux.subscribe("a", () => {});
		mux.subscribe("b", () => {});
		listened.length = 0;
		mux.resubscribeAll();
		assert.deepEqual(listened.sort(), ["a", "b"]);
	});
});

// ── AC-5 ─────────────────────────────────────────────────────────────────────
describe("AC-5 switch state machine: no destroy, plans deactivate→activate", () => {
	it("registers, switches 5x, never produces a destroy and tracks active", () => {
		const reg = new PanelRegistry();
		reg.register(stubPanel("board"));
		reg.register(stubPanel("headlines"));
		assert.equal(reg.count(), 2);

		const seq = ["headlines", "board", "headlines", "board", "headlines"];
		let prev = reg.activeRoute(); // null
		for (const r of seq) {
			const plan = reg.switchTo(r);
			assert.equal(plan.activate, r);
			assert.equal(plan.deactivate, prev);
			prev = r;
		}
		assert.equal(reg.activeRoute(), "headlines");
	});

	it("switching to the active route is a no-op", () => {
		const reg = new PanelRegistry();
		reg.register(stubPanel("a"));
		reg.switchTo("a");
		const plan = reg.switchTo("a");
		assert.equal(plan.noop, true);
		assert.equal(plan.deactivate, null);
	});

	it("unknown route is a no-op (never clears the screen)", () => {
		const reg = new PanelRegistry();
		reg.register(stubPanel("a"));
		reg.switchTo("a");
		const plan = reg.switchTo("does-not-exist");
		assert.equal(plan.noop, true);
		assert.equal(plan.activate, null);
		assert.equal(reg.activeRoute(), "a");
	});

	it("duplicate route registration throws", () => {
		const reg = new PanelRegistry();
		reg.register(stubPanel("a"));
		assert.throws(() => reg.register(stubPanel("a")), /already registered/);
	});

	it("AC-15 Ctrl-N switches to Nth (1-based); out of range no-op", () => {
		const reg = new PanelRegistry();
		reg.register(stubPanel("first"));
		reg.register(stubPanel("second"));
		assert.equal(reg.switchToNth(2).activate, "second");
		assert.equal(reg.switchToNth(9).noop, true);
	});
});

// ── AC-15 list/detail + preserved state ──────────────────────────────────────
describe("AC-15 per-route state preservation + list/detail cursor math", () => {
	it("registry preserves opaque per-route state across switches", () => {
		const reg = new PanelRegistry();
		reg.register(stubPanel("board"));
		reg.saveState("board", { cursor: 4, filter: "online" });
		assert.deepEqual(reg.loadState("board"), { cursor: 4, filter: "online" });
		assert.equal(reg.hasState("board"), true);
		assert.equal(reg.hasState("other"), false);
	});

	it("moveCursor clamps and scrolls the viewport window", () => {
		let s = emptyListState();
		s = moveCursor(s, 5, 10, 4); // cursor 5, viewport 4 → top 2
		assert.equal(s.cursor, 5);
		assert.equal(s.top, 2);
		s = moveCursor(s, 100, 10, 4); // clamp to last
		assert.equal(s.cursor, 9);
		assert.equal(s.top, 6);
		s = moveCursor(s, -100, 10, 4); // back to top
		assert.equal(s.cursor, 0);
		assert.equal(s.top, 0);
	});

	it("clampCursor handles empty + out of range", () => {
		assert.equal(clampCursor(3, 0), 0);
		assert.equal(clampCursor(-1, 5), 0);
		assert.equal(clampCursor(99, 5), 4);
	});

	it("splitListDetail partitions width with no overflow", () => {
		const { listWidth, detailWidth } = splitListDetail(100, 0.4);
		assert.equal(listWidth, 40);
		assert.equal(detailWidth, 60);
		assert.equal(listWidth + detailWidth, 100);
	});

	it("visibleRange returns clamped window", () => {
		const s = { cursor: 0, top: 8, filter: "" };
		assert.deepEqual(visibleRange(s, 10, 5), { start: 8, end: 10 });
	});
});

// ── AC-6 keybind routing ─────────────────────────────────────────────────────
describe("AC-6/18 universal vs panel keybind routing", () => {
	it("universal keys are recognised and panels cannot bind them", () => {
		assert.equal(isUniversalKey("C-c"), true);
		assert.equal(isUniversalKey("C-1"), true);
		assert.equal(isUniversalKey("j"), false);
		assert.deepEqual(rejectedPanelKeys(["j", "C-c", "enter", "?"]), [
			"C-c",
			"?",
		]);
		assert.deepEqual(rejectedPanelKeys(["j", "k", "enter"]), []);
	});

	it("universalAction maps keys to shell actions", () => {
		assert.deepEqual(universalAction("q"), { kind: "exit" });
		assert.deepEqual(universalAction("C-c"), { kind: "exit" });
		assert.deepEqual(universalAction("?"), { kind: "help" });
		assert.deepEqual(universalAction("escape"), { kind: "closeModal" });
		assert.deepEqual(universalAction("C-3"), { kind: "switchNth", n: 3 });
		assert.deepEqual(universalAction("j"), { kind: "none" });
	});
});

// ── AC-7/19 status bar ───────────────────────────────────────────────────────
describe("AC-7/19 status bar: 3 segments, identity ≤24 chars", () => {
	it("truncates identity to 24 chars with ellipsis", () => {
		const long = "operator:" + "x".repeat(40);
		const t = truncateIdentity(long);
		assert.equal(t.length, 24);
		assert.ok(t.endsWith("…"));
		assert.equal(truncateIdentity("short"), "short");
	});

	it("builds three segments and reflects active panel keybinds", () => {
		const bar = buildStatusBar({
			panelName: "Presence Board",
			identity: "operator:gary",
			keybinds: [
				{ keys: ["enter"], description: "inspect", handler: () => {} },
			],
		});
		const parts = bar.split(" | ");
		assert.equal(parts[0], "Presence Board");
		assert.equal(parts[1], "operator:gary");
		assert.match(parts[2], /\[enter\] inspect/);
	});
});

// ── AC-9/21 theme ────────────────────────────────────────────────────────────
describe("AC-9/21 theme: semantic colors, env + override", () => {
	it("exports semantic colors", () => {
		const dark = getTheme("dark");
		assert.equal(typeof dark.success, "string");
		assert.equal(typeof dark.danger, "string");
	});

	it("TUI_THEME=light selects the light palette; override beats env", () => {
		const light = resolveTheme(undefined, {
			TUI_THEME: "light",
		} as NodeJS.ProcessEnv);
		assert.deepEqual(light, getTheme("light"));
		const overridden = resolveTheme("dark", {
			TUI_THEME: "light",
		} as NodeJS.ProcessEnv);
		assert.deepEqual(overridden, getTheme("dark"));
		assert.deepEqual(
			resolveTheme(undefined, {} as NodeJS.ProcessEnv),
			getTheme("dark"),
		);
	});
});

// ── AC-11/23 CLI args ────────────────────────────────────────────────────────
describe("AC-11/23 CLI arg parsing", () => {
	it("parses --view, --theme, --debug", () => {
		const a = parseTuiArgs(["--view", "board", "--theme", "light", "--debug"]);
		assert.equal(a.view, "board");
		assert.equal(a.theme, "light");
		assert.equal(a.debug, true);
	});

	it("throws when a value-taking flag is missing its value", () => {
		assert.throws(() => parseTuiArgs(["--view"]), TuiArgError);
		assert.throws(() => parseTuiArgs(["--view", "--debug"]), TuiArgError);
	});

	it("collects unknown tokens", () => {
		const a = parseTuiArgs(["--wat", "x"]);
		assert.deepEqual(a.unknown, ["--wat", "x"]);
	});
});

// ── AC-20 help body ──────────────────────────────────────────────────────────
describe("AC-20 help overlay body", () => {
	it("lists Universal section + each view's keybinds", () => {
		const body = buildHelpBody([
			{
				title: "Board",
				route: "board",
				index: 1,
				keybinds: [{ keys: ["enter"], description: "open", handler: () => {} }],
			},
			{ title: "Config", route: "config", index: 2, keybinds: [] },
		]);
		assert.match(body, /Universal/);
		assert.match(body, /Ctrl-1\s+Board/);
		assert.match(body, /\[enter\] open/);
		assert.match(body, /Ctrl-2\s+Config/);
		assert.match(body, /no view-specific keybinds/);
	});
});

// ── AC-22 splash ─────────────────────────────────────────────────────────────
describe("AC-22 splash body", () => {
	it("shows identity, auth status, and Ctrl-N view bindings", () => {
		const body = buildSplashBody({
			identity: "operator:gary",
			authStatus: "operator verified",
			views: [
				{ title: "Board", route: "board" },
				{ title: "Config", route: "config" },
			],
		});
		assert.match(body, /identity : operator:gary/);
		assert.match(body, /auth\s+: operator verified/);
		assert.match(body, /Ctrl-1\s+Board/);
		assert.match(body, /Ctrl-2\s+Config/);
	});
});
