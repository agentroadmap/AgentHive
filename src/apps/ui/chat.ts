/**
 * Chat View
 *
 * A full-screen real-time chat interface.
 */

// @ts-expect-error - blessed types may not be installed
import type blessed from "blessed";
import { box, log, textbox } from "./blessed.ts";

export interface ChatMessage {
	id: string;
	sender_identity: string;
	content: string;
	timestamp: number;
	channel_name: string;
}

export function renderChat(
	screen: blessed.Widgets.Screen,
	data: {
		messages: ChatMessage[];
		channels: string[];
		currentChannel: string;
		projectName: string;
		userSystemName: string;
		onSend?: (content: string) => Promise<void> | void;
	},
): void {
	const {
		messages,
		channels,
		currentChannel,
		projectName,
		userSystemName,
		onSend,
	} = data;

	let container = (screen as any)._chatContainer;
	let chatLog: any, sidebar: any, inputField: any;

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
		(screen as any)._chatContainer = container;

		// Left Sidebar (Channels)
		sidebar = box({
			parent: container,
			top: 0,
			left: 0,
			width: 25,
			height: "100%-1",
			border: { type: "line" },
			label: " Channels ",
			tags: true,
			style: { border: { fg: "cyan" } },
		});
		container._sidebar = sidebar;

		// Main Chat Area (LOG for auto-scroll)
		chatLog = log({
			parent: container,
			top: 0,
			left: 25,
			width: "100%-25",
			height: "100%-4",
			border: { type: "line" },
			label: ` ${currentChannel} - ${projectName} `,
			tags: true,
			style: { border: { fg: "green" } },
			padding: { left: 1, right: 1 },
			scrollback: 500,
			scrollbar: { ch: " ", track: { bg: "green" }, style: { inverse: true } },
		});
		container._chatLog = chatLog;

		// Message Input
		const inputContainer = box({
			parent: container,
			bottom: 1,
			left: 25,
			width: "100%-25",
			height: 3,
			border: { type: "line" },
			style: { border: { fg: "yellow" } },
		});

		inputField = textbox({
			parent: inputContainer,
			top: 0,
			left: 1,
			width: "100%-3",
			height: 1,
			inputOnFocus: true,
			keys: true,
			mouse: true,
		});
		container._inputField = inputField;

		// Footer
		box({
			parent: container,
			bottom: 0,
			left: 0,
			width: "100%",
			height: 1,
			content: " {white-fg}Tab: Next View | Q: Exit | Enter: Send Message{/}",
			tags: true,
			style: { bg: "blue", fg: "white" },
		});

		// Event: Send Message
		inputField.on("submit", (value: string) => {
			if (value?.trim()) {
				void Promise.resolve(onSend?.(value.trim())).then(() => {
					inputField.clearValue();
					screen.render();
				});
			}
			inputField.focus();
			screen.render();
		});

		// Initial populate
		messages
			.slice()
			.reverse()
			.filter((m) => m.channel_name === currentChannel)
			.forEach((m) => {
				chatLog.add(formatChatMessage(m, userSystemName));
			});
		container._lastMsgTimestamp =
			messages.length > 0 ? messages[0].timestamp : 0;
		container._currentChannel = currentChannel;
	} else {
		sidebar = container._sidebar;
		chatLog = container._chatLog;
		inputField = container._inputField;
	}

	// Update Sidebar
	const channelLines = channels.map((c) => {
		return c === currentChannel ? `{yellow-fg}● ${c}{/}` : `  ${c}`;
	});
	sidebar.setContent(channelLines.join("\n"));

	// Reactive Update
	const newMessages = messages
		.filter(
			(m) =>
				m.timestamp > container._lastMsgTimestamp &&
				m.channel_name === currentChannel,
		)
		.reverse();
	if (newMessages.length > 0) {
		newMessages.forEach((m) => {
			chatLog.add(formatChatMessage(m, userSystemName));
		});
		container._lastMsgTimestamp = messages[0].timestamp;
	}

	inputField.focus();
	screen.render();
}

function formatChatMessage(m: ChatMessage, userSystemName: string): string {
	const time = new Date(Number(m.timestamp) / 1000).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	const isMe = m.sender_identity === userSystemName;
	const senderColor = isMe ? "yellow-fg" : "cyan-fg";
	return `[{gray-fg}${time}{/}] {${senderColor}}{bold}${m.sender_identity}{/}: ${m.content}`;
}
