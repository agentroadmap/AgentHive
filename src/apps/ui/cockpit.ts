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
	status: "active" | "zombie" | "offline";
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
	},
): void {
	const { agents, proposals, ledger, messages } = data;
	const pipelineTotal = data.pipelineTotal ?? proposals.length;
	const pipelineCountsExplicit = data.pipelineCounts;

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

		// 1. Workforce [Top Left]
		workforceBox = box({
			parent: container,
			top: 3,
			left: 0,
			width: "50%",
			height: "50%-3",
			border: { type: "line" },
			label: " [F1] Workforce — agencies by provider@host ",
			tags: true,
			scrollable: true,
			style: { border: { fg: "green" } },
		});
		container._workforceBox = workforceBox;

		// 2. Pipeline [Top Right]
		// tags:true was producing a render artifact where Develop's count
		// "120" became " 12" and subsequent lines shifted one cell right.
		// We don't need tag-styled lines in this panel — drop tag parsing.
		pipelineBox = box({
			parent: container,
			top: 3,
			left: "50%",
			width: "50%",
			height: "50%-3",
			border: { type: "line" },
			label: " [F4] Pipeline Traffic ",
			tags: false,
			scrollable: true,
			style: { border: { fg: "magenta" } },
		});
		container._pipelineBox = pipelineBox;

		// 3. Ledger [Bottom Left]
		ledgerBox = box({
			parent: container,
			top: "50%",
			left: 0,
			width: "50%",
			height: "50%-1",
			border: { type: "line" },
			label: " [F2] The Ledger (Spending) ",
			tags: true,
			scrollable: true,
			style: { border: { fg: "yellow" } },
		});
		container._ledgerBox = ledgerBox;

		// 4. Terminal [Bottom Right] - USE LOG FOR AUTO-SCROLL
		terminalLog = (screen as any).log({
			parent: container,
			top: "50%",
			left: "50%",
			width: "50%",
			height: "50%-1",
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

	// Update Dynamic Content
	headerBox.setContent(
		`{bold}{cyan-fg}🚀 ENGINEER'S COCKPIT{/} | Agents: ${agents.length} | Pipeline: ${pipelineTotal} | Status: {green-fg}LIVE{/}`,
	);

	// Update Workforce — split into WORKING (has currentProposal) vs AVAILABLE.
	// WORKING rows are loud and show what they're on; AVAILABLE is compact
	// (comma-separated by type) so you can see the bench at a glance.
	if (agents.length === 0) {
		workforceBox.setContent("  {gray-fg}No agents registered{/}");
	} else {
		const working = agents.filter((a) => a.status === "active" && a.currentProposal);
		const idle = agents.filter((a) => a.status === "active" && !a.currentProposal);
		const offline = agents.filter((a) => a.status !== "active");

		const cols = ((screen as any).program?.cols as number | undefined) ?? 160;
		const panelBudget = Math.max(40, Math.floor(cols / 2) - 6);

		const lines: string[] = [];
		lines.push(
			`{bold}${working.length} working{/} · {bold}${idle.length} available{/}${offline.length ? ` · {gray-fg}${offline.length} offline{/}` : ""}`,
		);
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
