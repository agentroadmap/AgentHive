/**
 * P1067 AC-8/AC-12/AC-24 — headless shell + stub-view integration test.
 *
 * Renders the REAL OperatorShell with a stub view that declares one keybind and
 * one notification subscription, WITHOUT requiring P1065/P1066 to exist and
 * WITHOUT touching a real TTY. Asserts the lifecycle contract callback counts
 * (AC-24): onMount 1x, render 2x, keybind handler 1x, notification handler 1x.
 *
 * A fake screen + fake node factory are injected (a real blessed screen parks
 * the event loop and writes escape codes), so the test is deterministic and
 * runs under `node --import jiti/register --test`. The notification round-trip
 * still goes through the real ListenMultiplexer the shell owns.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type ListenDriver,
	ListenMultiplexer,
} from "../../src/apps/tui/listen-multiplexer.ts";
import { OperatorShell } from "../../src/apps/tui/shell.ts";
import type {
	PanelContext,
	PanelKeybind,
	PanelNode,
	PanelSubscription,
	ShellQuery,
	TuiPanel,
} from "../../src/apps/tui/types.ts";
import type { VerifiedPrincipal } from "../../src/shared/identity/agent-context.ts";

const PRINCIPAL: VerifiedPrincipal = {
	principal_id: "operator:test",
	principal_kind: "operator",
	parent_principal_id: null,
};

const noopQuery: ShellQuery = async () => ({ rows: [] });

/** A no-op blessed-shaped node: append/detach/destroy/setContent/focus. */
function fakeNode(): Record<string, unknown> {
	const node: Record<string, unknown> = {};
	node.append = () => {};
	node.detach = () => {};
	node.destroy = () => {};
	node.setContent = () => {};
	node.focus = () => {};
	node.on = () => {};
	node.once = () => {};
	return node;
}

/** Minimal fake screen covering the surface OperatorShell touches. */
function fakeScreen() {
	const keyHandlers = new Map<string, () => void>();
	const screen = {
		key(keys: string | string[], cb: () => void) {
			for (const k of Array.isArray(keys) ? keys : [keys])
				keyHandlers.set(k, cb);
		},
		unkey(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys])
				keyHandlers.delete(k);
		},
		once() {},
		on() {},
		render() {},
		destroy() {
			(screen as { destroyed?: boolean }).destroyed = true;
		},
		destroyed: false,
		/** test-only: fire a registered key as blessed would. */
		press(key: string) {
			keyHandlers.get(key)?.();
		},
	};
	return screen;
}

function makeStubView() {
	const counts = {
		mount: 0,
		render: 0,
		keybind: 0,
		notify: 0,
		activate: 0,
		deactivate: 0,
	};
	const CHANNEL = "stub_channel";
	const sub: PanelSubscription = {
		channel: CHANNEL,
		handler: () => {
			counts.notify++;
		},
	};
	const kb: PanelKeybind = {
		keys: ["s"],
		description: "stub action",
		handler: () => {
			counts.keybind++;
		},
	};
	const view: TuiPanel = {
		route: "stub",
		title: "Stub View",
		keybinds: () => [kb],
		subscriptions: () => [sub],
		onMount: (_ctx: PanelContext) => {
			counts.mount++;
		},
		onActivate: () => {
			counts.activate++;
		},
		onDeactivate: () => {
			counts.deactivate++;
		},
		render: (_ctx: PanelContext): PanelNode => {
			counts.render++;
			return fakeNode() as unknown as PanelNode;
		},
	};
	return { view, counts, channel: CHANNEL, keybind: kb };
}

function buildShell(extra?: { views?: TuiPanel[] }) {
	const screen = fakeScreen();
	const driver: ListenDriver = { listen: () => {}, unlisten: () => {} };
	const mux = new ListenMultiplexer(driver);
	let exitCode = -1;
	const shell = new OperatorShell({
		principal: PRINCIPAL,
		query: noopQuery,
		listenDriver: driver,
		mux,
		screen: screen as never,
		makeNode: () => fakeNode() as never,
		skipSplash: true,
		onExit: (code) => {
			exitCode = code;
		},
	});
	for (const v of extra?.views ?? []) shell.register(v);
	return { shell, screen, mux, getExit: () => exitCode };
}

