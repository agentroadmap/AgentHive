/**
 * Issue Tracker Module
 * Tracks test findings (bugs/regressions) linked to proposals.
 * Open issues can block Reached transitions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type IssueSeverity = "critical" | "major" | "minor";
export type IssueStatus = "open" | "resolved" | "wontfix";

export interface TestIssue {
	/** Unique issue ID (e.g., "ISSUE-10.1-1") */
	id: string;
	/** Proposal that introduced or is affected by the issue */
	proposalId: string;
	/** Brief description of the issue */
	title: string;
	/** Detailed description */
	description?: string;
	/** Severity level */
	severity: IssueSeverity;
	/** Test file that discovered the issue */
	testFile: string;
	/** When the issue was discovered */
	discoveredAt: string;
	/** Current status */
	status: IssueStatus;
	/** When resolved (if applicable) */
	resolvedAt?: string;
	/** Resolution notes */
	resolution?: string;
}

export interface IssueStore {
	/** All tracked issues */
	issues: TestIssue[];
	/** Last updated timestamp */
	updatedAt: string;
}

/**
 * Get the issues file path for a project.
 */
export function getIssuesPath(roadmapDir: string): string {
	return join(roadmapDir, "issues.json");
}

/**
 * Load issues from disk. Returns empty store if file doesn't exist.
 */
export function loadIssues(roadmapDir: string): IssueStore {
	const issuesPath = getIssuesPath(roadmapDir);
	if (!existsSync(issuesPath)) {
		return { issues: [], updatedAt: new Date().toISOString() };
	}
	const content = readFileSync(issuesPath, "utf-8");
	return JSON.parse(content) as IssueStore;
}

/**
 * Save issues to disk.
 */
export function saveIssues(roadmapDir: string, store: IssueStore): void {
	const issuesPath = getIssuesPath(roadmapDir);
	const dir = join(roadmapDir);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	store.updatedAt = new Date().toISOString();
	writeFileSync(issuesPath, JSON.stringify(store, null, 2));
}

/**
 * Generate next issue ID for a proposal.
 */
export function generateIssueId(
	proposalId: string,
	existingIssues: TestIssue[],
): string {
	const proposalIssues = existingIssues.filter(
		(i) => i.proposalId === proposalId,
	);
	const nextNum = proposalIssues.length + 1;
	return `ISSUE-${proposalId}-${nextNum}`;
}

/**
 * Create a new test issue.
 */
export function createIssue(
	proposalId: string,
	title: string,
	severity: IssueSeverity,
	testFile: string,
	description?: string,
): TestIssue {
	return {
		id: "", // Will be set by addIssue
		proposalId,
		title,
		description,
		severity,
		testFile,
		discoveredAt: new Date().toISOString(),
		status: "open",
	};
}

/**
 * Add an issue to the store. Assigns an ID.
 */
export function addIssue(store: IssueStore, issue: TestIssue): IssueStore {
	const id = generateIssueId(issue.proposalId, store.issues);
	const newIssue = { ...issue, id };
	return {
		...store,
		issues: [...store.issues, newIssue],
	};
}

/**
 * Resolve an issue.
 */
export function resolveIssue(
	store: IssueStore,
	issueId: string,
	resolution: string,
): IssueStore {
	return {
		...store,
		issues: store.issues.map((i) =>
			i.id === issueId
				? {
						...i,
						status: "resolved" as IssueStatus,
						resolvedAt: new Date().toISOString(),
						resolution,
					}
				: i,
		),
	};
}

/**
 * Mark an issue as won't fix.
 */
export function wontFixIssue(
	store: IssueStore,
	issueId: string,
	reason: string,
): IssueStore {
	return {
		...store,
		issues: store.issues.map((i) =>
			i.id === issueId
				? {
						...i,
						status: "wontfix" as IssueStatus,
						resolvedAt: new Date().toISOString(),
						resolution: reason,
					}
				: i,
		),
	};
}

/**
 * Get open issues for a specific proposal.
 */
export function getProposalIssues(
	store: IssueStore,
	proposalId: string,
): TestIssue[] {
	return store.issues.filter(
		(i) => i.proposalId === proposalId && i.status === "open",
	);
}

/**
 * Get open critical or major issues for a proposal (those that block Reached).
 */
export function getBlockingIssues(
	store: IssueStore,
	proposalId: string,
): TestIssue[] {
	return store.issues.filter(
		(i) =>
			i.proposalId === proposalId &&
			i.status === "open" &&
			(i.severity === "critical" || i.severity === "major"),
	);
}

/**
 * Check if a proposal is blocked by open issues.
 */
export function isBlockedByIssues(
	store: IssueStore,
	proposalId: string,
): boolean {
	return getBlockingIssues(store, proposalId).length > 0;
}

/**
 * Format issues for display.
 */
export function formatIssues(issues: TestIssue[]): string {
	if (issues.length === 0) return "No issues found.";

	const lines: string[] = [];
	for (const issue of issues) {
		const icon =
			issue.severity === "critical"
				? "🔴"
				: issue.severity === "major"
					? "🟡"
					: "⚪";
		lines.push(`${icon} ${issue.id}: ${issue.title}`);
		lines.push(
			`   Severity: ${issue.severity} | Status: ${issue.status} | Found: ${issue.testFile}`,
		);
		if (issue.description) {
			lines.push(`   ${issue.description}`);
		}
	}
	return lines.join("\n");
}
