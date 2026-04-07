import assert from "node:assert";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Directive, Proposal } from "../../src/types/index.ts";
import DirectivesPage from "../../src/web/components/DirectivesPage";
import { expect } from "../support/test-utils.ts";

const statuses = ["Potential", "Active", "Complete"];

const directives: Directive[] = [
	{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
];

const makeProposal = (overrides: Partial<Proposal>): Proposal => ({
	id: "proposal-1",
	title: "Proposal",
	status: "Potential",
	assignee: [],
	labels: [],
	dependencies: [],
	createdDate: "2024-01-01",
	...overrides,
});

const renderDirectivesPage = (proposals: Proposal[]) =>
	renderToString(
		<MemoryRouter>
			<DirectivesPage
				proposals={proposals}
				statuses={statuses}
				directiveEntities={directives}
				archivedDirectives={[]}
				onEditProposal={() => {}}
			/>
		</MemoryRouter>,
	);

const getUnassignedCount = (html: string): string | undefined => {
	const normalizedHtml = html.replaceAll("<!-- -->", "");
	const match = normalizedHtml.match(/Unassigned proposals[\s\S]*?\((\d+)\)/);
	return match?.[1];
};

describe("DirectivesPage unassigned filtering", () => {
	it("hides done unassigned proposals and counts only non-done unassigned proposals", () => {
		const html = renderDirectivesPage([
			makeProposal({
				id: "proposal-1",
				title: "Unassigned active",
				status: "Potential",
			}),
			makeProposal({
				id: "proposal-2",
				title: "Unassigned done",
				status: "Complete",
			}),
			makeProposal({
				id: "proposal-3",
				title: "Directive active",
				directive: "m-1",
				status: "Potential",
			}),
		]);

		assert.ok(html.includes("Unassigned active"));
		assert.ok(!html.includes("Unassigned done"));
		expect(getUnassignedCount(html)).toBe("1");
		assert.ok(html.includes("Directive active"));
	});

	it("shows an empty proposal when all unassigned proposals are done", () => {
		const html = renderDirectivesPage([
			makeProposal({
				id: "proposal-1",
				title: "Complete unassigned",
				status: "Complete",
			}),
			makeProposal({
				id: "proposal-2",
				title: "Complete unassigned",
				status: "Complete",
			}),
		]);

		assert.ok(
			html.includes(
				"No active unassigned proposals. Completed proposals are hidden.",
			),
		);
		assert.ok(!html.includes("Complete unassigned"));
		assert.ok(!html.includes("Complete unassigned"));
		expect(getUnassignedCount(html)).toBe("0");
	});

	it("keeps directive-assigned groups rendering with existing behavior", () => {
		const html = renderDirectivesPage([
			makeProposal({
				id: "proposal-1",
				title: "Unassigned done",
				status: "Complete",
			}),
			makeProposal({
				id: "proposal-2",
				title: "Directive proposal",
				directive: "m-1",
				status: "Active",
			}),
		]);

		assert.ok(html.includes("Release 1"));
		assert.ok(html.includes("Directive proposal"));
		assert.ok(!html.includes("Unassigned done"));
	});
});
