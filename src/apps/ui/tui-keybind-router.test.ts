/**
 * P1139 — headless tests for keybind routing (AC-8: P247 Tab-cycle honor).
 * Proves Tab is always the VIEW switcher and W is the WORKFLOW switcher only in
 * kanban — no live blessed screen required.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import type { LifecycleView } from "./screen-lifecycle.ts";
import {
	type KeybindAction,
	nextWorkflow,
	normalizeKey,
	routeKeybind,
	viewSupportsWorkflowCycle,
} from "./tui-keybind-router.ts";

const ALL_VIEWS: LifecycleView[] = [
	"proposal-list",
	"proposal-detail",
	"kanban",
	"cockpit",
	"headlines",
	"chat",
];

describe("P1139 AC-8 routeKeybind — Tab is ALWAYS the view switcher", () => {
	test("Tab maps to switch-view in every view, never to workflow", () => {
		for (const view of ALL_VIEWS) {
			const action: KeybindAction = routeKeybind(view, "tab");
			assert.strictEqual(
				action.kind,
				"switch-view",
				`Tab in ${view} must switch view`,
			);
		}
	});
});

describe("P1139 AC-8 routeKeybind — W cycles workflow ONLY in kanban", () => {
	test("W in kanban cycles the workflow filter", () => {
		assert.strictEqual(routeKeybind("kanban", "w").kind, "cycle-workflow");
	});

	test("shifted W (upper-case) also cycles workflow in kanban", () => {
		assert.strictEqual(routeKeybind("kanban", "W").kind, "cycle-workflow");
	});

	test("W in non-kanban views is ignored (no workflow concept there)", () => {
		for (const view of ALL_VIEWS.filter((v) => v !== "kanban")) {
			assert.strictEqual(
				routeKeybind(view, "w").kind,
				"ignore",
				`W in ${view} must not cycle workflow`,
			);
		}
	});

	test("viewSupportsWorkflowCycle is true only for kanban", () => {
		for (const view of ALL_VIEWS) {
			assert.strictEqual(
				viewSupportsWorkflowCycle(view),
				view === "kanban",
			);
		}
	});
});

describe("P1139 AC-8 routeKeybind — q / Ctrl-C is the single exit", () => {
	test("q and C-c route to exit from any view", () => {
		for (const view of ALL_VIEWS) {
			assert.strictEqual(routeKeybind(view, "q").kind, "exit");
			assert.strictEqual(routeKeybind(view, "C-c").kind, "exit");
		}
	});

	test("Tab is distinct from workflow: kanban Tab still switches view", () => {
		// The exact P247 confusion guard: in kanban, Tab=view, W=workflow.
		assert.strictEqual(routeKeybind("kanban", "tab").kind, "switch-view");
		assert.strictEqual(routeKeybind("kanban", "w").kind, "cycle-workflow");
	});

	test("unrouted keys are ignored so the view can handle them", () => {
		assert.strictEqual(routeKeybind("kanban", "j").kind, "ignore");
		assert.strictEqual(routeKeybind("cockpit", "enter").kind, "ignore");
	});
});

describe("P1139 normalizeKey + nextWorkflow", () => {
	test("normalizeKey folds case and trims", () => {
		assert.strictEqual(normalizeKey("W"), "w");
		assert.strictEqual(normalizeKey(" Tab "), "tab");
		assert.strictEqual(normalizeKey("C-c"), "c-c");
	});

	test("nextWorkflow wraps around the available list", () => {
		const wf = ["rfc", "hotfix", "obsolete"];
		assert.strictEqual(nextWorkflow("rfc", wf), "hotfix");
		assert.strictEqual(nextWorkflow("hotfix", wf), "obsolete");
		assert.strictEqual(nextWorkflow("obsolete", wf), "rfc");
	});

	test("nextWorkflow falls back to first on unknown, is a no-op when empty", () => {
		assert.strictEqual(nextWorkflow("???", ["rfc", "hotfix"]), "rfc");
		assert.strictEqual(nextWorkflow("rfc", []), "rfc");
	});
});
