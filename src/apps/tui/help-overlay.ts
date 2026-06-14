/**
 * P1067 AC-20 — help overlay content (pure).
 *
 * `?` opens a scrollable overlay; Esc/Q closes it. The overlay lists a Universal
 * section (shell-owned binds) plus one section per registered panel listing that
 * panel's keybinds. This module builds the plain-text body; shell.ts renders it
 * into a scrollable blessed box.
 */

import { ctrlNLabel } from "./keybinds.ts";
import { formatKeybindHint } from "./status-bar.ts";
import type { PanelKeybind } from "./types.ts";

export interface HelpPanelEntry {
	title: string;
	route: string;
	/** 1-based position → Ctrl-N binding. */
	index: number;
	keybinds: PanelKeybind[];
}

/** The fixed universal section shown at the top of every help overlay. */
export const UNIVERSAL_HELP: ReadonlyArray<{
	keys: string;
	description: string;
}> = [
	{ keys: "Ctrl-1..9", description: "switch to Nth view" },
	{ keys: "?", description: "toggle this help" },
	{ keys: "Esc", description: "close modal / help" },
	{ keys: "Q / Ctrl-C", description: "exit (confirms if a view is dirty)" },
];

/**
 * Render the full help body as plain text (no blessed tags). Sections:
 *   Universal
 *   <Ctrl-N> <Panel Title> ...
 */
export function buildHelpBody(panels: HelpPanelEntry[]): string {
	const lines: string[] = ["Universal", ""];
	for (const u of UNIVERSAL_HELP) {
		lines.push(`  ${u.keys.padEnd(12)} ${u.description}`);
	}
	for (const p of panels) {
		lines.push("", `${ctrlNLabel(p.index)}  ${p.title}`, "");
		if (p.keybinds.length === 0) {
			lines.push("  (no view-specific keybinds)");
			continue;
		}
		for (const kb of p.keybinds) {
			lines.push(`  ${formatKeybindHint(kb)}`);
		}
	}
	return lines.join("\n");
}
