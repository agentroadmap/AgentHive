/**
 * Chat View
 *
 * A full-screen real-time chat interface.
 *
 * Architecture (Approach A: Decouple input from refresh):
 * - Input box lives once as a permanent widget with submit/cancel events.
 * - Refresh only updates chatLog content and sidebar channels list.
 * - No readInput() modal — normal textbox with focus/blur lifecycle.
 * - Single source of truth: screen.focused and widget state.
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
		onChannelSelect?: (channel: string) => void;
		// Tab pressed: caller cycles to the next view. Bound at the textbox
		// level (not just screen) because neo-neo-bblessed's readInput grab
		// swallows Tab before it reaches screen.key handlers.
		onSwitchView?: () => void;
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
		onSwitchView,
	} = data;

	let container = (screen as any)._chatContainer;
	let chatLog: any, sidebar: any, inputField: any;

	if (!container) {
		screen.children.forEach((child: any) => {
			child.destroy();
		});

		// Root container (parent: screen required)
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

		// Left Sidebar (Channels)
		sidebar = list({
			parent: container,
			top: 0,
			left: 0,
			width: 25,
			height: "100%-4",
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

		// Mouse click on a channel → focus + select it immediately.
		// blessed.list with mouse:true updates `.selected` on click but does
		// NOT emit "select" (that's keyboard Enter only). Bind at screen
		// level using mousedown + hit-test against the sidebar's absolute
		// position — this is the same pattern board.ts uses (line 1108) and
		// is more reliable than list-level "click" events in this blessed
		// fork.
		(screen as any).on("mousedown", (data: any) => {
			const sb = container._sidebar;
			if (!sb) return;
			const left = sb.aleft ?? 0;
			const right = left + (sb.width as number);
			const top = sb.atop ?? 0;
			const bottom = top + (sb.height as number);
			if (data.x < left || data.x >= right || data.y < top || data.y >= bottom) {
				return; // click outside sidebar
			}
			// Skip the border row at the top + the label row inside the border.
			const rowInList = data.y - top - 1; // -1 for the top border
			const channels = container._channels as string[] | undefined;
			if (!channels || rowInList < 0 || rowInList >= channels.length) return;
			sb.select(rowInList);
			sb.focus();
			sb.emit("select", channels[rowInList], rowInList);
		});

		// Channel selection (Enter key or mouse click)
		(sidebar as any).on("select", (_item: any, index: number) => {
			const sel = (container._channels as string[] | undefined)?.[index];
			if (sel && sel !== container._currentChannel) {
				container._currentChannel = sel;
				container._lastMsgTimestamp = 0;
				if (chatLog && (chatLog as any).setItems) {
					(chatLog as any).setItems([]);
				}
				onChannelSelect?.(sel);
			}
			// Return focus to input
			inputField.focus();
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		// Esc on sidebar returns to input
		(sidebar as any).key(["escape"], () => {
			inputField.focus();
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		// Track sidebar focus
		(sidebar as any).on("focus", () => {
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		(sidebar as any).on("blur", () => {
			updateBorders();
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

		// Click on chat log → just gives visual feedback (user can scroll)
		(chatLog as any).on("click", () => {
			chatLog.focus();
			updateBorders();
			screen.render();
		});

		// Message Input Container
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

		// Input field: textbox with keys enabled for normal text input
		inputField = textbox({
			parent: inputContainer,
			top: 0,
			left: 1,
			width: "100%-3",
			height: 1,
			keys: true,
			mouse: true,
			style: { focus: { fg: "white" } },
		});
		container._inputField = inputField;

		// Flag to prevent multiple readInput sessions
		let isReadingInput = false;

		// Start the readInput session once when input is focused
		const startReadingInput = () => {
			if (isReadingInput) return;
			isReadingInput = true;

			inputField.readInput((err: any, value: string | null | undefined) => {
				isReadingInput = false;

				if (err === "stop") {
					// Some blessed forks call this on Esc; neo-neo-bblessed does
					// not. We also handle Esc via a screen-level binding (see
					// below) so this path is a fallback.
					sidebar.focus();
					updateBorders();
					container._updateFooter?.();
					screen.render();
					return;
				}
				if (err) return; // Other error, just stop

				// Enter was pressed with a value
				if (value != null && typeof value === "string") {
					const trimmed = value.trim();
					if (trimmed) {
						void Promise.resolve(onSend?.(trimmed)).then(() => {
							inputField.clearValue?.();
							// After send completes, restart readInput if still focused
							if ((screen as any).focused === inputField) {
								// Need a microtask delay to avoid stack overflow
								setImmediate(() => startReadingInput());
							}
							screen.render();
						});
					} else {
						// Empty line, just clear and restart
						inputField.clearValue?.();
						if ((screen as any).focused === inputField) {
							setImmediate(() => startReadingInput());
						}
						screen.render();
					}
				}
			});
		};
		container._startReadingInput = startReadingInput;

		// Track input focus: start reading when focused
		(inputField as any).on("focus", () => {
			updateBorders();
			container._updateFooter?.();
			startReadingInput();
			screen.render();
		});

		(inputField as any).on("blur", () => {
			isReadingInput = false;
			updateBorders();
			screen.render();
		});

		// Click on input → focus it
		(inputField as any).on("click", () => {
			inputField.focus();
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		// Ctrl+C exits (readInput may intercept, so also bind at element level)
		(inputField as any).key(["C-c"], () => {
			onExit?.();
		});

		// Tab from input → next view. Same reason as Esc: readInput's grab
		// blocks screen.key('tab') so we bind it directly on the textbox.
		(inputField as any).key(["tab"], () => {
			onSwitchView?.();
		});

		// Escape from input → channels sidebar. neo-neo-bblessed swallows Esc
		// at the readInput layer (no screen.key bubble, no readInput callback
		// invocation), but it DOES emit a 'cancel' event on the textbox. Hook
		// that to redirect focus to the sidebar — the user can pick a channel
		// in three keystrokes (Esc, ↓, Enter) without a dead-end stop in
		// chatLog.
		(inputField as any).on("cancel", () => {
			isReadingInput = false;
			sidebar.focus();
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		// Helper: update border colors based on focus
		const updateBorders = () => {
			const screenAny = screen as any;
			const inputContainerRef = container._inputContainer;
			const sidebarRef = container._sidebar;
			const chatLogRef = container._chatLog;

			if (screenAny.focused === inputField) {
				inputContainerRef.style.border = { fg: "yellow" };
				sidebarRef.style.border = { fg: "cyan" };
				chatLogRef.style.border = { fg: "green" };
			} else if (screenAny.focused === sidebarRef) {
				inputContainerRef.style.border = { fg: "dim_yellow" };
				sidebarRef.style.border = { fg: "yellow" };
				chatLogRef.style.border = { fg: "green" };
			} else if (screenAny.focused === chatLogRef) {
				inputContainerRef.style.border = { fg: "dim_yellow" };
				sidebarRef.style.border = { fg: "cyan" };
				chatLogRef.style.border = { fg: "yellow" };
			}
		};
		container._updateBorders = updateBorders;

		// Footer — Mode indicator
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
			const screenAny = screen as any;
			let mode = "IDLE";
			if (screenAny.focused === inputField) mode = "INPUT";
			else if (screenAny.focused === sidebar) mode = "CHANNELS";
			else if (screenAny.focused === chatLog) mode = "CHATLOG";

			const hint = mode === "INPUT"
				? " Enter: Send | Esc: Chat | C-c: Quit"
				: mode === "CHANNELS"
				? " Up/Down: Navigate | Enter: Select | Esc: Input | Tab: View | Q: Quit"
				: " i: Input | c: Channels | Tab: View | Q: Quit";

			footer.setContent(`Mode: {yellow-fg}${mode}{/} |${hint}`);
		};
		container._updateFooter = updateFooter;

		// Screen-level shortcuts. These fire even when readInput has the
		// keyboard grabbed (verified in this blessed fork via tmux traces).
		// 'i' / 'c' check the focused widget so they don't steal letters
		// the user is typing into the input box.
		(screen as any).key(["i"], () => {
			if ((screen as any).focused === inputField) return; // already in input
			inputField.focus();
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		(screen as any).key(["c"], () => {
			if ((screen as any).focused === inputField) return;
			sidebar.focus();
			updateBorders();
			container._updateFooter?.();
			screen.render();
		});

		// Escape from the input box → sidebar. In neo-neo-bblessed the
		// readInput callback is NOT invoked on Esc, so we bind at screen
		// level. When input is focused we forcibly tear down the readInput
		// state and shift focus to the sidebar so the user can pick a
		// channel in one keystroke. This bypasses the silent-Esc bug.

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

		// Set initial focus to input
		inputField.focus();
		updateBorders();
		updateFooter();
	} else {
		sidebar = container._sidebar;
		chatLog = container._chatLog;
		inputField = container._inputField;
	}

	// Update Sidebar — only call setItems if channels changed (avoid flashing)
	container._currentChannel = currentChannel;
	const channelsKey = channels.join("\x00");
	if (channelsKey !== container._channelsKey) {
		container._channels = channels;
		container._channelsKey = channelsKey;
		(sidebar as any).setItems(channels);
	}

	// Update title + clear log when channel actually changes
	if (container._displayedChannel !== currentChannel) {
		(chatLog as any).setLabel?.(` ${currentChannel} - ${projectName} `);
		const activeIndex = Math.max(0, channels.indexOf(currentChannel));
		(sidebar as any).select?.(activeIndex);
		if (container._displayedChannel) {
			if ((chatLog as any).setItems) (chatLog as any).setItems([]);
			else (chatLog as any).setContent?.("");
			container._lastMsgTimestamp = 0;
		}
		container._displayedChannel = currentChannel;
	}

	// Add new messages to chatLog (only since last refresh)
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

	// Update border colors and footer text to reflect actual focus
	container._updateBorders?.();
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
