/**
 * P1139 — headless tests for per-view UI state retention (AC-3).
 * Proves kanban cursor, proposal-list scroll, and cockpit state survive a Tab
 * away-and-back — verified against the store contract, no live widget/TTY.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { ViewStateStore } from "./view-state-store.ts";

describe("P1139 AC-3 ViewStateStore — state survives Tab away-and-back", () => {
	test("kanban cursor (column/row) is preserved across a Tab cycle", () => {
		const store = new ViewStateStore();
		// User moves the kanban cursor, then Tabs away (hide → save).
		store.save("kanban", { kanbanColumn: 2, kanbanRow: 5 });

		// ... visits cockpit, headlines, chat ... then Tabs back (show → restore).
		const restored = store.restore("kanban");
		assert.strictEqual(restored.kanbanColumn, 2);
		assert.strictEqual(restored.kanbanRow, 5);
	});

	test("proposal-list scroll + selection survive a Tab away-and-back", () => {
		const store = new ViewStateStore();
		store.save("proposal-list", { listScroll: 42, listSelected: 7 });
		const restored = store.restore("proposal-list");
		assert.strictEqual(restored.listScroll, 42);
		assert.strictEqual(restored.listSelected, 7);
	});

	test("cockpit focused panel + scroll are retained", () => {
		const store = new ViewStateStore();
		store.save("cockpit", { cockpitPanel: "agencies", cockpitScroll: 12 });
		const restored = store.restore("cockpit");
		assert.strictEqual(restored.cockpitPanel, "agencies");
		assert.strictEqual(restored.cockpitScroll, 12);
	});

	test("kanban workflow filter survives a Tab too (W-cycle persists)", () => {
		const store = new ViewStateStore();
		store.save("kanban", { workflow: "hotfix", kanbanColumn: 1 });
		assert.strictEqual(store.restore("kanban").workflow, "hotfix");
	});
});

describe("P1139 AC-3 ViewStateStore — partial merge & isolation", () => {
	test("partial save merges without clobbering other retained fields", () => {
		const store = new ViewStateStore();
		store.save("kanban", { kanbanColumn: 3, kanbanRow: 9 });
		// A later hide only knows the row changed — column must survive.
		store.save("kanban", { kanbanRow: 0 });
		const restored = store.restore("kanban");
		assert.strictEqual(restored.kanbanColumn, 3, "column preserved");
		assert.strictEqual(restored.kanbanRow, 0, "row updated");
	});

	test("undefined fields in a patch never clobber existing state", () => {
		const store = new ViewStateStore();
		store.save("cockpit", { cockpitPanel: "feed", cockpitScroll: 5 });
		store.save("cockpit", { cockpitScroll: undefined });
		assert.strictEqual(store.restore("cockpit").cockpitPanel, "feed");
		assert.strictEqual(store.restore("cockpit").cockpitScroll, 5);
	});

	test("restore returns a copy — callers cannot mutate the store by reference", () => {
		const store = new ViewStateStore();
		store.save("kanban", { kanbanColumn: 1 });
		const a = store.restore("kanban");
		a.kanbanColumn = 99;
		assert.strictEqual(store.restore("kanban").kanbanColumn, 1);
	});

	test("each view's state is isolated; unseen views restore empty", () => {
		const store = new ViewStateStore();
		store.save("kanban", { kanbanColumn: 4 });
		assert.deepStrictEqual(store.restore("headlines"), {});
		assert.strictEqual(store.has("headlines"), false);
		assert.strictEqual(store.has("kanban"), true);
	});

	test("clear drops one view; reset forgets everything (final teardown)", () => {
		const store = new ViewStateStore();
		store.save("kanban", { kanbanColumn: 1 });
		store.save("cockpit", { cockpitScroll: 2 });
		store.clear("kanban");
		assert.strictEqual(store.has("kanban"), false);
		assert.strictEqual(store.has("cockpit"), true);
		store.reset();
		assert.strictEqual(store.has("cockpit"), false);
	});
});
