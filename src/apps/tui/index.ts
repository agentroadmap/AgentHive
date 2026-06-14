/**
 * P1067 AC-11/13/23 — TUI Operator Shell binary entrypoint.
 *
 * `npm run tui` launches the shell with every registered view. CLI args:
 *   --view <route>   jump directly to that view
 *   --theme <name>   override theme (dark|light)
 *   --debug          log notification dispatch + view-switch to stderr
 *
 * Exit codes: 0 on Q/Ctrl-C (clean), non-zero on startup failure (AC-11/23) —
 * including code 1 when no operator context is present (AC-17).
 *
 * Panel registration is the seam P1065/P1066 plug into: import their panel and
 * call shell.register(panel). They are registered lazily/defensively so the
 * shell still boots (with whatever views exist) before those proposals land.
 */

import { query as pgQuery } from "../../infra/postgres/pool.ts";
import { parseTuiArgs, TuiArgError } from "./cli-args.ts";
import { ListenMultiplexer } from "./listen-multiplexer.ts";
import { resolveOperatorPrincipal } from "./operator-context.ts";
import { PgListenDriver } from "./pg-listen-driver.ts";
import { OperatorShell } from "./shell.ts";
import type { ShellQuery, TuiPanel } from "./types.ts";

/** Discover panels from sibling proposals without a hard build dependency. */
async function loadPanels(): Promise<TuiPanel[]> {
	const panels: TuiPanel[] = [];
	const candidates = [
		"./panels/presence-board.ts", // P1065
		"./panels/config-editor.ts", // P1066
	];
	for (const mod of candidates) {
		try {
			const m = (await import(mod)) as { default?: TuiPanel; panel?: TuiPanel };
			const p = m.default ?? m.panel;
			if (p && typeof p.render === "function") panels.push(p);
		} catch {
			/* panel not built yet — shell still boots with the rest */
		}
	}
	if (panels.length === 0) {
		// Foundation fallback: ship the reference board/headlines panels (AC-2) so
		// `npm run tui` renders something before P1065/P1066 land.
		const { examplePanels } = await import("./panels/example-panels.ts");
		panels.push(...examplePanels);
	}
	return panels;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	let args: ReturnType<typeof parseTuiArgs>;
	try {
		args = parseTuiArgs(argv);
	} catch (e) {
		const msg = e instanceof TuiArgError ? e.message : String(e);
		process.stderr.write(`tui: ${msg}\n`);
		return 2;
	}

	// AC-17: resolve operator principal exactly once; exit 1 if absent.
	const principal = resolveOperatorPrincipal();
	if (!principal) {
		process.stderr.write(
			"tui: no operator context (set AGENTHIVE_OPERATOR_IDENTITY or run within an authed flow)\n",
		);
		return 1;
	}

	const shellQuery: ShellQuery = (text, params) =>
		pgQuery(text, params as unknown[]).then((r) => ({
			rows: r.rows,
		})) as ReturnType<ShellQuery>;

	const driver = new PgListenDriver({ debug: args.debug });
	const mux = new ListenMultiplexer(driver);
	driver.attach(mux);
	try {
		await driver.connect();
	} catch (e) {
		process.stderr.write(`tui: LISTEN connect failed: ${String(e)}\n`);
		return 1;
	}

	let exitCode = 0;
	let resolveExit: (() => void) | null = null;
	const shell = new OperatorShell({
		principal,
		query: shellQuery,
		listenDriver: driver,
		mux,
		themeName: args.theme,
		debug: args.debug,
		onExit: (code) => {
			exitCode = code;
			void driver.close();
			resolveExit?.();
		},
	});

	for (const panel of await loadPanels()) {
		try {
			shell.register(panel);
		} catch (e) {
			process.stderr.write(`tui: skip panel: ${String(e)}\n`);
		}
	}

	if (shell.registry.count() === 0) {
		process.stderr.write(
			"tui: no views registered (P1065/P1066 not built yet) — nothing to display\n",
		);
		await driver.close();
		return 1;
	}

	try {
		await shell.start(args.view);
	} catch (e) {
		process.stderr.write(`tui: startup failed: ${String(e)}\n`);
		await driver.close();
		return 1;
	}

	// The blessed event loop keeps the process alive until shell.exit() fires
	// onExit, which resolves this promise.
	await new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	return exitCode;
}

// Direct-execution guard (node --import jiti/register src/apps/tui/index.ts).
if (
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith("/tui/index.ts")
) {
	main()
		.then((code) => process.exit(code))
		.catch((e) => {
			process.stderr.write(`tui: fatal: ${String(e)}\n`);
			process.exit(1);
		});
}
