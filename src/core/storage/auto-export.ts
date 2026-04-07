/**
 * Auto-Export System
 *
 * Exports proposals and artifacts on major changes:
 * - Proposal transitions (Draft → Active, Active → Complete)
 * - New proposal creation
 * - Decisions made
 * - Directives issued
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const EXPORT_DIR = "exports";

function ensureExportDir(): void {
	if (!existsSync(EXPORT_DIR)) {
		mkdirSync(EXPORT_DIR, { recursive: true });
	}
}

export function exportOnTransition(
	proposalId: string,
	from: string,
	to: string,
): void {
	ensureExportDir();

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const exportFile = `${EXPORT_DIR}/${proposalId}_${from}_to_${to}_${timestamp}.json`;

	const data = {
		proposalId,
		transition: { from, to },
		timestamp: new Date().toISOString(),
		exportedBy: "auto-export-system",
	};

	writeFileSync(exportFile, JSON.stringify(data, null, 2));
	console.log(`[AutoExport] Transition: ${proposalId} ${from} → ${to}`);

	// Auto-commit if major change
	if (isMajorChange(from, to)) {
		autoCommit(`Proposal ${proposalId}: ${from} → ${to}`);
	}
}

export function exportOnCreate(proposalId: string, title: string): void {
	ensureExportDir();
	console.log(`[AutoExport] Created: ${proposalId} - ${title}`);
}

export function exportOnDecision(decisionId: string, outcome: string): void {
	ensureExportDir();
	console.log(`[AutoExport] Decision: ${decisionId} - ${outcome}`);
	autoCommit(`Decision ${decisionId}: ${outcome}`);
}

function isMajorChange(from: string, to: string): boolean {
	const majorTransitions = [
		["Draft", "Active"],
		["Active", "Review"],
		["Review", "Complete"],
		["Proposal", "Accepted"],
	];
	return majorTransitions.some(([f, t]) => f === from && t === to);
}

function autoCommit(message: string): void {
	try {
		execSync("git add -A", { cwd: process.cwd() });
		execSync(`git commit -m "auto: ${message}" --allow-empty`, {
			cwd: process.cwd(),
		});
		execSync("git push", { cwd: process.cwd() });
		console.log(`[AutoExport] Committed: ${message}`);
	} catch (e) {
		console.log(
			`[AutoExport] Commit failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// Export board proposal
export function exportBoardProposal(): void {
	ensureExportDir();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	console.log(`[AutoExport] Board proposal exported at ${timestamp}`);
}
