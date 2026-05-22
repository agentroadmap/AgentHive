/**
 * Cockpit Dashboard View
 *
 * The "Engineer's Cockpit" for real-time monitoring and control of the agent workforce.
 */

// @ts-expect-error - blessed types may not be installed
import type blessed from "blessed";
import { box } from "./blessed.ts";

export interface WorkforceAgent {
	id: string;
	name: string;
	role: string;
	// 'active'   = registered and ready (presence online OR unknown)
	// 'throttled' = rate-limited / token bucket exhausted; throttledUntil set
	// 'offline'  = presence-state offline or away (not dispatchable)
	// 'zombie'   = legacy state — unused with new schema
	status: "active" | "zombie" | "offline" | "throttled";
	presenceOnline?: boolean; // true when liaison heartbeat is live
	throttledUntil?: number;  // ms epoch — when throttle clears
	currentProposal?: string;
	statusMessage: string;
	lastSeen?: number;
}

export interface PipelineProposal {
	id: string;
	display_id: string;
	title: string;
	status: string;
	priority: string;
	proposal_type: string;
}

export interface LedgerEntry {
	agent: string;
	dailyLimit: number;
	spentToday: number;
	totalSpent: number;
	isFrozen: boolean;
}

export interface TerminalMessage {
	sender_identity: string;
	content: string;
	timestamp: number;
}

