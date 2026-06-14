/**
 * P1067 AC-11 / AC-23 — CLI argument parsing (pure).
 *
 *   --view <route>   jump directly to that view at startup
 *   --theme <name>   override the theme (dark|light)
 *   --debug          log notification dispatch + view-switch events to stderr
 *
 * Pure parser over an argv array so the contract is unit-testable; bin/tui.ts
 * feeds it process.argv.slice(2).
 */

export interface TuiArgs {
	view?: string;
	theme?: string;
	debug: boolean;
	/** Unknown/extra tokens, surfaced so the binary can warn or fail. */
	unknown: string[];
}

export class TuiArgError extends Error {}

/** Parse argv (already sliced past node+script). Throws on a missing value. */
export function parseTuiArgs(argv: string[]): TuiArgs {
	const out: TuiArgs = { debug: false, unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		switch (tok) {
			case "--view":
			case "--theme": {
				const val = argv[++i];
				if (val === undefined || val.startsWith("--")) {
					throw new TuiArgError(`${tok} requires a value`);
				}
				if (tok === "--view") out.view = val;
				else out.theme = val;
				break;
			}
			case "--debug":
				out.debug = true;
				break;
			default:
				out.unknown.push(tok);
		}
	}
	return out;
}
