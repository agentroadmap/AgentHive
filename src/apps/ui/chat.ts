/**
 * Chat View
 *
 * A full-screen real-time chat interface.
 */

// @ts-expect-error - blessed types may not be installed
import type blessed from "blessed";
import { box, list, log, textbox } from "./blessed.ts";

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
		onExit?: () => void;
		// Fired when the user selects a channel from the sidebar list. Caller
		// is responsible for updating its currentChannel state and triggering
		// a fresh data fetch.
		onChannelSelect?: (channel: string) => void;
	},
): void {
	const {
		messages,
		channels,
		currentChannel,
		projectName,
		userSystemName,
		onSend,
		onExit,
		onChannelSelect,
	} = data;

	let container = (screen as any)._chatContainer;
	let chatLog: any, sidebar: any, inputField: any;

	if (!container) {
		screen.children.forEach((child: any) => {
			child.destroy();
		});

		// parent: screen required — without it the container is orphaned and invisible.
		container = box({
			parent: screen,
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
			tags: true,
			style: { bg: "black" },
		});
		(screen as any)._chatContainer = container;

		// Left Sidebar (Channels) — interactive list. Focus with `c` from the
		// chat log; navigate up/down; Enter to select; Esc returns focus to
		// the chat input.
		sidebar = list({
			parent: container,
			top: 0,
			left: 0,
			width: 25,
			height: "100%-1",
			border: { type: "line" },
			label: " Channels ",
			tags: true,
			keys: true,
			mouse: true,
			vi: true,
			items: [],
			style: {
				border: { fg: "cyan" },
				selected: { bg: "blue", fg: "white", bold: true },
				item: { fg: "white" },
			},
		});
		container._sidebar = sidebar;

		// Channel selection: blessed.list emits 'select' on Enter.
		(sidebar as any).on("select", (_item: any, index: number) => {
			const sel = (container._channels as string[] | undefined)?.[index];
			if (sel && sel !== container._currentChannel) {
				container._currentChannel = sel;
				// Reset the message-cursor so the new channel's history fills
				// the log on the next refresh tick.
				container._lastMsgTimestamp = 0;
				if (chatLog && (chatLog as any).setItems) {
					(chatLog as any).setItems([]);
				}
				onChannelSelect?.(sel);
			}
			// Bounce focus back to the input so the operator can type immediately.
			container._inputDefocused = false;
			inputField.focus();
			if (container._startReading) container._startReading();
			screen.render();
		});

		// Esc on the sidebar returns to the input box.
		(sidebar as any).key(["escape"], () => {
			container._inputDefocused = false;
			inputField.focus();
			if (container._startReading) container._startReading();
			screen.render();
		});

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

		// inputOnFocus is deliberately OFF. With it on, the focus-triggered
		// readInput() races with our defocus path: blur fires __done, which
		// re-enters _done after this._done was already deleted, leaving the
		// keypress listener attached. The next Escape then calls a stale
		// `done` reference (which is undefined) → TypeError at blessed.js:12786.
		// We drive readInput manually with a single callback that owns the
		// full lifecycle.
		inputField = textbox({
			parent: inputContainer,
			top: 0,
			left: 1,
			width: "100%-3",
			height: 1,
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
			content: " {white-fg}Enter: Send | Esc: leave input | Ctrl+C: Quit | (outside input) c: Channels | i: input | Tab: View | Q: Exit{/}",
			tags: true,
			style: { bg: "blue", fg: "white" },
		});

		const startReading = () => {
			inputField.readInput((err: any, value: string | null | undefined) => {
				if (err === "stop") return;
				if (err) return;
				if (value != null) {
					// submit
					const trimmed = value.trim();
					if (trimmed) {
						void Promise.resolve(onSend?.(trimmed)).then(() => {
							inputField.clearValue();
							if (!container._inputDefocused) startReading();
							screen.render();
						});
					} else {
						inputField.clearValue();
						if (!container._inputDefocused) startReading();
						screen.render();
					}
				} else {
					// cancel (Escape) — leave input, free Tab/Q at screen level
					container._inputDefocused = true;
					chatLog.focus();
					screen.render();
				}
			});
		};
		container._startReading = startReading;

		// Ctrl+C exits even from inside the input box (screen-level handler is
		// shadowed by textbox readInput, so we re-bind at program level here).
		inputField.key(["C-c"], () => {
			onExit?.();
		});

		// Allow re-entering input mode from the log with `i` (vim-style).
		(chatLog as any).key(["i"], () => {
			container._inputDefocused = false;
			inputField.focus();
			startReading();
			screen.render();
		});

		// `c` jumps focus to the Channels sidebar so the operator can pick
		// a different channel. Once focused, up/down navigate, Enter selects,
		// Esc returns to input.
		(chatLog as any).key(["c"], () => {
			container._inputDefocused = true;
			sidebar.focus();
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

	// Update Sidebar — set list items (no leading marker; the list's own
	// selected-style highlights the active row). Pre-select the row matching
	// currentChannel so up/down navigation starts in the right place.
	container._channels = channels;
	container._currentChannel = currentChannel;
	(sidebar as any).setItems(channels);
	const activeIndex = Math.max(0, channels.indexOf(currentChannel));
	(sidebar as any).select?.(activeIndex);

	// Update the chat log title bar to reflect the current channel.
	(chatLog as any).setLabel?.(` ${currentChannel} - ${projectName} `);

	// If the channel changed since the last render, wipe the log so we don't
	// keep showing the previous channel's messages mixed with the new ones.
	if (container._displayedChannel && container._displayedChannel !== currentChannel) {
		if ((chatLog as any).setItems) (chatLog as any).setItems([]);
		else (chatLog as any).setContent?.("");
		container._lastMsgTimestamp = 0;
	}
	container._displayedChannel = currentChannel;

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

	// Only focus + start reading if user hasn't explicitly defocused with Esc.
	// Without this guard, the 1s refresh loop would steal focus back every
	// tick, trapping the user inside the textbox.
	if (!container._inputDefocused) {
		inputField.focus();
		// Only kick off readInput once per focus session — blessed's _reading
		// guard makes additional calls no-ops, but we want it to actually run
		// at least once after initial render.
		if (!(inputField as any)._reading && container._startReading) {
			container._startReading();
		}
	}
	screen.render();
}

function formatChatMessage(m: ChatMessage, userSystemName: string): string {
	const time = new Date(Number(m.timestamp)).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	const isMe = m.sender_identity === userSystemName;
	const senderColor = isMe ? "yellow-fg" : "cyan-fg";
	return `[{gray-fg}${time}{/}] {${senderColor}}{bold}${m.sender_identity}{/}: ${m.content}`;
}