export function renderCockpit(
	screen: blessed.Widgets.Screen,
	data: {
		agents: WorkforceAgent[];
		// proposals is the *recent activity* list (typically 5 items by
		// modified_at DESC), not the full pipeline. Pipeline totals come from
		// pipelineTotal + pipelineCounts so we don't have to hydrate every row.
		proposals: PipelineProposal[];
		pipelineTotal?: number;
		pipelineCounts?: Record<string, number>;
		ledger: LedgerEntry[];
		messages: TerminalMessage[];
		// Layout resolved by the caller (FlagKeys.TUI_COCKPIT_LAYOUT). Defaults
		// to 'grid' when not provided so the function stays safe for any caller
		// that hasn't been updated yet.
		layout?: "grid" | "stacked";
	},
): void {
	const { agents, proposals, ledger, messages } = data;
	const pipelineTotal = data.pipelineTotal ?? proposals.length;
	const pipelineCountsExplicit = data.pipelineCounts;
	const layout: "grid" | "stacked" = data.layout ?? "grid";

	// Check if we already have a persistent cockpit container
	let container = (screen as any)._cockpitContainer;
	let workforceBox: any,
		pipelineBox: any,
		ledgerBox: any,
		terminalLog: any,
		headerBox: any;

	if (!container) {
		// Clear screen for initial render
		screen.children.forEach((child: any) => {
			child.destroy();
		});

		// Create persistent container.
		// parent: screen required — without it the container is orphaned and
		// the entire view renders invisible (the 2026-05-19 black-screen bug).
		container = box({
			parent: screen,
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
			tags: true,
		});
		(screen as any)._cockpitContainer = container;

		// Header
		headerBox = box({
			parent: container,
			top: 0,
			left: 0,
			width: "100%",
			height: 3,
			tags: true,
			border: { type: "line", bottom: true },
			style: { border: { fg: "cyan" } },
		});
		container._headerBox = headerBox;

		// Layout: "grid" (default, 2x2) or "stacked" (1 column, full width).
		// Resolved upstream from FlagKeys.TUI_COCKPIT_LAYOUT (env override:
		// AGENTHIVE_COCKPIT_LAYOUT). Stacked gives each panel full width and
		// ~24% of remaining height — useful on narrower terminals or when you
		// want longer Recent Activity / Terminal bridge feeds.
		const panelLayout = layout;

		// Position helpers: panels go below the header (top:3) and above the
		// footer (bottom:1). Stacked = 4 equal-height bands; Grid = 2x2.
		const panelGeometry = (slot: 0 | 1 | 2 | 3) => {
			if (panelLayout === "stacked") {
				// Each panel is 25% of (screen - header - footer).
				// height: 25%-1 keeps a 1-row gap and avoids fractional overlap.
				return {
					top: `25%+${slot * 0}`,
					height: "25%-1",
					left: 0,
					width: "100%",
					// override top per slot:
					topOverride:
						slot === 0 ? 3
						: slot === 1 ? "25%"
						: slot === 2 ? "50%"
						: "75%",
				};
			}
			// grid
			const isTop = slot < 2;
			const isLeft = slot % 2 === 0;
			return {
				top: isTop ? 3 : "50%",
				height: isTop ? "50%-3" : "50%-1",
				left: isLeft ? 0 : "50%",
				width: "50%",
				topOverride: null as any,
			};
		};

		const geom0 = panelGeometry(0);
		const geom1 = panelGeometry(1);
		const geom2 = panelGeometry(2);
		const geom3 = panelGeometry(3);

		// 1. Workforce
		workforceBox = box({
			parent: container,
			top: geom0.topOverride ?? geom0.top,
			left: geom0.left,
			width: geom0.width,
			height: geom0.height,
			border: { type: "line" },
			label: " [F1] Workforce — agents grouped by agency (provider@host) ",
			tags: true,
			scrollable: true,
			style: { border: { fg: "green" } },
		});
		container._workforceBox = workforceBox;

		// 2. Pipeline
		// tags:false avoids a render artifact where colored numeric counts
		// shifted one cell right ("Develop : 120" → " 12" at the boundary
		// between two panels in grid mode).
		pipelineBox = box({
			parent: container,
			top: geom1.topOverride ?? geom1.top,
			left: geom1.left,
			width: geom1.width,
			height: geom1.height,
			border: { type: "line" },
			label: " [F4] Pipeline Traffic ",
			tags: false,
			scrollable: true,
			style: { border: { fg: "magenta" } },
		});
		container._pipelineBox = pipelineBox;

		// 3. Ledger
		ledgerBox = box({
			parent: container,
			top: geom2.topOverride ?? geom2.top,
			left: geom2.left,
			width: geom2.width,
			height: geom2.height,
			border: { type: "line" },
			label: " [F2] The Ledger (Spending) ",
			tags: true,
			scrollable: true,
			style: { border: { fg: "yellow" } },
		});
		container._ledgerBox = ledgerBox;

		// 4. Terminal — log widget for auto-scroll
		terminalLog = (screen as any).log({
			parent: container,
			top: geom3.topOverride ?? geom3.top,
			left: geom3.left,
			width: geom3.width,
			height: geom3.height,
			border: { type: "line" },
			label: " [F3] Terminal bridge ",
			tags: true,
			style: { border: { fg: "cyan" } },
			scrollback: 100,
			scrollbar: { ch: " ", track: { bg: "cyan" }, style: { inverse: true } },
		});
		container._terminalLog = terminalLog;

		// Footer
		box({
			parent: container,
			bottom: 0,
			left: 0,
			width: "100%",
			height: 1,
			tags: true,
			style: { bg: "black" },
			content:
				" {white-fg}Tab: Switch View | Q: Exit | Live Updates Active {/}",
		});

		// Initial terminal populate
		messages
			.slice()
			.reverse()
			.forEach((m) => {
				const time = new Date(Number(m.timestamp)).toLocaleTimeString(
					[],
					{ hour: "2-digit", minute: "2-digit" },
				);
				terminalLog.add(
					`[{gray-fg}${time}{/}] {bold}${m.sender_identity}{/}: ${m.content}`,
				);
			});
		container._lastMsgTimestamp =
			messages.length > 0 ? messages[0].timestamp : 0;
	} else {
		headerBox = container._headerBox;
		workforceBox = container._workforceBox;
		pipelineBox = container._pipelineBox;
		ledgerBox = container._ledgerBox;
		terminalLog = container._terminalLog;
	}

	// Update Dynamic Content. Header bar mirrors the panel counts —
	// agencies = distinct provider@host groups, agents = total workers.
	const headerAgencies = new Set(agents.map((a) => a.role || "unknown@?")).size;
	headerBox.setContent(
		`{bold}{cyan-fg}🚀 ENGINEER'S COCKPIT{/} | Agencies: ${headerAgencies} | Agents: ${agents.length} | Pipeline: ${pipelineTotal} | Status: {green-fg}LIVE{/}`,
	);

	// Update Workforce — split into WORKING (has currentProposal) vs AVAILABLE
	// vs THROTTLED vs OFFLINE. The header gives an at-a-glance picture of the
	// whole bench: how many are registered, how many liaisons are responsive,
	// how many are dispatchable right now, how many can't take work.
	if (agents.length === 0) {
		workforceBox.setContent("  {gray-fg}No agents registered{/}");
	} else {
		const totalAgents = agents.length;
		// Count distinct provider@host groups — those are the agencies in the
		// operator's mental model (claude@bot, codex@bot, …). The individual
		// named entries (alice, ana, …) are workers under each agency.
		const agencyCount = new Set(agents.map((a) => a.role || "unknown@?")).size;
		const online = agents.filter((a) => a.presenceOnline).length;
		const working = agents.filter((a) => a.status === "active" && a.currentProposal);
		const idle = agents.filter((a) => a.status === "active" && !a.currentProposal);
		const throttled = agents.filter((a) => a.status === "throttled");
		const offline = agents.filter((a) => a.status === "offline");

		const cols = ((screen as any).program?.cols as number | undefined) ?? 160;
		// Layout is the resolved layout from the caller (FlagKeys.TUI_COCKPIT_LAYOUT).
		const panelBudget = layout === "stacked"
			? Math.max(60, cols - 6)
			: Math.max(40, Math.floor(cols / 2) - 6);

		const lines: string[] = [];
		// Header: agencies + agents counts, liaison responsiveness, dispatch
		// states. Operator request (2026-05-22): "agencies #, registered,
		// online (liaison responsive, token available or to reset time)".
		const parts = [
			`{bold}${agencyCount}{/} agencies`,
			`{bold}${totalAgents}{/} agents`,
			`{green-fg}${online}{/} online`,
			`{bold}${working.length}{/} working`,
			`{cyan-fg}${idle.length}{/} ready`,
		];
		if (throttled.length > 0) {
			// Show shortest reset window so operator knows when to expect capacity.
			const resets = throttled
				.map((a) => a.throttledUntil)
				.filter((t): t is number => typeof t === "number" && t > Date.now())
				.sort((a, b) => a - b);
			const nextReset = resets[0];
			const resetIn = nextReset
				? ` (next reset ${formatRelativeTime(nextReset - Date.now())})`
				: "";
			parts.push(`{yellow-fg}${throttled.length} throttled${resetIn}{/}`);
		}
		if (offline.length > 0) {
			parts.push(`{gray-fg}${offline.length} offline{/}`);
		}
		lines.push(parts.join(" · "));
		lines.push("");

		if (working.length > 0) {
			lines.push("{green-fg}[*] WORKING{/}");
			working.forEach((a) => {
				const role = `{gray-fg}(${a.role}){/}`;
				const task = a.currentProposal ?? "";
				const taskFit = task.length > panelBudget - a.id.length - 10
					? `${task.substring(0, panelBudget - a.id.length - 11)}…`
					: task;
				lines.push(`  {bold}${a.id}{/} ${role} -> {yellow-fg}${taskFit}{/}`);
			});
			lines.push("");
		}

		if (idle.length > 0) {
			lines.push(`{cyan-fg}[ ] AVAILABLE{/}`);
			// Group by provider@host — the user's mental model. claude@bot,
			// codex@bot, gemini@bot, etc. Each shown as a single line with
			// agency names comma-separated.
			const byProvider = new Map<string, string[]>();
			idle.forEach((a) => {
				const key = a.role || "unknown@?";
				if (!byProvider.has(key)) byProvider.set(key, []);
				byProvider.get(key)!.push(a.id);
			});
			// Sort providers alphabetically for stability.
			const orderedProviders = Array.from(byProvider.keys()).sort();
			orderedProviders.forEach((provider) => {
				const names = byProvider.get(provider) ?? [];
				const joined = names.join(", ");
				const labelLen = provider.length + String(names.length).length + 5;
				const fit = joined.length > panelBudget - labelLen
					? `${joined.substring(0, panelBudget - labelLen - 1)}…`
					: joined;
				lines.push(`  {gray-fg}${provider}{/} (${names.length}): ${fit}`);
			});
		}

		if (throttled.length > 0) {
			lines.push("");
			lines.push("{yellow-fg}[!] THROTTLED{/}");
			throttled.forEach((a) => {
				const resetIn = a.throttledUntil
					? formatRelativeTime(a.throttledUntil - Date.now())
					: "unknown";
				lines.push(`  {bold}${a.id}{/} {gray-fg}(${a.role}){/} -> reset ${resetIn}`);
			});
		}

		if (offline.length > 0) {
			lines.push("");
			lines.push(`{gray-fg}(.) offline: ${offline.map((a) => a.id).join(", ")}{/}`);
		}

		workforceBox.setContent(lines.join("\n"));
	}

	// Pipeline counts come from an explicit pipelineCounts map when the caller
	// provides one (cheap SQL aggregation). Fallback: derive from the
	// proposals array, normalizing to UPPERCASE since proposal.status can be
	// either Title Case ('Draft') or UPPERCASE ('DRAFT') per the canonical
	// check constraint.
	const statusCounts: Record<string, number> = {};
	if (pipelineCountsExplicit) {
		for (const [k, v] of Object.entries(pipelineCountsExplicit)) {
			statusCounts[k.toUpperCase()] = v;
		}
	} else {
		proposals.forEach((p) => {
			const key = (p.status ?? "").toUpperCase();
			statusCounts[key] = (statusCounts[key] || 0) + 1;
		});
	}
	const pipelineLines: string[] = [];
	const statuses = ["Draft", "Review", "Develop", "Merge", "Complete"];
	// Each line padded to a fixed 30-char trailing width — without this,
	// blessed.setContent leaves residual digits from the previous render
	// in the pipeline box (e.g. count 0 → 120 shows as "0120").
	statuses.forEach((s) => {
		const count = statusCounts[s.toUpperCase()] || 0;
		const raw = `${s.padEnd(10)} : ${count}`;
		pipelineLines.push(raw.padEnd(30));
	});
	// proposals is the recent-activity list when the caller pre-sorted by
	// modified_at DESC; otherwise we degrade to "last 5 from the tail".
	pipelineLines.push("\nRecent Activity:");
	const recent = data.pipelineCounts ? proposals : proposals.slice(-5).reverse();
	// Pipeline panel is ~half the screen width. Estimate the usable width
	// from the terminal columns; minus the "• PXXXX: " prefix and borders,
	// leaves roughly half - 14. Fall back to a generous 70 if cols unknown.
	const cols = ((screen as any).program?.cols as number | undefined) ?? 160;
	const titleBudget = Math.max(20, Math.floor(cols / 2) - 14);
	recent.forEach((p) => {
		const title = p.title ?? "";
		const trimmed = title.length > titleBudget
			? `${title.substring(0, titleBudget - 1)}…`
			: title;
		pipelineLines.push(`• ${p.display_id}: ${trimmed}`);
	});
	// blessed's setContent on this scrollable+tags=true box leaves stale
	// digits from the previous render — see the "Develop : 0120" bug.
	// Wiping to "" first, then setting on next tick, forces a clean redraw.
	pipelineBox.setContent("");
	pipelineBox.setContent(pipelineLines.join("\n"));

	// Update Ledger
	if (ledger.length === 0) {
		ledgerBox.setContent(
			"  {gray-fg}No spending data in last 7 days.{/}\n" +
			"  {gray-fg}Budget writers not yet wired (tracked as P1018).{/}",
		);
	} else {
		const ledgerLines = ledger.map((l) => {
			const status = l.isFrozen ? "{red-fg}FROZEN{/}" : "{green-fg}ACTIVE{/}";
			const percent = ((l.spentToday / l.dailyLimit) * 100).toFixed(0);
			return `{bold}${l.agent.padEnd(10)}{/} | ${status} | $${l.spentToday.toFixed(2)} / $${l.dailyLimit.toFixed(0)} (${percent}%)`;
		});
		ledgerBox.setContent(ledgerLines.join("\n"));
	}

	// Reactive Terminal Update (only add new messages)
	const newMessages = messages
		.filter((m) => m.timestamp > container._lastMsgTimestamp)
		.reverse();
	if (newMessages.length > 0) {
		newMessages.forEach((m) => {
			const time = new Date(Number(m.timestamp)).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			});
			terminalLog.add(
				`[{gray-fg}${time}{/}] {bold}${m.sender_identity}{/}: ${m.content}`,
			);
		});
		container._lastMsgTimestamp = messages[0].timestamp;
	}

	screen.render();
}

function formatRelativeTime(ms: number): string {
	if (ms < 0) return "now";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `in ${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `in ${hours}h`;
}
