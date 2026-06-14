/**
 * P1065 — TUI Presence Board panel (plugs into the P1067 Operator Shell).
 *
 * Implements the `TuiPanel` contract from ../types.ts. This file is the ONLY
 * blessed-touching module of P1065: it maps a `PanelContext` onto the pure
 * helpers in:
 *   - presence-board-model.ts    (sort / colour / state-machine / formatting)
 *   - presence-board-queries.ts  (the live SQL against the REAL schema)
 *   - presence-board-render.ts   (string → blessed-tag content)
 *
 * AC-12: never opens its own pg connection — all reads go through ctx.query;
 * all LISTENs go through ctx.listen (channel 'agency_heartbeat'). The board
 * auto-refreshes every 10s (AC-2/16) and on the heartbeat NOTIFY, repainting
 * only the body/footer boxes (diff-patch via screen.render(), shared screen
 * never destroyed — P1067 AC-1).
 *
 * P1067 INTERFACE DEPENDENCIES (from ../types.ts):
 *   TuiPanel, PanelContext, PanelNode, PanelKeybind, PanelSubscription,
 *   ThemeColors, ShellQuery, ShellHandle  (+ ctx.screen/listen/query/theme).
 */

import { box } from "../../ui/blessed.ts";
import type { BoxInterface } from "../../ui/blessed.ts";
import type {
	PanelContext,
	PanelKeybind,
	PanelNode,
	PanelSubscription,
	TuiPanel,
} from "../types.ts";
import {
	type AgencyRow,
	type BoardMode,
	fallbackBanner,
	type MessageRow,
	reduceBoard,
	splitMessages,
	type TrustRow,
} from "./presence-board-model.ts";
import {
	fetchFleet,
	fetchMessages,
	fetchTrust,
	probeStatusForFn,
} from "./presence-board-queries.ts";
import {
	type RenderTheme,
	renderFleet,
	renderHeader,
	renderMessaging,
	renderTrust,
	statusBarText,
} from "./presence-board-render.ts";

/** Heartbeat NOTIFY channel (live trigger fn_agency_heartbeat_notify). */
const HEARTBEAT_CHANNEL = "agency_heartbeat";
const REFRESH_MS = 10_000;

export class PresenceBoardPanel implements TuiPanel {
	readonly route = "presence-board";
	readonly title = "Fleet Presence";

	private bodyBox: BoxInterface | null = null;
	private sorted: AgencyRow[] = [];
	private mode: BoardMode = "board";
	private cursor = 0;
	private lastRefresh = "--:--:--";
	private statusForDeployed = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private ctx: PanelContext | null = null;

	// inspector caches for the selected agency
	private messaging: ReturnType<typeof splitMessages> | null = null;
	private trustOut: TrustRow[] = [];
	private trustIn: TrustRow[] = [];

	private readonly onHeartbeat = (_payload: string | undefined): void => {
		// Cheap: NOTIFY just means "something changed" → re-pull the fleet.
		void this.refresh();
	};

	keybinds(): PanelKeybind[] {
		return [
			{ keys: ["up"], description: "move up", handler: () => this.key("up") },
			{
				keys: ["down"],
				description: "move down",
				handler: () => this.key("down"),
			},
			{
				keys: ["enter"],
				description: "inspect",
				handler: () => this.key("enter"),
			},
			{ keys: ["tab"], description: "switch tab", handler: () => this.key("tab") },
			{ keys: ["escape"], description: "back", handler: () => this.key("esc") },
			{ keys: ["r"], description: "refresh", handler: () => void this.refresh() },
			{ keys: ["p"], description: "poke", handler: () => this.poke() },
		];
	}

	subscriptions(): PanelSubscription[] {
		return [{ channel: HEARTBEAT_CHANNEL, handler: this.onHeartbeat }];
	}

	onMount(ctx: PanelContext): void {
		this.ctx = ctx;
		if (!this.bodyBox) {
			this.bodyBox = box({
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				scrollable: true,
				alwaysScroll: true,
				keys: false,
				tags: true,
				content: "",
			}) as unknown as BoxInterface;
		}
	}

	render(ctx: PanelContext): PanelNode {
		this.ctx = ctx;
		if (!this.bodyBox) this.onMount(ctx);
		this.paint();
		return this.bodyBox as unknown as PanelNode;
	}

