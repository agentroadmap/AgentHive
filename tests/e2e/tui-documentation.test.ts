import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import { createProposalPopup } from "../../src/ui/proposal-viewer-with-search.ts";
import { createScreen } from "../../src/ui/tui.ts";

describe("TUI documentation display", () => {
	it("shows documentation entries in proposal popup content", async () => {
		const screen = createScreen({ smartCSR: false });
		const originalIsTTY = process.stdout.isTTY;
		let patchedTTY = false;

		try {
			if (process.stdout.isTTY === false) {
				Object.defineProperty(process.stdout, "isTTY", {
					value: true,
					configurable: true,
				});
				patchedTTY = true;
			}

			const proposal: Proposal = {
				id: "proposal-1",
				title: "Documented proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
				documentation: ["README.md", "https://docs.example.com"],
			};

			const popup = await createProposalPopup(screen, proposal);
			assert.notStrictEqual(popup, null);

			const contentArea = popup?.contentArea as
				| {
						getContent?: () => string;
						content?: string;
				  }
				| undefined;
			const content = contentArea?.getContent
				? contentArea.getContent()
				: (contentArea?.content ?? "");
			const contentText = String(content);
			assert.ok(contentText.includes("Documentation"));
			assert.ok(contentText.includes("README.md"));
			assert.ok(contentText.includes("https://docs.example.com"));

			popup?.close();
		} finally {
			if (patchedTTY) {
				Object.defineProperty(process.stdout, "isTTY", {
					value: originalIsTTY,
					configurable: true,
				});
			}
			screen.destroy();
		}
	});
});
