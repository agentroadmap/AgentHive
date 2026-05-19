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
		proposals: PipelineProposal[];
		ledger: LedgerEntry[];
		messages: TerminalMessage[];
	},
): void {
	const { agents, proposals, ledger, messages } = data;

	// Check if we already have a persistent cockpit container
	let container = (screen as any)._cockpitContainer;
	let workforceBox: any,
		pipelineBox: any,
		ledgerBox: any,
		terminalLog: any,
		headerBox: any;

	if (!container) {
		// P1139: hide siblings (don't destroy — kanban/headlines/chat each cache
		// their own container on the screen). Pre-refactor this destroyed every
		// child including other views' caches.
		screen.children.forEach((child: any) => {
			if (typeof child.hide === "function") child.hide();
		});

		// Create persistent container
		// (no `keys: true` on the container — pre-codex-03b5d580 the container did
		// not capture keys, and adding it caused focus contention that resulted
		// in cockpit rendering as a black screen. Per-box handlers below still
		// catch Tab/q/Esc.)
		container = box({
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
			label: " [F1] Workforce Pulse ",
			tags: true,
			scrollable: true,
			style: { border: { fg: "green" } },
		});
		container._workforceBox = workforceBox;

		// 2. Pipeline [Top Right]
		pipelineBox = box({
			parent: container,
			top: 3,
			left: "50%",
			width: "50%",
			height: "50%-3",
			border: { type: "line" },
			label: " [F4] Pipeline Traffic ",
			tags: true,
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
		// (screen as any).log may not exist on every blessed wrapper variant; fall
		// back to a regular box so the cockpit still renders. The .add() helper
		// is feature-detected before use further down.
		terminalLog = (screen as any).log
			? (screen as any).log({
					parent: container,
					top: "50%",
					left: "50%",
					width: "50%",
					height: "50%-1",
					border: { type: "line" },
					label: " [F3] Terminal bridge ",
					tags: true,
					keys: true,
					style: { border: { fg: "cyan" } },
					scrollback: 100,
					scrollbar: {
						ch: " ",
						track: { bg: "cyan" },
						style: { inverse: true },
					},
				})
			: box({
					parent: container,
					top: "50%",
					left: "50%",
					width: "50%",
					height: "50%-1",
					border: { type: "line" },
					label: " [F3] Terminal bridge ",
					tags: true,
					scrollable: true,
					alwaysScroll: true,
					keys: true,
					style: { border: { fg: "cyan" } },
				});
		container._terminalLog = terminalLog;

		const emitExit = () => {
			(screen as any).emit("cockpit:exit");
		};
		const emitSwitch = () => {
			(screen as any).emit("cockpit:switch");
		};
		// Tab-crash guard (2026-05-19): any of these boxes can be undefined if a
		// blessed wrapper returns undefined from a factory call. Skip undefined
		// targets so the optional-chained .key?.() lookup doesn't throw
		// "Cannot read properties of undefined (reading 'key')".
		for (const target of [
			container,
			workforceBox,
			pipelineBox,
			ledgerBox,
			terminalLog,
		]) {
			if (!target) continue;
			target.key?.(["q", "Q", "escape", "C-c"], emitExit);
			target.key?.(["tab"], emitSwitch);
		}

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

		// Initial terminal populate. If terminalLog fell back to a plain box
		// (screen.log unavailable), .add isn't defined; accumulate into content.
		if (terminalLog) {
			const lines: string[] = [];
			messages
				.slice()
				.reverse()
				.forEach((m) => {
					const time = new Date(
						Number(m.timestamp) / 1000,
					).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
					const line = `[{gray-fg}${time}{/}] {bold}${m.sender_identity}{/}: ${m.content}`;
					if (typeof terminalLog.add === "function") {
						terminalLog.add(line);
					} else {
						lines.push(line);
					}
				});
			if (lines.length > 0 && typeof terminalLog.setContent === "function") {
				terminalLog.setContent(lines.join("\n"));
			}
		}
		container._lastMsgTimestamp =
			messages.length > 0 ? messages[0].timestamp : 0;
	} else {
		headerBox = container._headerBox;
		workforceBox = container._workforceBox;
		pipelineBox = container._pipelineBox;
		ledgerBox = container._ledgerBox;
		terminalLog = container._terminalLog;
	}

	// P1139: ensure the container is visible (it may have been hidden on previous
	// view-switch) and focused so blessed has a render target.
	try {
		container.show?.();
		container.setFront?.();
		container.focus?.();
	} catch { /* ignore */ }

	// Update Dynamic Content
	headerBox.setContent(
		`{bold}{cyan-fg}🚀 ENGINEER'S COCKPIT{/} | Agents: ${agents.length} | Pipeline: ${proposals.length} | Status: {green-fg}LIVE{/}`,
	);

	// Update Workforce
	if (agents.length === 0) {
		workforceBox.setContent("  {gray-fg}No agents registered{/}");
	} else {
		const lines = agents.map((a) => {
			const icon =
				a.status === "active" ? "🟢" : a.status === "zombie" ? "🧟" : "⚪";
			const proposal = a.currentProposal
				? ` {yellow-fg}[${a.currentProposal}]{/}`
				: "";
			return `${icon} {bold}${a.id}{/bold} (${a.role})${proposal}\n   └─ ${a.statusMessage}`;
		});
		workforceBox.setContent(lines.join("\n"));
	}

	// Update Pipeline
	const statusCounts: Record<string, number> = {};
	proposals.forEach((p) => {
		statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
	});
	const pipelineLines: string[] = [];
	const statuses = ["Draft", "Review", "Develop", "Merge", "Complete"];
	statuses.forEach((s) => {
		const count = statusCounts[s] || 0;
		const color =
			s === "Develop" ? "yellow-fg" : s === "Complete" ? "green-fg" : "gray-fg";
		pipelineLines.push(`{${color}}${s.padEnd(10)}{/} : ${count}`);
	});
	pipelineLines.push("\n{bold}Recent Activity:{/}");
	proposals
		.slice(-5)
		.reverse()
		.forEach((p) => {
			pipelineLines.push(`• ${p.display_id}: ${p.title.substring(0, 30)}...`);
		});
	pipelineBox.setContent(pipelineLines.join("\n"));

	// Update Ledger
	if (ledger.length === 0) {
		ledgerBox.setContent("  {gray-fg}No spending data{/}");
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
			const time = new Date(Number(m.timestamp) / 1000).toLocaleTimeString([], {
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