	onActivate(ctx: PanelContext): void {
		this.ctx = ctx;
		// initial load + probe + timer
		void (async () => {
			this.statusForDeployed = await probeStatusForFn(ctx.query).catch(
				() => false,
			);
			await this.refresh();
		})();
		this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
	}

	onDeactivate(_ctx: PanelContext): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	isDirty(): boolean {
		return false; // read-only inspector; no unsaved state
	}

	// --- internals -----------------------------------------------------------

	private theme(): RenderTheme {
		const t = this.ctx?.theme;
		return {
			fg: t?.fg ?? "white",
			muted: t?.muted ?? "gray",
			accent: t?.accent ?? "cyan",
			success: t?.success ?? "green",
			warning: t?.warning ?? "yellow",
			danger: t?.danger ?? "red",
			selectionBg: t?.selectionBg ?? "blue",
			selectionFg: t?.selectionFg ?? "white",
		};
	}

	private async refresh(): Promise<void> {
		if (!this.ctx) return;
		const rows = await fetchFleet(this.ctx.query).catch(() => [] as AgencyRow[]);
		this.sorted = rows;
		this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 1));
		this.lastRefresh = new Date().toLocaleTimeString("en-GB", {
			hour12: false,
		});
		this.paint();
	}

	private key(k: "up" | "down" | "enter" | "tab" | "esc"): void {
		const next = reduceBoard(
			{ mode: this.mode, cursor: this.cursor, rowCount: this.sorted.length },
			k,
		);
		const enteringInspector =
			this.mode === "board" && next.mode === "inspector-messaging";
		this.mode = next.mode;
		this.cursor = next.cursor;
		if (enteringInspector) void this.loadInspector();
		else this.paint();
	}

	private async loadInspector(): Promise<void> {
		const agency = this.selectedAgencyId();
		if (!agency || !this.ctx) return;
		const [msgs, trust] = await Promise.all([
			fetchMessages(this.ctx.query, agency).catch(() => [] as MessageRow[]),
			fetchTrust(this.ctx.query, agency).catch(() => ({
				outgoing: [] as TrustRow[],
				incoming: [] as TrustRow[],
			})),
		]);
		this.messaging = splitMessages(msgs);
		this.trustOut = trust.outgoing;
		this.trustIn = trust.incoming;
		this.paint();
	}

	private poke(): void {
		// Cold-wake poke is delegated to the shell/A2A layer in the full system;
		// the panel is read-only (AC-12 forbids its own connection). We surface
		// intent in the status bar without performing a write here.
		this.lastRefresh = `${this.lastRefresh} (poke→${this.selectedAgencyId() ?? "—"})`;
		this.paint();
	}

	private selectedAgencyId(): string | null {
		return this.sorted[this.cursor]?.agency_id ?? null;
	}

	private paint(): void {
		if (!this.bodyBox) return;
		const theme = this.theme();
		let content: string;
		if (this.mode === "board") {
			const banner = fallbackBanner(this.statusForDeployed);
			const { lines, sorted } = renderFleet(this.sorted, this.cursor, theme);
			this.sorted = sorted; // keep cursor index aligned with rendered order
			const head: string[] = [];
			if (banner) head.push(`{${theme.warning}-fg}${banner}{/}`);
			head.push(renderHeader());
			content = [...head, ...lines].join("\n");
		} else if (this.mode === "inspector-messaging") {
			content = this.messaging
				? renderMessaging(
						this.selectedAgencyId() ?? "—",
						this.messaging,
						theme,
					)
				: "loading…";
		} else {
			content = renderTrust(
				this.selectedAgencyId() ?? "—",
				this.trustOut,
				this.trustIn,
				theme,
			);
		}
		const footer = statusBarText(
			this.mode,
			this.selectedAgencyId(),
			this.lastRefresh,
		);
		this.bodyBox.setContent(`${content}\n\n${footer}`);
		this.ctx?.screen?.render();
	}
}

// Default export so the shell's loadPanels() can `import('…/presence-board.ts')`
// and pick up the panel without naming the class.
const panel = new PresenceBoardPanel();
export default panel;
