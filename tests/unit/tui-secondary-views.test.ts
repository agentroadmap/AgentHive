import assert from "node:assert";
import { describe, test } from "node:test";
import { renderChat } from "../../src/ui/chat.ts";
import { renderCockpit } from "../../src/ui/cockpit.ts";
import { renderHeadlines } from "../../src/ui/headlines.ts";
import { createScreen } from "../../src/ui/tui.ts";

describe("secondary TUI views", () => {
	test("cockpit attaches its root container to the screen", () => {
		const screen = createScreen({ smartCSR: false });
		try {
			renderCockpit(screen, {
				agents: [],
				proposals: [],
				ledger: [],
				messages: [],
			});

			assert.ok((screen as any)._cockpitContainer);
			assert.ok(screen.children.includes((screen as any)._cockpitContainer));
		} finally {
			screen.destroy();
			process.stdin.pause();
		}
	});

	test("headlines attaches its root container to the screen", () => {
		const screen = createScreen({ smartCSR: false });
		try {
			renderHeadlines(screen, {
				messages: [],
				projectName: "AgentHive",
			});

			assert.ok((screen as any)._headlinesContainer);
			assert.ok(screen.children.includes((screen as any)._headlinesContainer));
		} finally {
			screen.destroy();
			process.stdin.pause();
		}
	});

	test("chat attaches its root container to the screen", () => {
		const screen = createScreen({ smartCSR: false });
		try {
			renderChat(screen, {
				messages: [],
				channels: ["public"],
				currentChannel: "public",
				projectName: "AgentHive",
				userSystemName: "HUMAN",
			});

			assert.ok((screen as any)._chatContainer);
			assert.ok(screen.children.includes((screen as any)._chatContainer));
		} finally {
			screen.destroy();
			process.stdin.pause();
		}
	});
});
