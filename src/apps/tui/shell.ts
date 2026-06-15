/**
 * P1067 — TUI Operator Shell runtime (blessed wiring).
 *
 * Hosts pluggable panels (P1065 board, P1066 config editor, …) in a SINGLE
 * shared blessed screen (AC-1: screen.destroy called 0x except at exit), with:
 *   - one ListenMultiplexer / one pg LISTEN client for the whole shell (AC-3/16)
 *   - shell-owned universal keybinds (Ctrl-1..9 switch, Q/Ctrl-C exit, ? help,
 *     Esc close) that panels cannot shadow (AC-6/18)
 *   - a three-segment status bar updated on every switch (AC-7/19)
 *   - the principal resolved ONCE at startup, handed to every panel (AC-17)
 *
 * All decision logic (registry/switch, keybind routing, listen dedup, status,
 * help, splash, args, list/detail) lives in the sibling pure modules and is
 * unit-tested headlessly; this file only maps those decisions onto blessed.
 */

import type { VerifiedPrincipal } from "../../shared/identity/agent-context.ts";
import type { BoxInterface, ScreenInterface } from "../ui/blessed.ts";
import { box } from "../ui/blessed.ts";
import { createScreen } from "../ui/tui.ts";
import { buildHelpBody, type HelpPanelEntry } from "./help-overlay.ts";
import { rejectedPanelKeys, universalAction } from "./keybinds.ts";
import { type ListenDriver, ListenMultiplexer } from "./listen-multiplexer.ts";
import { PanelRegistry } from "./registry.ts";
import { buildSplashBody, SPLASH_MS, type SplashModel } from "./splash.ts";
import { buildStatusBar } from "./status-bar.ts";
import { resolveTheme } from "./theme.ts";
import type {
	PanelContext,
	PanelNode,
	ShellQuery,
	ThemeColors,
	TuiPanel,
} from "./types.ts";

export interface ShellOptions {
	principal: VerifiedPrincipal;
	query: ShellQuery;
	listenDriver: ListenDriver;
	/** Optional pre-built multiplexer (so the driver and shell share one). */
	mux?: ListenMultiplexer;
	themeName?: string;
	debug?: boolean;
	/** Injectable for tests; defaults to the real blessed screen factory. */
	screen?: ScreenInterface;
	/** Skip the timed splash (tests). */
	skipSplash?: boolean;
	/**
	 * Factory for shell-owned chrome boxes (body/footer/splash/help/confirm).
	 * Defaults to blessed `box`. Tests inject a fake so the shell never touches a
	 * real TTY (a real blessed screen parks the event loop + writes escapes).
	 */
	makeNode?: (opts: Record<string, unknown>) => BoxInterface;
	onExit?: (code: number) => void;
}

export class OperatorShell {
	readonly registry = new PanelRegistry();
	readonly mux: ListenMultiplexer;
	private readonly theme: ThemeColors;
	private readonly principal: VerifiedPrincipal;
	private readonly query: ShellQuery;
	private readonly debug: boolean;
	private readonly onExit: (code: number) => void;
	private screen: ScreenInterface | null = null;
	private readonly externalScreen?: ScreenInterface;
	private body: BoxInterface | null = null;
	private footer: BoxInterface | null = null;
	private helpBox: BoxInterface | null = null;
	private activeNode: PanelNode | null = null;
	private mounted = new Set<string>();
	private exited = false;
	private skipSplash: boolean;
	private readonly makeNode: (opts: Record<string, unknown>) => BoxInterface;

	constructor(opts: ShellOptions) {
		this.principal = opts.principal;
		this.query = opts.query;
		this.theme = resolveTheme(opts.themeName);
		this.debug = opts.debug ?? false;
		this.onExit = opts.onExit ?? ((code) => process.exit(code));
		this.externalScreen = opts.screen;
		this.skipSplash = opts.skipSplash ?? false;
		this.makeNode = opts.makeNode ?? ((o) => box(o as never) as BoxInterface);
		this.mux = opts.mux ?? new ListenMultiplexer(opts.listenDriver);
	}

