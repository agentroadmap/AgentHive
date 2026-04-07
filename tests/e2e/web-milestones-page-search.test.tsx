import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Directive, Proposal } from "../../src/types/index.ts";
import DirectivesPage from "../../src/web/components/DirectivesPage.tsx";

const createProposal = (overrides: Partial<Proposal>): Proposal => ({
	id: "proposal-1",
	title: "Proposal",
	status: "Potential",
	assignee: [],
	labels: [],
	dependencies: [],
	createdDate: "2026-01-01",
	...overrides,
});

const directiveEntities: Directive[] = [
	{
		id: "m-1",
		title: "Release 1",
		description: "Directive: Release 1",
		rawContent: "## Description\n\nDirective: Release 1",
	},
	{
		id: "m-2",
		title: "Release 2",
		description: "Directive: Release 2",
		rawContent: "## Description\n\nDirective: Release 2",
	},
];

const baseProposals: Proposal[] = [
	createProposal({
		id: "proposal-101",
		title: "Setup authentication flow",
		status: "Active",
		directive: "m-1",
	}),
	createProposal({
		id: "proposal-202",
		title: "Deploy pipeline",
		status: "Potential",
		directive: "m-1",
	}),
	createProposal({
		id: "proposal-404",
		title: "Ship docs site",
		status: "Potential",
		directive: "m-2",
	}),
	createProposal({
		id: "proposal-303",
		title: "Draft release notes",
		status: "Potential",
	}),
];

let activeRoot: Root | null = null;

const setupDom = () => {
	const dom = new JSDOM(
		"<!doctype html><html><body><div id='root'></div></body></html>",
		{ url: "http://localhost" },
	);
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	globalThis.window = dom.window as unknown as Window & typeof globalThis;
	globalThis.document = dom.window.document as unknown as Document;
	globalThis.navigator = dom.window.navigator as unknown as Navigator;
	globalThis.localStorage = dom.window.localStorage as unknown as Storage;

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

	const htmlElementPrototype = window.HTMLElement.prototype as unknown as {
		attachEvent?: () => void;
		detachEvent?: () => void;
	};
	if (typeof htmlElementPrototype.attachEvent !== "function") {
		htmlElementPrototype.attachEvent = () => {};
	}
	if (typeof htmlElementPrototype.detachEvent !== "function") {
		htmlElementPrototype.detachEvent = () => {};
	}
};

const renderPage = (proposals: Proposal[] = baseProposals): HTMLElement => {
	setupDom();
	const container = document.getElementById("root");
	assert.ok(container);
	activeRoot = createRoot(container as HTMLElement);
	act(() => {
		activeRoot?.render(
			<MemoryRouter>
				<DirectivesPage
					proposals={proposals}
					statuses={["Potential", "Active", "Complete"]}
					directiveEntities={directiveEntities}
					archivedDirectives={[]}
					onEditProposal={() => {}}
				/>
			</MemoryRouter>,
		);
	});
	return container as HTMLElement;
};

const getSearchInput = (container: HTMLElement): HTMLInputElement => {
	const input = container.querySelector(
		"input[aria-label='Search directives']",
	);
	assert.ok(input);
	return input as HTMLInputElement;
};

const setSearchValue = (container: HTMLElement, value: string) => {
	const input = getSearchInput(container);
	act(() => {
		input.value = value;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
};

const clickElement = (element: Element) => {
	act(() => {
		element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	});
};

afterEach(() => {
	if (activeRoot) {
		act(() => {
			activeRoot?.unmount();
		});
		activeRoot = null;
	}
});

describe("Web directives page search", () => {
	it("renders a keyboard-focusable search input near the header", () => {
		const container = renderPage();
		assert.ok(container.textContent.includes("Directives"));

		const input = getSearchInput(container);
		assert.strictEqual(input.disabled, false);

		input.focus();
		assert.strictEqual(document.activeElement, input);
	});

	it("searching one directive still renders other directive sections", () => {
		const container = renderPage();
		const initialText = container.textContent ?? "";
		assert.ok(initialText.includes("Setup authentication flow"));
		assert.ok(initialText.includes("Deploy pipeline"));
		assert.ok(initialText.includes("Ship docs site"));
		assert.ok(initialText.includes("Draft release notes"));
		assert.ok(initialText.includes("Release 1"));
		assert.ok(initialText.includes("Release 2"));

		setSearchValue(container, "authentication");
		const filteredText = container.textContent ?? "";
		assert.ok(filteredText.includes("Release 1"));
		assert.ok(filteredText.includes("Release 2"));
		assert.ok(filteredText.includes("Setup authentication flow"));
		assert.ok(!filteredText.includes("Deploy pipeline"));
		assert.ok(!filteredText.includes("Ship docs site"));
		assert.ok(filteredText.includes("No proposals"));
	});

	it("keeps unassigned section visible during search even when no unassigned proposals match", () => {
		const container = renderPage();

		setSearchValue(container, "proposal-404");
		const filteredText = container.textContent ?? "";
		assert.ok(filteredText.includes("Unassigned proposals"));
		assert.ok(filteredText.includes("No matching unassigned proposals."));
		assert.ok(!filteredText.includes("Draft release notes"));

		const clearSearchButton = container.querySelector(
			"button[aria-label='Clear directive search']",
		);
		assert.ok(clearSearchButton);
		clickElement(clearSearchButton as HTMLButtonElement);

		const restoredText = container.textContent ?? "";
		assert.ok(restoredText.includes("Setup authentication flow"));
		assert.ok(restoredText.includes("Deploy pipeline"));
		assert.ok(restoredText.includes("Draft release notes"));
	});

	it("no-match search keeps directive and unassigned sections visible", () => {
		const container = renderPage();

		setSearchValue(container, "zzzz-no-match");
		const noMatchText = container.textContent ?? "";
		assert.ok(
			noMatchText.includes('No directives or proposals match "zzzz-no-match".'),
		);
		assert.ok(noMatchText.includes("Release 1"));
		assert.ok(noMatchText.includes("Release 2"));
		assert.ok(noMatchText.includes("Unassigned proposals"));
	});
});