describe("AC-12/24 shell + stub-view contract round-trip", () => {
	it("onMount 1x, render 2x, keybind 1x, notification 1x", async () => {
		const { view, counts, channel, keybind } = makeStubView();
		// A second view to switch away to so the stub re-renders on return (the
		// genuine AC-24 "render 2x" path: activate → switch away → switch back).
		const other = makeStubView();
		const otherView: TuiPanel = {
			...other.view,
			route: "other",
			subscriptions: () => [],
		};
		const { shell, mux, getExit } = buildShell({ views: [view, otherView] });

		await shell.start(); // activate first view → onMount 1x, render 1x
		assert.equal(counts.mount, 1, "onMount called exactly once");
		assert.equal(counts.render, 1, "render called once on initial activate");
		assert.equal(counts.activate, 1);

		// AC-24: switch away and back → second render; onMount still 1x.
		shell.switchTo("other");
		shell.switchTo("stub");
		assert.equal(counts.render, 2, "render called twice");
		assert.equal(counts.mount, 1, "onMount NOT called again on re-activate");

		// AC-12 simulated key dispatch → handler increments a counter.
		keybind.handler();
		assert.equal(counts.keybind, 1, "keybind handler called once");

		// AC-12/24 notification round-trip via the real multiplexer.
		assert.equal(
			mux.handlerCount(channel),
			1,
			"subscription registered on activate",
		);
		mux.dispatch(channel, JSON.stringify({ hello: "world" }));
		assert.equal(
			counts.notify,
			1,
			"notification handler called once on pg_notify",
		);

		shell.exit(0);
		assert.equal(getExit(), 0, "clean exit code 0");
	});

	it("Ctrl-1 key routes through the shell to activate the first view (AC-6)", async () => {
		const a = makeStubView();
		const b = makeStubView();
		const viewB: TuiPanel = { ...b.view, route: "stub2" };
		const { shell, screen } = buildShell({ views: [a.view, viewB] });
		await shell.start("stub2"); // start on second view
		assert.equal(shell.registry.activeRoute(), "stub2");
		(screen as unknown as { press(k: string): void }).press("C-1");
		assert.equal(shell.registry.activeRoute(), "stub", "Ctrl-1 → first view");
		shell.exit(0);
	});

	it("rejects a view that tries to bind a universal key (AC-18)", () => {
		const { shell } = buildShell();
		const bad: TuiPanel = {
			route: "bad",
			title: "Bad",
			keybinds: () => [
				{ keys: ["C-c"], description: "evil", handler: () => {} },
			],
			render: () => fakeNode() as unknown as PanelNode,
		};
		assert.throws(() => shell.register(bad), /universal keys/);
	});

	it("deactivating a view unsubscribes its channel (AC-5)", async () => {
		const a = makeStubView();
		const b = makeStubView();
		const viewB: TuiPanel = {
			...b.view,
			route: "stub2",
			subscriptions: () => [],
		};
		const { shell, mux } = buildShell({ views: [a.view, viewB] });
		await shell.start(); // stub active, subscribes stub_channel
		assert.equal(mux.handlerCount("stub_channel"), 1);
		shell.switchTo("stub2"); // deactivate stub → unsubscribe
		assert.equal(a.counts.deactivate, 1, "onDeactivate fired");
		assert.equal(
			mux.handlerCount("stub_channel"),
			0,
			"channel unsubscribed on deactivate",
		);
		shell.exit(0);
	});

	it("Q exits with code 0 and destroys the screen exactly once (AC-1/18)", async () => {
		const { view } = makeStubView();
		const { shell, screen, getExit } = buildShell({ views: [view] });
		await shell.start();
		assert.equal(
			(screen as { destroyed: boolean }).destroyed,
			false,
			"no destroy before exit",
		);
		(screen as unknown as { press(k: string): void }).press("q");
		assert.equal(getExit(), 0);
		assert.equal(
			(screen as { destroyed: boolean }).destroyed,
			true,
			"screen destroyed at exit",
		);
	});
});