	/** Register a panel before start(). Rejects universal-key collisions (AC-18). */
	register(panel: TuiPanel): void {
		for (const kb of panel.keybinds?.() ?? []) {
			const bad = rejectedPanelKeys(kb.keys);
			if (bad.length) {
				throw new Error(
					`panel ${panel.route} cannot bind universal keys: ${bad.join(", ")}`,
				);
			}
		}
		this.registry.register(panel);
	}

	private ctxFor(): PanelContext {
		const screen = this.screen;
		if (!screen) throw new Error("shell not started");
		return {
			screen,
			principal: this.principal,
			listen: {
				subscribe: (c, h) => this.mux.subscribe(c, h),
				unsubscribe: (c, h) => this.mux.unsubscribe(c, h),
			},
			query: this.query,
			shell: {
				switchPanel: (r) => this.switchTo(r),
				render: () => this.screen?.render(),
				exit: (code = 0) => this.exit(code),
				routes: () => this.registry.routes(),
			},
			theme: this.theme,
		};
	}

	/** Build the shared screen + chrome, show splash, mount the first/target view. */
	async start(initialRoute?: string): Promise<void> {
		this.screen =
			this.externalScreen ??
			createScreen({ title: "AgentHive Operator Shell" });
		this.body = this.makeNode({
			parent: this.screen,
			top: 0,
			left: 0,
			width: "100%",
			height: "100%-1",
			style: { fg: this.theme.fg, bg: this.theme.bg },
		});
		this.footer = this.makeNode({
			parent: this.screen,
			bottom: 0,
			left: 0,
			width: "100%",
			height: 1,
			style: { fg: this.theme.fg, bg: this.theme.accent },
		});
		this.installUniversalKeys();

		if (!this.skipSplash) await this.showSplash();

		const target =
			initialRoute && this.registry.indexOf(initialRoute) >= 0
				? initialRoute
				: this.registry.at(0)?.route;
		if (target) this.switchTo(target);
		this.screen.render();
	}

	private async showSplash(): Promise<void> {
		const model: SplashModel = {
			identity: this.principal.principal_id,
			authStatus: `${this.principal.principal_kind} verified`,
			views: this.registry
				.routes()
				.map((r) => this.registry.get(r))
				.filter((p): p is TuiPanel => !!p)
				.map((p) => ({ title: p.title, route: p.route })),
		};
		const splash = this.makeNode({
			parent: this.screen!,
			top: "center",
			left: "center",
			width: "shrink",
			height: "shrink",
			border: "line",
			padding: 1,
			content: buildSplashBody(model),
			style: {
				fg: this.theme.fg,
				bg: this.theme.bg,
				border: { fg: this.theme.border },
			},
		});
		this.screen!.render();
		await new Promise((res) => setTimeout(res, SPLASH_MS));
		splash.destroy(); // NB: destroys a child box, NOT the screen (AC-1).
		this.screen!.render();
	}

	/** AC-6/15/18: route a universal key to its shell action. */
	private installUniversalKeys(): void {
		const screen = this.screen!;
		const keys = ["q", "C-c", "?", "escape"];
		for (let n = 1; n <= 9; n++) keys.push(`C-${n}`);
		for (const key of keys) {
			screen.key([key], () => {
				const action = universalAction(key);
				switch (action.kind) {
					case "exit":
						this.requestExit();
						break;
					case "help":
						this.toggleHelp();
						break;
					case "closeModal":
						this.closeHelp();
						break;
					case "switchNth": {
						const plan = this.registry.switchToNth(action.n);
						if (!plan.noop && plan.activate)
							this.applySwitch(plan.deactivate, plan.activate);
						break;
					}
				}
			});
		}
	}

	/** Public switch entry (AC-4 ctx.shell.switchPanel). */
	switchTo(route: string): void {
		const plan = this.registry.switchTo(route);
		if (plan.activate && (!plan.noop || this.activeNode === null)) {
			this.applySwitch(plan.deactivate, plan.activate);
		}
	}

