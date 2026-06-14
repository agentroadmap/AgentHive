/**
 * P1067 AC-6 / AC-18 — keybind routing (pure).
 *
 * Two tiers:
 *   - Universal, shell-owned, NON-delegable: Q / Ctrl-C (exit, confirm if dirty),
 *     ? (help), Esc (close modal), Ctrl-1..9 (switch to Nth panel).
 *   - Panel-specific: only dispatched while that panel is active.
 *
 * A panel that tries to register a universal key is rejected so a view can never
 * shadow exit/help/switch (AC-18). The routing decision is pure data so it can
 * be unit-tested without blessed; shell.ts maps the decision onto screen.key().
 */

/** Keys the shell reserves; panels may not bind these. */
export const UNIVERSAL_KEYS: readonly string[] = [
	"q",
	"C-c",
	"?",
	"escape",
	"C-1",
	"C-2",
	"C-3",
	"C-4",
	"C-5",
	"C-6",
	"C-7",
	"C-8",
	"C-9",
];

export type UniversalAction =
	| { kind: "exit" }
	| { kind: "help" }
	| { kind: "closeModal" }
	| { kind: "switchNth"; n: number }
	| { kind: "none" };

const UNIVERSAL_SET = new Set(UNIVERSAL_KEYS);

/** True if `key` is shell-owned and therefore not delegable to a panel. */
export function isUniversalKey(key: string): boolean {
	return UNIVERSAL_SET.has(key);
}

/**
 * Validate a panel's requested keys. Returns the offending keys (those that
 * collide with universal binds). Empty array ⇒ the panel's binds are legal.
 */
export function rejectedPanelKeys(keys: string[]): string[] {
	return keys.filter((k) => isUniversalKey(k));
}

/** Map a raw key name to the universal action it triggers (or none). */
export function universalAction(key: string): UniversalAction {
	switch (key) {
		case "q":
		case "C-c":
			return { kind: "exit" };
		case "?":
			return { kind: "help" };
		case "escape":
			return { kind: "closeModal" };
		default: {
			const m = /^C-([1-9])$/.exec(key);
			if (m) return { kind: "switchNth", n: Number(m[1]) };
			return { kind: "none" };
		}
	}
}

/** The Ctrl-N label for the Nth (1-based) panel, used in splash + help. */
export function ctrlNLabel(index1Based: number): string {
	return `Ctrl-${index1Based}`;
}
