/**
 * P1067 AC-2 — reference TuiPanel implementations.
 *
 * Two minimal panels that implement the `TuiPanel` contract so the foundation
 * shell boots standalone and AC-2 ("2+ panels implement it (board, headlines)")
 * is satisfied WITHOUT pulling in P1065/P1066's full feature scope. These are
 * deliberately thin: they prove the interface is implementable and give the
 * `--view board|headlines` smoke-launch something to render.
 *
 * P1065 replaces `boardPanel` with the real presence board; P1066 adds the
 * config editor. Both follow the exact shape declared here.
 *
 * NOTE: all queries go through ctx.query (AC-10) — no panel-level pg connection.
 * NOTE: colours come from ctx.theme (AC-21) — no inline fg:/bg: literals here.
 */

import { box } from "../../ui/blessed.ts";
import type { PanelContext, PanelNode, TuiPanel } from "../types.ts";

/** A board panel skeleton (P1065 fills in the live presence table). */
export const boardPanel: TuiPanel = {
	route: "board",
	title: "Presence Board",
	keybinds: () => [
		{ keys: ["enter"], description: "inspect agent", handler: () => {} },
		{ keys: ["r"], description: "refresh", handler: () => {} },
	],
	subscriptions: () => [{ channel: "agency_presence", handler: () => {} }],
	render(ctx: PanelContext): PanelNode {
		return box({
			parent: ctx.screen,
			top: 0,
			left: 0,
			width: "100%",
			height: "100%-1",
			content: "Presence Board — agencies appear here (P1065).",
			style: { fg: ctx.theme.fg, bg: ctx.theme.bg },
		});
	},
};

/** A headlines panel skeleton (full-width event stream). */
export const headlinesPanel: TuiPanel = {
	route: "headlines",
	title: "Headlines",
	keybinds: () => [
		{ keys: ["pageup", "pagedown"], description: "scroll", handler: () => {} },
	],
	subscriptions: () => [{ channel: "roadmap_events", handler: () => {} }],
	render(ctx: PanelContext): PanelNode {
		return box({
			parent: ctx.screen,
			top: 0,
			left: 0,
			width: "100%",
			height: "100%-1",
			content: "Headlines — live event stream.",
			style: { fg: ctx.theme.fg, bg: ctx.theme.bg },
		});
	},
};

export const examplePanels: TuiPanel[] = [boardPanel, headlinesPanel];
