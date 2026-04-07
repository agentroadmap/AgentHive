import assert from "node:assert";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { renderToString } from "react-dom/server";
import type { Proposal } from "../../src/types/index.ts";
import { ProposalDetailsModal } from "../../src/web/components/ProposalDetailsModal";
import { ThemeProvider } from "../../src/web/contexts/ThemeContext";

const setupDom = () => {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "http://localhost",
	});
	globalThis.window = dom.window as unknown as Window & typeof globalThis;
	globalThis.document = dom.window.document as Document;
	globalThis.navigator = dom.window.navigator as Navigator;
	globalThis.localStorage = dom.window.localStorage;

	if (!window.matchMedia) {
		window.matchMedia = () =>
			({
				matches: false,
				media: "",
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList;
	}
};

describe("Web proposal popup documentation display", () => {
	it("renders documentation entries when present", () => {
		setupDom();

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

		const html = renderToString(
			<ThemeProvider>
				<ProposalDetailsModal
					proposal={proposal}
					isOpen={true}
					onClose={() => {}}
				/>
			</ThemeProvider>,
		);

		assert.ok(html.includes("Documentation"));
		assert.ok(html.includes("README.md"));
		assert.ok(html.includes("https://docs.example.com"));
	});

	it("hides documentation section when empty", () => {
		setupDom();

		const proposal: Proposal = {
			id: "proposal-2",
			title: "No docs proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			documentation: [],
		};

		const html = renderToString(
			<ThemeProvider>
				<ProposalDetailsModal
					proposal={proposal}
					isOpen={true}
					onClose={() => {}}
				/>
			</ThemeProvider>,
		);

		assert.ok(!html.includes("Documentation"));
	});
});
