/**
 * P1067 — TUI Operator Shell: public contracts.
 *
 * This is the FOUNDATION shell that P1065 (presence board) and P1066 (config
 * editor) plug into. The interfaces here are the stable contract those panels
 * implement; keep them blessed-light and side-effect-free so panels can be
 * unit-tested without a TTY.
 *
 * Terminology note: the AC set uses both "panel" (AC-1..12) and "view"
 * (AC-11..24) for the same concept. We declare ONE interface, `TuiPanel`, and
 * export `TuiView` as a structural alias so either name satisfies callers.
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
 * client (AC-3/AC-16); panels never open their own connection. `channel` is the
 * NOTIFY channel; `handler` is invoked with the raw payload string.
 */
export interface PanelSubscription {
	channel: string;
	handler: (payload: string | undefined) => void;
}

/**
 * A keybind a panel declares. `keys` are blessed key names (e.g. ["enter"],
 * ["j", "down"]). The shell only dispatches these while the panel is active.
 * Universal/shell-owned binds (Q, Ctrl-C, ?, Esc, Ctrl-1..9) are NOT delegable
 * to panels (AC-18) and are rejected at registration.
 */
export interface PanelKeybind {
	keys: string[];
	/** Short label shown in the status bar / help overlay. */
	description: string;
	handler: () => void;
}

/**
 * Shell-facing query surface a panel uses instead of opening its own DB
 * connection (AC-10). Backed by the shared pool in production, a stub in tests.
 */
export type ShellQuery = <R = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<{ rows: R[] }>;

/** Operations the shell exposes to panels (switch, exit, redraw). */
export interface ShellHandle {
	/** Activate a registered panel by its route. No-op if already active. */
	switchPanel(route: string): void;
	/** Request a re-render of the shared screen. */
	render(): void;
	/** Begin graceful shutdown (honors isDirty confirm at the shell level). */
	exit(code?: number): void;
	/** Routes of all registered panels, in registration order. */
	routes(): string[];
}

/** Semantic theme handed to panels; never raw fg:/bg: literals (AC-21). */
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
 * Context passed to EVERY panel method (AC-4). Carries the shared screen, the
 * single resolved principal (AC-17), the LISTEN multiplexer, the query surface,
 * the shell handle, and the active theme.
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
 * The contract P1065/P1066 panels implement. Lifecycle (AC-5):
 *   onMount  → once, when registered/first mounted into the shell.
 *   render   → returns the blessed node for the shared screen; may be called
 *              multiple times (e.g. on activate + on data change).
 *   onActivate / onDeactivate → as the operator switches panels; the shell
 *              wires up keybinds + subscriptions on activate and tears them down
 *              on deactivate WITHOUT destroying the shared screen.
 *   isDirty  → if true, Q/Ctrl-C prompts for confirm (AC-18).
 */
export interface TuiPanel {
	/** Stable identifier used by --view and switchPanel(). */
	readonly route: string;
	/** Human label shown in the status bar + splash (AC-19/AC-22). */
	readonly title: string;
	/** Ctrl-N binding (1-based) the shell assigns; informational for help. */
	keybinds?(): PanelKeybind[];
	subscriptions?(): PanelSubscription[];
	onMount?(ctx: PanelContext): void;
	render(ctx: PanelContext): PanelNode;
	onActivate?(ctx: PanelContext): void;
	onDeactivate?(ctx: PanelContext): void;
	isDirty?(): boolean;
}

/**
 * AC-2/AC-14 structural alias: a `TuiView` is exactly a `TuiPanel`. Panels may
 * be authored against either name. Do not diverge these shapes.
 */
export type TuiView = TuiPanel;
