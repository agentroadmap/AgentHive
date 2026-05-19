/*
 * Lightweight wrapper around the `blessed` terminal UI library.
 *
 * Force the CommonJS blessed entrypoint so Node ESM execution does not hit
 * the upstream eastasianwidth interop bug in the package's ESM build.
 */

import { stdin as input, stdout as output } from "node:process";
import type {
	ProgramInterface,
	ScreenInterface,
	ScreenOptions,
} from "./blessed.ts";
import {
	screen as blessedScreen,
	box,
	program as createProgram,
} from "./blessed.ts";

type ErrorConstructor = new () => unknown;

function constructError(value: unknown): Error | undefined {
	if (typeof value !== "function") {
		return undefined;
	}

	try {
		const candidate = new (value as ErrorConstructor)();
		return candidate instanceof Error ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function normalizeToError(value: unknown): Error {
	if (value instanceof Error) {
		return value;
	}

	const constructed = constructError(value);
	if (constructed) {
		return constructed;
	}

	return new Error(String(value ?? "Unknown screen error"));
}

// Shared screen for the TUI session lifetime. P1139: one program owns the tty,
// per-view containers hide/show on top of this single screen.
//
// Why this exists: createProgram() per screen means subsequent programs claim
// stdin (so chat's textbox raw mode works) but write boxes to a stale stdout
// (so cockpit/headlines/chat box-chrome is invisible). Single screen = single
// program = stdout always lands in the live terminal.
//
// CRITICAL: we do NOT override screen.destroy in this revision. The 6c969b50
// attempt did that and broke chat's textbox raw-mode. Instead, callers must
// stop calling screen.destroy() during view-switch (only call it on final
// process exit via tui-shared-screen-shutdown).
let sharedScreen: ScreenInterface | null = null;

export function createScreen(
	options: Partial<ScreenOptions> = {},
): ScreenInterface {
	if (sharedScreen) {
		// Re-apply title if specified (per-view title still updates the terminal
		// chrome on supporting terminals).
		if (options.title) {
			try {
				(sharedScreen as unknown as { title?: string }).title = options.title;
			} catch { /* ignore */ }
		}
		return sharedScreen;
	}
	const program: ProgramInterface = createProgram({ tput: true });
	const fullUnicode = Boolean((program as { terminal?: { unicode?: boolean } }).terminal?.unicode);
	const screen = blessedScreen({
		smartCSR: true,
		program,
		fullUnicode,
		...options,
	});

	// Windows runners occasionally surface file system watcher errors as plain objects
	// (rather than Error instances). Blessed rethrows unhandled "error" events by
	// constructing the first argument, which explodes when it is a string. Attach a
	// defensive handler so these platform-specific events don't crash tests.
	screen.on("error", (err) => {
		const normalizedError = normalizeToError(err);
		if (process.env.DEBUG) {
			console.warn("TUI screen error", normalizedError);
		}
		throw normalizedError;
	});

	sharedScreen = screen;
	return screen;
}

/**
 * Final teardown of the shared screen. Call ONLY on process exit (q/Esc/Ctrl-C
 * after the user has finished). Do NOT call during view-switch.
 */
export function destroySharedScreen(): void {
	if (sharedScreen) {
		try {
			(sharedScreen as unknown as { destroy: () => void }).destroy();
		} catch { /* ignore */ }
		sharedScreen = null;
	}
}

// Ask the user for a single line of input.  Falls back to readline.
export async function promptText(
	message: string,
	defaultValue = "",
): Promise<string> {
	// Always use readline for simple text input to avoid blessed rendering quirks
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input, output });
	const answer = (await rl.question(`${message} `)).trim();
	rl.close();
	return answer || defaultValue;
}

// Ask the user for yes/no confirmation. Returns true for yes, false for no.
export async function promptConfirm(message: string): Promise<boolean> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input, output });
	const answer = (await rl.question(`${message} (y/n): `)).trim().toLowerCase();
	rl.close();
	return answer === "y" || answer === "yes";
}

// Display long content in a scrollable viewer.
export async function scrollableViewer(content: string): Promise<void> {
	if (output.isTTY === false) {
		console.log(content);
		return;
	}

	return new Promise<void>((resolve) => {
		const screen = createScreen({
			style: { fg: "white", bg: "black" },
		});

		const viewer = box({
			parent: screen,
			content,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			vi: true,
			mouse: true,
			width: "100%",
			height: "100%",
			padding: { left: 1, right: 1 },
			wrap: true,
		});

		screen.key(["escape", "q", "C-c"], () => {
			screen.destroy();
			resolve();
		});

		viewer.focus();
		screen.render();
	});
}
