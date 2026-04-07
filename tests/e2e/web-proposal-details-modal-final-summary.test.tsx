import assert from "node:assert";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { renderToString } from "react-dom/server";
import type { Directive, Proposal } from "../../src/types/index.ts";
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

describe("Web proposal popup Final Summary display", () => {
	it("renders Final Summary section in preview when present", () => {
		setupDom();

		const proposal: Proposal = {
			id: "proposal-1",
			title: "Proposal with summary",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			finalSummary: "PR-style summary",
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

		assert.ok(html.includes("Final Summary"));
		assert.ok(html.includes("PR-style summary"));
	});

	it("hides Final Summary section in preview when empty", () => {
		setupDom();

		const proposal: Proposal = {
			id: "proposal-2",
			title: "Proposal without summary",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
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

		assert.ok(!html.includes("Final Summary"));
	});

	it("shows Final Summary editor in create mode", () => {
		setupDom();

		const html = renderToString(
			<ThemeProvider>
				<ProposalDetailsModal isOpen={true} onClose={() => {}} />
			</ThemeProvider>,
		);

		assert.ok(html.includes("Final Summary"));
		assert.ok(html.includes("PR-style summary of what was implemented"));
	});

	it("resolves numeric directive aliases to directive IDs in the directive selector", () => {
		setupDom();

		const proposal: Proposal = {
			id: "proposal-3",
			title: "Proposal with numeric directive alias",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			directive: "1",
		};
		const directives: Directive[] = [
			{
				id: "m-1",
				title: "Release 1",
				description: "Directive: Release 1",
				rawContent: "## Description\n\nDirective: Release 1",
			},
		];

		const html = renderToString(
			<ThemeProvider>
				<ProposalDetailsModal
					proposal={proposal}
					isOpen={true}
					onClose={() => {}}
					directiveEntities={directives}
				/>
			</ThemeProvider>,
		);

		assert.ok(html.includes('option value="m-1"'));
		assert.ok(html.includes("Release 1"));
		assert.ok(!html.includes('option value="1"'));
	});

	it("resolves zero-padded directive aliases to canonical directive IDs in the directive selector", () => {
		setupDom();

		const proposal: Proposal = {
			id: "proposal-4",
			title: "Proposal with zero-padded directive alias",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			directive: "m-01",
		};
		const directives: Directive[] = [
			{
				id: "m-1",
				title: "Release 1",
				description: "Directive: Release 1",
				rawContent: "## Description\n\nDirective: Release 1",
			},
		];

		const html = renderToString(
			<ThemeProvider>
				<ProposalDetailsModal
					proposal={proposal}
					isOpen={true}
					onClose={() => {}}
					directiveEntities={directives}
				/>
			</ThemeProvider>,
		);

		assert.ok(html.includes('option value="m-1"'));
		assert.ok(!html.includes('option value="m-01"'));
	});

	it("prefers archived directive IDs over active title matches for ID-shaped values", () => {
		setupDom();

		const proposal: Proposal = {
			id: "proposal-5",
			title: "Proposal with ID-shaped collision",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			directive: "m-0",
		};
		const directives: Directive[] = [
			{
				id: "m-2",
				title: "m-0",
				description: "Directive: m-0",
				rawContent: "## Description\n\nDirective: m-0",
			},
		];
		const archivedDirectives: Directive[] = [
			{
				id: "m-0",
				title: "Archived source",
				description: "Directive: Archived source",
				rawContent: "## Description\n\nDirective: Archived source",
			},
		];

		const html = renderToString(
			<ThemeProvider>
				<ProposalDetailsModal
					proposal={proposal}
					isOpen={true}
					onClose={() => {}}
					directiveEntities={directives}
					archivedDirectiveEntities={archivedDirectives}
				/>
			</ThemeProvider>,
		);

		assert.ok(html.includes('option value="m-0"'));
		assert.ok(!html.includes('option value="m-2" selected'));
	});
});
