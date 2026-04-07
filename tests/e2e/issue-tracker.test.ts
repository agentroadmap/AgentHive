import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as issueTracker from "../../src/core/pipeline/issue-tracker.ts";

const TEST_DIR = join(process.cwd(), "tmp", "test-issue-tracker");

describe("Issue Tracker Module", () => {
	beforeEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("should return empty store if file does not exist", () => {
		const store = issueTracker.loadIssues(TEST_DIR);
		assert.deepEqual(store.issues, []);
		assert.ok(store.updatedAt);
	});

	it("should generate sequential issue IDs for a proposal", () => {
		const issues: issueTracker.TestIssue[] = [];
		const id1 = issueTracker.generateIssueId("1.1", issues);
		assert.equal(id1, "ISSUE-1.1-1");

		const issue1 = issueTracker.createIssue("1.1", "Bug 1", "major", "test.ts");
		issue1.id = id1;
		issues.push(issue1);

		const id2 = issueTracker.generateIssueId("1.1", issues);
		assert.equal(id2, "ISSUE-1.1-2");

		const idOther = issueTracker.generateIssueId("2.0", issues);
		assert.equal(idOther, "ISSUE-2.0-1");
	});

	it("should create, add, and save issues", () => {
		let store = issueTracker.loadIssues(TEST_DIR);
		const issue = issueTracker.createIssue(
			"10.1",
			"UI glitch in board",
			"minor",
			"board.test.ts",
			"Detailed description",
		);

		store = issueTracker.addIssue(store, issue);
		assert.equal(store.issues.length, 1);
		assert.equal(store.issues[0]?.id, "ISSUE-10.1-1");
		assert.equal(store.issues[0]?.title, "UI glitch in board");

		issueTracker.saveIssues(TEST_DIR, store);

		const loaded = issueTracker.loadIssues(TEST_DIR);
		assert.equal(loaded.issues.length, 1);
		assert.equal(loaded.issues[0]?.id, "ISSUE-10.1-1");
	});

	it("should resolve and wontfix issues", () => {
		let store = issueTracker.loadIssues(TEST_DIR);
		const issue = issueTracker.createIssue("1", "Bug", "major", "t.ts");
		store = issueTracker.addIssue(store, issue);
		const issueId = store.issues[0]?.id;

		store = issueTracker.resolveIssue(store, issueId, "Fixed in commit abc");
		assert.equal(store.issues[0]?.status, "resolved");
		assert.equal(store.issues[0].resolution, "Fixed in commit abc");
		assert.ok(store.issues[0].resolvedAt);

		const issue2 = issueTracker.createIssue(
			"2",
			"Won't fix this",
			"minor",
			"t.ts",
		);
		store = issueTracker.addIssue(store, issue2);
		const issueId2 = store.issues[1].id;

		store = issueTracker.wontFixIssue(store, issueId2, "Not a bug");
		assert.equal(store.issues[1].status, "wontfix");
		assert.equal(store.issues[1].resolution, "Not a bug");
	});

	it("should identify blocking issues correctly", () => {
		let store = issueTracker.loadIssues(TEST_DIR);
		store = issueTracker.addIssue(
			store,
			issueTracker.createIssue("5", "Crit", "critical", "t.ts"),
		);
		store = issueTracker.addIssue(
			store,
			issueTracker.createIssue("5", "Major", "major", "t.ts"),
		);
		store = issueTracker.addIssue(
			store,
			issueTracker.createIssue("5", "Minor", "minor", "t.ts"),
		);
		store = issueTracker.addIssue(
			store,
			issueTracker.createIssue("6", "Other", "major", "t.ts"),
		);

		const blocking = issueTracker.getBlockingIssues(store, "5");
		assert.equal(blocking.length, 2); // critical and major
		assert.ok(blocking.some((i) => i.severity === "critical"));
		assert.ok(blocking.some((i) => i.severity === "major"));
		assert.ok(!blocking.some((i) => i.severity === "minor"));

		assert.equal(issueTracker.isBlockedByIssues(store, "5"), true);
		assert.equal(issueTracker.isBlockedByIssues(store, "7"), false);
	});

	it("should format issues for display", () => {
		const issues = [
			issueTracker.createIssue("1", "Critical Bug", "critical", "t1.ts"),
			issueTracker.createIssue("1", "Minor Tweak", "minor", "t2.ts"),
		];
		issues[0].id = "ISSUE-1-1";
		issues[1].id = "ISSUE-1-2";

		const formatted = issueTracker.formatIssues(issues);
		assert.ok(formatted.includes("🔴 ISSUE-1-1: Critical Bug"));
		assert.ok(formatted.includes("⚪ ISSUE-1-2: Minor Tweak"));
		assert.ok(formatted.includes("Found: t1.ts"));
	});
});