	private applySwitch(deactivate: string | null, activate: string): void {
		const ctx = this.ctxFor();
		if (deactivate) {
			const prev = this.registry.get(deactivate);
			prev?.onDeactivate?.(ctx);
			for (const sub of prev?.subscriptions?.() ?? []) {
				this.mux.unsubscribe(sub.channel, sub.handler);
			}
		}
		const panel = this.registry.get(activate);
		if (!panel) return;
		if (!this.mounted.has(panel.route)) {
			panel.onMount?.(ctx);
			this.mounted.add(panel.route);
		}
		if (this.activeNode) this.activeNode.detach?.();
		const node = panel.render(ctx);
		this.body?.append(node);
		this.activeNode = node;
		for (const sub of panel.subscriptions?.() ?? []) {
			this.mux.subscribe(sub.channel, sub.handler);
		}
		this.bindPanelKeys(panel);
		panel.onActivate?.(ctx);
		this.renderStatus(panel);
		if (this.debug) process.stderr.write(`[tui] switch → ${panel.route}\n`);
		this.screen?.render();
	}

	private boundPanelKeys: Array<{ keys: string[]; fn: () => void }> = [];
	private bindPanelKeys(panel: TuiPanel): void {
		const screen = this.screen!;
		for (const b of this.boundPanelKeys) screen.unkey(b.keys, b.fn);
		this.boundPanelKeys = [];
		for (const kb of panel.keybinds?.() ?? []) {
			const fn = () => kb.handler();
			screen.key(kb.keys, fn);
			this.boundPanelKeys.push({ keys: kb.keys, fn });
		}
	}

	private renderStatus(panel: TuiPanel): void {
		this.footer?.setContent(
			buildStatusBar({
				panelName: panel.title,
				identity: this.principal.principal_id,
				keybinds: panel.keybinds?.() ?? [],
			}),
		);
	}

	private toggleHelp(): void {
		if (this.helpBox) {
			this.closeHelp();
			return;
		}
		const entries: HelpPanelEntry[] = this.registry.routes().map((r, i) => {
			const p = this.registry.get(r)!;
			return {
				title: p.title,
				route: r,
				index: i + 1,
				keybinds: p.keybinds?.() ?? [],
			};
		});
		this.helpBox = this.makeNode({
			parent: this.screen!,
			top: "center",
			left: "center",
			width: "80%",
			height: "80%",
			border: "line",
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			label: " Help (Esc/Q closes) ",
			content: buildHelpBody(entries),
			style: {
				fg: this.theme.fg,
				bg: this.theme.bg,
				border: { fg: this.theme.border },
			},
		});
		this.helpBox.focus();
		this.screen?.render();
	}

	private closeHelp(): void {
		if (!this.helpBox) return;
		this.helpBox.destroy();
		this.helpBox = null;
		this.screen?.render();
	}

	/** AC-18: confirm before exit if the active view is dirty. */
	private requestExit(): void {
		const active = this.registry.activePanel();
		if (active?.isDirty?.()) {
			const confirm = this.makeNode({
				parent: this.screen!,
				top: "center",
				left: "center",
				width: "shrink",
				height: "shrink",
				border: "line",
				padding: 1,
				content: "Unsaved changes. Press y to quit, any other key to stay.",
				style: {
					fg: this.theme.fg,
					bg: this.theme.danger,
					border: { fg: this.theme.border },
				},
			});
			this.screen?.render();
			this.screen!.once("keypress", (_ch: string, key: { name?: string }) => {
				confirm.destroy();
				if (key?.name === "y") this.exit(0);
				else this.screen?.render();
			});
			return;
		}
		this.exit(0);
	}

	exit(code: number): void {
		if (this.exited) return;
		this.exited = true;
		this.screen?.destroy(); // AC-1: the ONLY screen.destroy, at exit.
		this.onExit(code);
	}
}
