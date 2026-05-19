/**
 * Headlines View
 *
 * A full-screen real-time feed of system-wide status changes and pulse updates.
 */

// @ts-expect-error - blessed types may not be installed
import type blessed from "blessed";
import { box, log } from "./blessed.ts";

export interface PulseMessage {
	id: string;
	sender_identity: string;
	content: string;
	timestamp: number;
	channel_name: string;
}

export function renderHeadlines(
	screen: blessed.Widgets.Screen,
	data: {
		messages: PulseMessage[];
		projectName: string;
	},
): void {
	const { messages, projectName } = data;

	let container = (screen as any)._headlinesContainer;
	let feedLog: any;

	if (!container) {
		screen.children.forEach((child: any) => {
			child.destroy();
		});

		container = box({
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
			tags: true,
			style: { bg: "black" },
		});
		(screen as any)._headlinesContainer = container;

		// Header
		box({
			parent: container,
			top: 0,
			left: 0,
			width: "100%",
			height: 3,
			content: `{bold}{yellow-fg} 📡 LIVE PULSE: ${projectName.toUpperCase()}{/} | {cyan-fg}SYSTEM FEED ACTIVE{/}`,
			border: { type: "line" },
			style: { border: { fg: "yellow" } },
			tags: true,
		});

		// Main Feed Area (LOG for auto-scroll)
		feedLog = log({
			parent: container,
			top: 3,
			left: 0,
			width: "100%",
			height: "100%-4",
			border: { type: "line" },
			label: " [ SYSTEM HEADLINES ] ",
			tags: true,
			style: { border: { fg: "cyan" } },
			padding: { left: 2, right: 2, top: 1, bottom: 1 },
			scrollback: 200,
			scrollbar: { ch: " ", track: { bg: "cyan" }, style: { inverse: true } },
		});
		container._feedLog = feedLog;

		// Footer
		box({
			parent: container,
			bottom: 0,
			left: 0,
			width: "100%",
			height: 1,
			content: " {white-fg}Tab: Next View | Q: Exit | Auto-scrolling Active{/}",
			tags: true,
			style: { bg: "cyan", fg: "black" },
		});

		// Initial populate
		messages
			.slice()
			.reverse()
			.forEach((m) => {
				feedLog.add(formatPulseMessage(m));
			});
		container._lastMsgTimestamp =
			messages.length > 0 ? messages[0].timestamp : 0;
	} else {
		feedLog = container._feedLog;
	}

	// Reactive Update
	const newMessages = messages
		.filter((m) => m.timestamp > container._lastMsgTimestamp)
		.reverse();
	if (newMessages.length > 0) {
		newMessages.forEach((m) => {
			feedLog.add(formatPulseMessage(m));
		});
		container._lastMsgTimestamp = messages[0].timestamp;
	}

	screen.render();
}

function formatPulseMessage(m: PulseMessage): string {
	const time = new Date(Number(m.timestamp) / 1000).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

	let content = m.content;
	if (
		content.includes("[proposal reached]") ||
		content.includes("[Complete]")
	) {
		content = `{green-fg}${content}{/}`;
	} else if (content.includes("[active]") || content.includes("[Active]")) {
		content = `{yellow-fg}${content}{/}`;
	} else if (content.includes("[ERROR]") || content.includes("failed")) {
		content = `{red-fg}${content}{/}`;
	} else if (content.includes("[Review]")) {
		content = `{magenta-fg}${content}{/}`;
	}

	return `[{gray-fg}${time}{/}] {bold}${m.sender_identity.substring(0, 12).padEnd(12)}{/} ❯ ${content}`;
}
