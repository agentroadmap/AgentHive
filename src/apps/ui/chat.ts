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
				focus: { border: { fg: "yellow" } },
				selected: { bg: "blue", fg: "white", bold: true },
				item: { fg: "white" },
			},
		});
		container._sidebar = sidebar;
		container._sidebarFocused = false;

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
			container._inputFocused = true;
			container._sidebarFocused = false;
			inputField.focus();
			// Ensure _reading flag is set so next refresh doesn't auto-call startReading.
			if (!(inputField as any)._reading) {
				if (container._startReading) container._startReading();
			}
			container._updateFooter?.();
			screen.render();
		});

		// Esc on the sidebar returns to the input box.
		(sidebar as any).key(["escape"], () => {
			container._inputDefocused = false;
			container._inputFocused = true;
			container._sidebarFocused = false;
			inputField.focus();
			if (!(inputField as any)._reading) {
				if (container._startReading) container._startReading();
			}
			container._updateFooter?.();
			screen.render();
		});

		// Track sidebar focus
		(sidebar as any).on("focus", () => {
			container._sidebarFocused = true;
			container._inputFocused = false;
			container._inputContainer.style.border = { fg: "dim_yellow" };
			sidebar.style.border = { fg: "yellow" };
			container._updateFooter?.();
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
			style: { border: { fg: "dim_yellow" } },
		});
		container._inputContainer = inputContainer;
		container._inputFocused = true;

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

		// Footer — Mode indicator + help
		const footer = box({
			parent: container,
			bottom: 0,
			left: 0,
			width: "100%",
			height: 1,
			tags: true,
			style: { bg: "blue", fg: "white" },
		});
		container._footer = footer;
		const updateFooter = () => {
			const mode = container._inputFocused ? "INPUT" : "CHANNELS";
			const hint = container._inputFocused
				? " Enter: Send | Esc: Channels | Ctrl+C: Quit"
				: " Arrows: Navigate | Enter: Select | Esc: Input | Tab: View | Q: Exit";
			footer.setContent(`Mode: {yellow-fg}${mode}{/} |${hint}`);
		};
		container._updateFooter = updateFooter;
		updateFooter();

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

		// `i` and `c` shortcuts bound at SCREEN level (not chatLog) — blessed.log
		// doesn't reliably forward letter keys via .key(). screen.key fires when
		// the user is OUT of the input box (inputField captures keys while
		// readInput is active, so these only fire after Esc defocuses input).
		(screen as any).key(["i"], () => {
			// Re-enter input mode (vim-style). Only acts when input isn't
			// currently focused; if it is, the keypress went into the message.
			if ((screen as any).focused === inputField) return;
			container._inputDefocused = false;
			container._inputFocused = true;
			container._sidebarFocused = false;
			inputField.focus();
			inputContainer.style.border = { fg: "yellow" };
			sidebar.style.border = { fg: "cyan" };
			startReading();
			container._updateFooter?.();
			screen.render();
		});
		(screen as any).key(["c"], () => {
			// Jump focus to the Channels sidebar.
			if ((screen as any).focused === inputField) return;
			container._inputDefocused = true;
			container._inputFocused = false;
			container._sidebarFocused = true;
			sidebar.focus();
			inputContainer.style.border = { fg: "dim_yellow" };
			sidebar.style.border = { fg: "yellow" };
			container._updateFooter?.();
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

	// Update Sidebar — only call setItems when channels actually changed.
	// Without this guard the list redraws every 1s refresh, which the
	// user perceives as flashing (the entire panel repaints).
	container._currentChannel = currentChannel;
	const channelsKey = channels.join("\x00");
	if (channelsKey !== container._channelsKey) {
		container._channels = channels;
		container._channelsKey = channelsKey;
		(sidebar as any).setItems(channels);
	}

	// Only update title + clear log + pre-select the active row when the
	// channel ACTUALLY changes. Doing it on every tick (a) flashes the
	// border and (b) fought against the user's mid-navigation arrow keys
	// (refresh called sidebar.select(activeIndex) which reverted the
	// user's Down keypress).
	if (container._displayedChannel !== currentChannel) {
		(chatLog as any).setLabel?.(` ${currentChannel} - ${projectName} `);
		const activeIndex = Math.max(0, channels.indexOf(currentChannel));
		(sidebar as any).select?.(activeIndex);
		if (container._displayedChannel) {
			// Wipe the log so the prior channel's messages don't mix in.
			if ((chatLog as any).setItems) (chatLog as any).setItems([]);
			else (chatLog as any).setContent?.("");
			container._lastMsgTimestamp = 0;
		}
		container._displayedChannel = currentChannel;
	}

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
	// ALSO: only call focus() when input isn't already focused — re-focusing
	// an already-focused widget can fire 'focus' events and contribute to
	// visible flicker on the input frame.
	if (!container._inputDefocused) {
		const screenAny = screen as any;
		if (screenAny.focused !== inputField) {
			inputField.focus();
		}
		if (!(inputField as any)._reading && container._startReading) {
			container._startReading();
		}
	}
	// Update border colors and footer text to reflect actual focus state.
	// Input focus = yellow border + bright mode indicator.
	if (container._inputFocused) {
		(inputContainer as any).style.border = { fg: "yellow" };
		(sidebar as any).style.border = { fg: "cyan" };
	} else if (container._sidebarFocused) {
		(inputContainer as any).style.border = { fg: "dim_yellow" };
		(sidebar as any).style.border = { fg: "yellow" };
	}
	container._updateFooter?.();
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
