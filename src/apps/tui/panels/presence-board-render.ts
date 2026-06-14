/**
 * P1065 — Presence Board: PURE content renderers (string → string).
 *
 * These produce the blessed-tag markup the panel feeds to box.setContent().
 * They take a ThemeColors-shaped object so colours come from ctx.theme (P1067
 * AC-21: no raw fg:/bg: literals). Keeping them pure lets us assert the exact
 * rendered table/inspector text in unit tests without a TTY.
 */

import {
	type AgencyRow,
	formatSilence,
	groupTrust,
	isColdWake,
	type MessageRow,
	type MessagingView,
	modeTag,
	presenceColorKey,
	presenceLabel,
	sortAgencyRows,
	type ThemeKey,
	trustExpiry,
	type TrustRow,
	unackedOfferLabel,
} from "./presence-board-model.ts";

/** Minimal theme shape we need (subset of P1067 ThemeColors). */
export interface RenderTheme {
	fg: string;
	muted: string;
	accent: string;
	success: string;
	warning: string;
	danger: string;
	selectionBg: string;
	selectionFg: string;
}

function tag(theme: RenderTheme, key: ThemeKey, text: string): string {
	const color = theme[key] ?? theme.fg;
	return `{${color}-fg}${text}{/}`;
}

function pad(s: string, width: number): string {
	const v = s.length > width ? `${s.slice(0, width - 1)}…` : s;
	return v.padEnd(width);
}

const COLS = {
	name: 24,
	presence: 11,
	status: 9,
	silence: 10,
	dispatch: 5,
	task: 10,
} as const;

export function renderHeader(): string {
	return [
		pad("AGENCY", COLS.name),
		pad("PRESENCE", COLS.presence),
		pad("STATUS", COLS.status),
		pad("SILENCE", COLS.silence),
		pad("DISP", COLS.dispatch),
		pad("TASK", COLS.task),
	].join(" ");
}

/**
 * Render the fleet table body (AC-1/8/9/10/15/17/24). Rows are sorted here so
 * the rendered order is authoritative. `selected` is an index into the SORTED
 * array; that row gets a selection highlight. Cold-wake rows get a '::' overlay
 * on the presence cell (AC-10/24).
 */
export function renderFleet(
	rows: AgencyRow[],
	selected: number,
	theme: RenderTheme,
): { lines: string[]; sorted: AgencyRow[] } {
	const sorted = sortAgencyRows(rows);
	const lines = sorted.map((r, i) => {
		const colorKey = presenceColorKey(r);
		const cold = isColdWake(r);
		const presenceText = `${presenceLabel(r)}${cold ? " ::" : ""}`;
		const cells = [
			pad(r.display_name, COLS.name),
			tag(theme, colorKey, pad(presenceText, COLS.presence)),
			pad(r.status, COLS.status),
			pad(formatSilence(r.silence_seconds), COLS.silence),
			pad(r.dispatchable ? "yes" : "no", COLS.dispatch),
			pad(r.active_task ?? "—", COLS.task),
		].join(" ");
		if (i === selected) {
			return `{${theme.selectionBg}-bg}{${theme.selectionFg}-fg}${stripTags(cells)}{/}`;
		}
		return cells;
	});
	return { lines, sorted };
}

/** Drop blessed tags so a selected row's bg highlight is uniform. */
function stripTags(s: string): string {
	return s.replace(/\{[^}]*\}/g, "");
}

/** Inspector — Messaging tab (AC-4/11/19/22). */
export function renderMessaging(
	agencyId: string,
	view: MessagingView,
	theme: RenderTheme,
	now: number = Date.now(),
): string {
	const out: string[] = [];
	out.push(tag(theme, "accent", `Messaging — ${agencyId}`));
	out.push("");
	if (view.unackedOffers.length) {
		out.push(tag(theme, "danger", "⚠ UNACKNOWLEDGED OFFERS"));
		for (const m of view.unackedOffers) {
			out.push(tag(theme, "danger", `  ${unackedOfferLabel(m, now)}`));
		}
		out.push("");
	}
	out.push(tag(theme, "accent", `Inbox (${view.inbox.length})`));
	out.push(...view.inbox.slice(0, 20).map((m) => msgLine(m, theme)));
	out.push("");
	out.push(tag(theme, "accent", `Outbox (${view.outbox.length})`));
	out.push(...view.outbox.slice(0, 20).map((m) => msgLine(m, theme)));
	return out.join("\n");
}

function msgLine(m: MessageRow, theme: RenderTheme): string {
	const ack = m.acked_at ? "✓" : tag(theme, "warning", "·");
	return `  ${ack} ${pad(m.kind, 18)} ${m.created_at}`;
}

/** Inspector — Trust tab (AC-5/12/20). */
export function renderTrust(
	agencyId: string,
	outgoing: TrustRow[],
	incoming: TrustRow[],
	theme: RenderTheme,
	now: number = Date.now(),
): string {
	const out: string[] = [];
	out.push(tag(theme, "accent", `Trust — ${agencyId}`));
	out.push("");
	out.push(tag(theme, "accent", "Outgoing (this agency trusts):"));
	out.push(...renderTrustSection(outgoing, theme, now, "trusted_agent"));
	out.push("");
	out.push(tag(theme, "accent", "Incoming (agencies trusting this one):"));
	out.push(...renderTrustSection(incoming, theme, now, "agent_identity"));
	return out.join("\n");
}

function renderTrustSection(
	rows: TrustRow[],
	theme: RenderTheme,
	now: number,
	peerCol: "trusted_agent" | "agent_identity",
): string[] {
	const { activeByTier, expired } = groupTrust(rows, now);
	const lines: string[] = [];
	for (const [tier, tierRows] of activeByTier) {
		lines.push(`  [${tier}]`);
		for (const r of tierRows) {
			const exp = trustExpiry(r, now);
			const peer = r[peerCol];
			const expStr = r.expires_at ? ` (expires ${r.expires_at})` : "";
			const text = `    ${pad(peer, 26)}${expStr}`;
			lines.push(exp === "expiring" ? tag(theme, "warning", text) : text);
		}
	}
	if (expired.length) {
		lines.push(tag(theme, "muted", "  [expired]"));
		for (const r of expired) {
			lines.push(tag(theme, "muted", `    ${pad(r[peerCol], 26)}`));
		}
	}
	if (!activeByTier.size && !expired.length) lines.push("  (none)");
	return lines;
}

/** Three-segment status bar text fragment owned by the panel (AC-2/6/21). */
export function statusBarText(
	mode: "board" | "inspector-messaging" | "inspector-trust",
	selectedAgency: string | null,
	lastRefresh: string,
): string {
	const hints =
		mode === "board"
			? "↑/↓ move  Enter inspect  R refresh  P poke"
			: "Tab switch  PgUp/PgDn scroll  Esc back";
	return `${modeTag(mode)} | ${selectedAgency ?? "—"} | Last refresh: ${lastRefresh} | ${hints}`;
}
