/**
 * P1067 AC-7 / AC-19 — status bar content (pure).
 *
 * Three segments, joined by ` | `:
 *   1. active panel/view name
 *   2. operator identity, truncated to 24 chars
 *   3. active-panel context keybinds
 * Rebuilt on every panel switch; shell.ts wraps these strings in theme colour
 * tags and writes them into the blessed footer box.
 */

import type { PanelKeybind } from "./types.ts";

export const IDENTITY_MAX = 24;

/** Truncate an operator identity to AC-19's 24-char ceiling (ellipsis-aware). */
export function truncateIdentity(identity: string, max = IDENTITY_MAX): string {
	if (identity.length <= max) return identity;
	if (max <= 1) return identity.slice(0, max);
	return `${identity.slice(0, max - 1)}…`;
}

/** "[keys] description" fragment for one bind, e.g. "[enter] open". */
export function formatKeybindHint(kb: PanelKeybind): string {
	return `[${kb.keys.join("/")}] ${kb.description}`;
}

/** Join a panel's keybinds into a single context-hint string. */
export function formatContextKeybinds(keybinds: PanelKeybind[]): string {
	return keybinds.map(formatKeybindHint).join("  ");
}

/**
 * Build the full three-segment status bar text. `keybinds` reflect the ACTIVE
 * panel (AC-19: updates on every switch); pass [] for panels with no binds.
 */
export function buildStatusBar(args: {
	panelName: string;
	identity: string;
	keybinds: PanelKeybind[];
}): string {
	const ident = truncateIdentity(args.identity);
	const hints = formatContextKeybinds(args.keybinds);
	const segments = [args.panelName, ident];
	if (hints) segments.push(hints);
	return segments.join(" | ");
}
