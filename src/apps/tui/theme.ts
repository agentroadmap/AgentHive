/**
 * P1067 AC-9 / AC-21 — single semantic theme.
 *
 * Every panel imports colors from here; a grep for inline `fg:`/`bg:` literals
 * in panels returns zero hits. Two palettes (dark default, light) selectable via
 * the TUI_THEME env var or the --theme CLI arg.
 */

import type { ThemeColors } from "./types.ts";

export type ThemeName = "dark" | "light";

const DARK: ThemeColors = {
	bg: "black",
	fg: "white",
	accent: "cyan",
	muted: "gray",
	success: "green",
	warning: "yellow",
	danger: "red",
	selectionBg: "cyan",
	selectionFg: "black",
	border: "gray",
};

const LIGHT: ThemeColors = {
	bg: "white",
	fg: "black",
	accent: "blue",
	muted: "#666666",
	success: "#007700",
	warning: "#aa6600",
	danger: "#cc0000",
	selectionBg: "blue",
	selectionFg: "white",
	border: "#999999",
};

const PALETTES: Record<ThemeName, ThemeColors> = { dark: DARK, light: LIGHT };

/** Normalize an arbitrary string to a known theme name (default: dark). */
export function normalizeThemeName(name: string | undefined): ThemeName {
	return name === "light" ? "light" : "dark";
}

/**
 * Resolve the active theme. Precedence (highest first):
 *   1. explicit `override` (the --theme CLI arg)
 *   2. TUI_THEME env var
 *   3. dark default
 */
export function resolveTheme(
	override?: string,
	env: NodeJS.ProcessEnv = process.env,
): ThemeColors {
	const name = normalizeThemeName(override ?? env.TUI_THEME);
	return PALETTES[name];
}

/** Look up the palette for a known name (used by tests / splash). */
export function getTheme(name: ThemeName): ThemeColors {
	return PALETTES[name];
}
