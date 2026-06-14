/**
 * P1067 — TUI Operator Shell: public contracts (vendored for P1066).
 *
 * P1066's config-editor panel plugs into the P1067 shell. That shell is on the
 * (not-yet-merged) `feat/p1067-tui-operator-shell` branch, which owns the
 * canonical copy of this file. We vendor a byte-compatible copy here so the
 * P1066 panel compiles + unit-tests standalone against the same `TuiPanel`
 * contract; when P1067 merges, the shapes are identical and this file is
 * superseded by P1067's (the merge keeps a single declaration — they MUST stay
 * structurally identical).
 *
 * Source of truth: `git show feat/p1067-tui-operator-shell:src/apps/tui/types.ts`.
 */

import type { VerifiedPrincipal } from "../../shared/identity/agent-context.ts";
import type {
	BoxInterface,
	ElementInterface,
	ScreenInterface,
} from "../ui/blessed.ts";

/** A blessed node a panel hands back from render(). */
export type PanelNode = ElementInterface | BoxInterface;

/**
 * A pg_notify subscription a panel declares. The shell owns exactly ONE LISTEN
 * client (P1067 AC-3/AC-16); panels never open their own connection. `channel`
 * is the NOTIFY channel; `handler` is invoked with the raw payload string.
 */
export interface PanelSubscription {
	channel: string;
	handler: (payload: string | undefined) => void;
}

/**
 * A keybind a panel declares. `keys` are blessed key names (e.g. ["enter"],
 * ["j", "down"]). The shell only dispatches these while the panel is active.
 * Universal/shell-owned binds (Q, Ctrl-C, ?, Esc, Ctrl-1..9) are NOT delegable
 * to panels (P1067 AC-18) and are rejected at registration.
 */
export interface PanelKeybind {
	keys: string[];
	/** Short label shown in the status bar / help overlay. */
	description: string;
	handler: () => void;
}

/**
 * Shell-facing query surface a panel uses instead of opening its own DB
 * connection (P1067 AC-10). Backed by the shared pool in production, a stub in
 * tests.
 */
export type ShellQuery = <R = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<{ rows: R[] }>;

/** Operations the shell exposes to panels (switch, exit, redraw). */
export interface ShellHandle {
	switchPanel(route: string): void;
	render(): void;
	exit(code?: number): void;
	routes(): string[];
}

/** Semantic theme handed to panels; never raw fg:/bg: literals (P1067 AC-21). */
export interface ThemeColors {
	bg: string;
	fg: string;
	accent: string;
	muted: string;
	success: string;
	warning: string;
	danger: string;
	selectionBg: string;
	selectionFg: string;
	border: string;
}

/**
 * Context passed to EVERY panel method (P1067 AC-4). Carries the shared screen,
 * the single resolved principal (AC-17), the LISTEN multiplexer, the query
 * surface, the shell handle, and the active theme.
 */
export interface PanelContext {
	screen: ScreenInterface;
	principal: VerifiedPrincipal;
	listen: {
		subscribe(channel: string, handler: (p: string | undefined) => void): void;
		unsubscribe(
			channel: string,
			handler: (p: string | undefined) => void,
		): void;
	};
	query: ShellQuery;
	shell: ShellHandle;
	theme: ThemeColors;
}

/**
 * The contract P1065/P1066 panels implement. Lifecycle (P1067 AC-5):
 *   onMount  → once, when registered/first mounted into the shell.
 *   render   → returns the blessed node for the shared screen.
 *   onActivate / onDeactivate → as the operator switches panels.
 *   isDirty  → if true, Q/Ctrl-C prompts for confirm (AC-18).
 */
export interface TuiPanel {
	readonly route: string;
	readonly title: string;
	keybinds?(): PanelKeybind[];
	subscriptions?(): PanelSubscription[];
	onMount?(ctx: PanelContext): void;
	render(ctx: PanelContext): PanelNode;
	onActivate?(ctx: PanelContext): void;
	onDeactivate?(ctx: PanelContext): void;
	isDirty?(): boolean;
}

/** AC-2/AC-14 structural alias: a `TuiView` is exactly a `TuiPanel`. */
export type TuiView = TuiPanel;
