/**
 * P1067 AC-22 — startup splash content (pure).
 *
 * The ~2s splash shows the resolved operator identity, auth status, and the
 * available views with their Ctrl-N bindings, then transitions to the first
 * view. This builds the splash body text; shell.ts renders + times it.
 */

import { ctrlNLabel } from "./keybinds.ts";

export interface SplashView {
	title: string;
	route: string;
}

export interface SplashModel {
	identity: string;
	authStatus: string;
	views: SplashView[];
}

/** Default splash dwell before transitioning to the first view (AC-22). */
export const SPLASH_MS = 2_000;

/** Render the splash body as plain text. */
export function buildSplashBody(model: SplashModel): string {
	const lines = [
		"AgentHive — Operator Shell",
		"",
		`identity : ${model.identity}`,
		`auth     : ${model.authStatus}`,
		"",
		"views:",
	];
	if (model.views.length === 0) {
		lines.push("  (no views registered)");
	} else {
		model.views.forEach((v, i) => {
			lines.push(`  ${ctrlNLabel(i + 1).padEnd(8)} ${v.title}`);
		});
	}
	return lines.join("\n");
}
