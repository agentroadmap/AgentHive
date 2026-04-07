/**
 * Pulse Module - Proposal Transition Quality Tracking
 *
 * Implements advisory feedback for proposal transitions.
 * Instead of blocking, provides guidance on missing artifacts
 * and maintains a pulse of transition quality.
 *
 * Agents can override guidance by providing a 'Rationale for Intent'.
 * Pulse table records transition quality for post-hoc visibility.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Valid proposal statuses in order */
export const STATUS_ORDER = [
	"New",
	"Draft",
	"Review",
	"Potential",
	"Active",
	"Accepted",
	"Complete",
	"Rejected",
	"Abandoned",
	"Replaced",
] as const;
export type ProposalStatus = (typeof STATUS_ORDER)[number];

/** Transition quality levels */
export type TransitionQuality = "good" | "warning" | "fast-tracked" | "skipped";

/** Advisory warning types */
export type AdvisoryType =
	| "missing-artifact"
	| "non-sequential"
	| "missing-proof"
	| "missing-notes"
	| "fast-transition"
	| "stale-proposal";

/** Advisory warning */
export interface AdvisoryWarning {
	type: AdvisoryType;
	severity: "info" | "warning" | "critical";
	message: string;
	suggestion: string;
	canOverride: boolean;
}

/** Pulse record for a proposal transition */
export interface PulseRecord {
	proposalId: string;
	fromStatus: ProposalStatus;
	toStatus: ProposalStatus;
	agentId: string;
	timestamp: string;
	quality: TransitionQuality;
	advisories: AdvisoryWarning[];
	overridden: boolean;
	overrideRationale?: string;
	artifactsPresent: ArtifactStatus;
}

/** Status of required artifacts */
export interface ArtifactStatus {
	reachedDate: boolean;
	finalSummary: boolean;
	proofReferences: boolean;
	implementationNotes: boolean;
	testResults: boolean;
}

/** Pulse statistics for a time window */
export interface PulseStats {
	totalTransitions: number;
	goodTransitions: number;
	warningTransitions: number;
	fastTrackedTransitions: number;
	skippedTransitions: number;
	overrideCount: number;
	topAgents: Map<string, number>;
	topAdvisories: Map<AdvisoryType, number>;
}

/** Proposal frontmatter for analysis */
export interface ProposalFrontmatter {
	id: string;
	status: ProposalStatus;
	assignee?: string[];
	created_date?: string;
	updated_date?: string;
	dependencies?: string[];
}

/**
 * Parse proposal frontmatter from markdown content.
 */
export function parseFrontmatter(content: string): ProposalFrontmatter | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const frontmatter: ProposalFrontmatter = { id: "", status: "New" };
	const lines = match[1]?.split("\n") || [];
	let currentKey = "";
	let inArray = false;

	for (const line of lines) {
		const keyMatch = line.match(/^(\w+):\s*(.*)$/);
		if (keyMatch) {
			currentKey = keyMatch[1]!;
			const value = keyMatch[2]?.trim();

			// Strip surrounding quotes from values
			const cleanValue = value?.replace(/^['"]|['"]$/g, "") || "";

			if (currentKey === "id") frontmatter.id = cleanValue;
			else if (currentKey === "status")
				frontmatter.status = (cleanValue as ProposalStatus) || "New";
			else if (currentKey === "created_date")
				frontmatter.created_date = cleanValue;
			else if (currentKey === "updated_date")
				frontmatter.updated_date = cleanValue;

			if (value === "") {
				inArray = true;
			} else {
				inArray = false;
				if (currentKey === "assignee" && value) {
					frontmatter.assignee = [value.replace(/^- /, "")];
				}
			}
		} else if (inArray && line.startsWith("  - ")) {
			if (currentKey === "assignee") {
				frontmatter.assignee = frontmatter.assignee || [];
				frontmatter.assignee.push(line.trim().replace(/^- /, ""));
			} else if (currentKey === "dependencies") {
				frontmatter.dependencies = frontmatter.dependencies || [];
				frontmatter.dependencies.push(line.trim().replace(/^- /, ""));
			}
		}
	}

	return frontmatter;
}

/**
 * Extract artifact status from proposal content.
 */
export function analyzeArtifacts(content: string): ArtifactStatus {
	return {
		reachedDate:
			/reached_date:/.test(content) || /completed_date:/.test(content),
		finalSummary:
			/## Final Summary/.test(content) || /## Summary/.test(content),
		proofReferences:
			/## Proof/.test(content) || /## Verification/.test(content),
		implementationNotes:
			/## Implementation Notes/.test(content) || /## Notes/.test(content),
		testResults: /tests?\s*[:.]?\s*(\d+\/\d+\s*passing|results|coverage)/i.test(
			content,
		),
	};
}

/**
 * Calculate transition quality based on timing and artifacts.
 */
export function calculateTransitionQuality(
	fromStatus: ProposalStatus,
	toStatus: ProposalStatus,
	artifacts: ArtifactStatus,
	proposalAge?: number,
): TransitionQuality {
	// Determine if this is a non-sequential transition
	const fromIndex = STATUS_ORDER.indexOf(fromStatus);
	const toIndex = STATUS_ORDER.indexOf(toStatus);
	const isBackward = toIndex < fromIndex;
	const isSkip = toIndex - fromIndex > 1;

	// Check artifact completeness
	const artifactCount = Object.values(artifacts).filter(Boolean).length;
	const totalArtifacts = Object.keys(artifacts).length;
	const artifactRatio = artifactCount / totalArtifacts;

	// Fast transition detection (proposal created and completed quickly)
	if (
		proposalAge !== undefined &&
		proposalAge < 3600000 &&
		toStatus === "Complete"
	) {
		// Less than 1 hour old and already Complete
		return "fast-tracked";
	}

	// Skipped stages
	if (isSkip) {
		return "skipped";
	}

	// Missing artifacts
	if (artifactRatio < 0.5) {
		return "warning";
	}

	// Backward transition (reopened)
	if (isBackward) {
		return "warning";
	}

	return "good";
}

/**
 * Generate advisory warnings for a transition.
 */
export function generateAdvisories(
	fromStatus: ProposalStatus,
	toStatus: ProposalStatus,
	artifacts: ArtifactStatus,
	quality: TransitionQuality,
): AdvisoryWarning[] {
	const advisories: AdvisoryWarning[] = [];

	// Non-sequential transition
	const fromIndex = STATUS_ORDER.indexOf(fromStatus);
	const toIndex = STATUS_ORDER.indexOf(toStatus);
	if (toIndex - fromIndex > 1) {
		advisories.push({
			type: "non-sequential",
			severity: "warning",
			message: `Jumping from ${fromStatus} to ${toStatus}, skipping intermediate stages`,
			suggestion: `Consider moving through: ${STATUS_ORDER.slice(fromIndex + 1, toIndex).join(" → ")}`,
			canOverride: true,
		});
	}

	// Missing artifacts
	if (!artifacts.reachedDate) {
		advisories.push({
			type: "missing-artifact",
			severity: "warning",
			message: "Missing reached_date or completed_date in frontmatter",
			suggestion: "Add timestamp when proposal was completed",
			canOverride: true,
		});
	}

	if (!artifacts.finalSummary) {
		advisories.push({
			type: "missing-notes",
			severity: "warning",
			message: "Missing Final Summary section",
			suggestion: "Add '## Final Summary' with key outcomes and metrics",
			canOverride: true,
		});
	}

	if (!artifacts.proofReferences) {
		advisories.push({
			type: "missing-proof",
			severity: "info",
			message: "No Proof section found",
			suggestion:
				"Add '## Proof' with test results, commit hashes, or validation output",
			canOverride: true,
		});
	}

	if (!artifacts.implementationNotes) {
		advisories.push({
			type: "missing-notes",
			severity: "info",
			message: "No Implementation Notes section",
			suggestion: "Add '## Implementation Notes' documenting key decisions",
			canOverride: true,
		});
	}

	if (!artifacts.testResults) {
		advisories.push({
			type: "missing-artifact",
			severity: "info",
			message: "No test results or coverage mentioned",
			suggestion: "Include test output showing passing tests",
			canOverride: true,
		});
	}

	// Fast transition warning
	if (quality === "fast-tracked") {
		advisories.push({
			type: "fast-transition",
			severity: "warning",
			message:
				"Proposal completed very quickly (possibly before proper implementation)",
			suggestion:
				"Ensure implementation is complete and tested before marking Complete",
			canOverride: true,
		});
	}

	// Backward transition
	if (toIndex < fromIndex) {
		advisories.push({
			type: "stale-proposal",
			severity: "warning",
			message: `Reopening proposal from ${fromStatus} back to ${toStatus}`,
			suggestion: "Document reason for reopening in implementation notes",
			canOverride: true,
		});
	}

	return advisories;
}

/**
 * Create a pulse record for a proposal transition.
 */
export function createPulseRecord(
	proposalId: string,
	fromStatus: ProposalStatus,
	toStatus: ProposalStatus,
	agentId: string,
	content: string,
	proposalAge?: number,
): PulseRecord {
	const artifacts = analyzeArtifacts(content);
	const quality = calculateTransitionQuality(
		fromStatus,
		toStatus,
		artifacts,
		proposalAge,
	);
	const advisories = generateAdvisories(
		fromStatus,
		toStatus,
		artifacts,
		quality,
	);

	return {
		proposalId,
		fromStatus,
		toStatus,
		agentId,
		timestamp: new Date().toISOString(),
		quality,
		advisories,
		overridden: false,
		artifactsPresent: artifacts,
	};
}

/**
 * Format advisory warnings for CLI display.
 */
export function formatAdvisories(advisories: AdvisoryWarning[]): string {
	if (advisories.length === 0) {
		return "✅ No issues found — transition looks clean!";
	}

	const lines: string[] = [];
	lines.push(`Found ${advisories.length} suggestion(s):\n`);

	for (const advisory of advisories) {
		const icon =
			advisory.severity === "critical"
				? "🚨"
				: advisory.severity === "warning"
					? "⚠️"
					: "ℹ️";
		lines.push(`${icon} ${advisory.message}`);
		lines.push(`   💡 Suggestion: ${advisory.suggestion}`);
		if (advisory.canOverride) {
			lines.push(
				`   ↳ To override: add --rationale "reason for this transition"`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Format artifact status for CLI display.
 */
export function formatArtifactStatus(artifacts: ArtifactStatus): string {
	const lines: string[] = [];
	lines.push("📊 Artifact Status:");

	const checks = [
		["Reached/Completed Date", artifacts.reachedDate],
		["Final Summary", artifacts.finalSummary],
		["Proof References", artifacts.proofReferences],
		["Implementation Notes", artifacts.implementationNotes],
		["Test Results", artifacts.testResults],
	];

	for (const [name, present] of checks) {
		lines.push(`  ${present ? "✅" : "❌"} ${name}`);
	}

	const count = Object.values(artifacts).filter(Boolean).length;
	const total = Object.keys(artifacts).length;
	lines.push(
		`\n  ${count}/${total} artifacts present (${Math.round((count / total) * 100)}%)`,
	);

	return lines.join("\n");
}

/**
 * Generate a hash for a pulse record (for deduplication).
 */
export function pulseRecordHash(record: PulseRecord): string {
	const data = `${record.proposalId}:${record.fromStatus}:${record.toStatus}:${record.timestamp}`;
	return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Pulse storage for recording transitions.
 */
export class PulseStorage {
	private records: PulseRecord[] = [];
	private storagePath: string;

	constructor(storagePath: string = "roadmap/pulses") {
		this.storagePath = storagePath;
	}

	/**
	 * Record a transition pulse.
	 */
	async record(record: PulseRecord): Promise<void> {
		this.records.push(record);

		// Append to daily file
		const date = record.timestamp.split("T")[0]!;
		const filePath = join(this.storagePath, `${date}.jsonl`);

		await mkdir(dirname(filePath), { recursive: true });

		const line = `${JSON.stringify(record)}\n`;
		const { appendFileSync } = await import("node:fs");
		appendFileSync(filePath, line);
	}

	/**
	 * Override an advisory with a rationale.
	 */
	async override(
		proposalId: string,
		timestamp: string,
		rationale: string,
	): Promise<boolean> {
		const record = this.records.find(
			(r) => r.proposalId === proposalId && r.timestamp === timestamp,
		);

		if (!record) return false;

		record.overridden = true;
		record.overrideRationale = rationale;
		return true;
	}

	/**
	 * Get pulse statistics for a time window.
	 */
	getStats(since?: string): PulseStats {
		const filtered = since
			? this.records.filter((r) => r.timestamp >= since)
			: this.records;

		const stats: PulseStats = {
			totalTransitions: filtered.length,
			goodTransitions: 0,
			warningTransitions: 0,
			fastTrackedTransitions: 0,
			skippedTransitions: 0,
			overrideCount: 0,
			topAgents: new Map(),
			topAdvisories: new Map(),
		};

		for (const record of filtered) {
			// Count by quality
			if (record.quality === "good") stats.goodTransitions++;
			else if (record.quality === "warning") stats.warningTransitions++;
			else if (record.quality === "fast-tracked")
				stats.fastTrackedTransitions++;
			else if (record.quality === "skipped") stats.skippedTransitions++;

			// Count overrides
			if (record.overridden) stats.overrideCount++;

			// Count by agent
			const agentCount = stats.topAgents.get(record.agentId) || 0;
			stats.topAgents.set(record.agentId, agentCount + 1);

			// Count advisories
			for (const advisory of record.advisories) {
				const advCount = stats.topAdvisories.get(advisory.type) || 0;
				stats.topAdvisories.set(advisory.type, advCount + 1);
			}
		}

		return stats;
	}

	/**
	 * Format pulse statistics for display.
	 */
	formatStats(stats: PulseStats): string {
		const lines: string[] = [];

		lines.push("📈 Pulse Statistics");
		lines.push("─".repeat(40));
		lines.push(`Total Transitions: ${stats.totalTransitions}`);

		if (stats.totalTransitions > 0) {
			const goodPct = Math.round(
				(stats.goodTransitions / stats.totalTransitions) * 100,
			);
			lines.push(`  ✅ Good: ${stats.goodTransitions} (${goodPct}%)`);
			lines.push(`  ⚠️ Warnings: ${stats.warningTransitions}`);
			lines.push(`  🚀 Fast-tracked: ${stats.fastTrackedTransitions}`);
			lines.push(`  ⏭️ Skipped: ${stats.skippedTransitions}`);
			lines.push(`  ✏️ Overrides: ${stats.overrideCount}`);
		}

		if (stats.topAgents.size > 0) {
			lines.push("\n🏆 Top Agents:");
			const sorted = [...stats.topAgents.entries()].sort((a, b) => b[1] - a[1]);
			for (const [agent, count] of sorted.slice(0, 5)) {
				lines.push(`  ${agent}: ${count} transitions`);
			}
		}

		if (stats.topAdvisories.size > 0) {
			lines.push("\n📊 Most Common Advisories:");
			const sorted = [...stats.topAdvisories.entries()].sort(
				(a, b) => b[1] - a[1],
			);
			for (const [type, count] of sorted.slice(0, 5)) {
				lines.push(`  ${type}: ${count}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Load pulse records from a directory.
	 */
	async load(): Promise<void> {
		try {
			const { existsSync } = await import("node:fs");
			if (!existsSync(this.storagePath)) return;

			const { readdirSync, readFileSync } = await import("node:fs");
			const files = readdirSync(this.storagePath).filter((f) =>
				f.endsWith(".jsonl"),
			);

			for (const file of files.sort()) {
				const content = readFileSync(join(this.storagePath, file), "utf-8");
				const lines = content.split("\n").filter(Boolean);
				for (const line of lines) {
					try {
						const record = JSON.parse(line) as PulseRecord;
						this.records.push(record);
					} catch {
						// Skip malformed lines
					}
				}
			}
		} catch {
			// Storage not accessible
		}
	}
}

/**
 * Daemon API advisory endpoint handler.
 * Returns advisory warnings for a proposed transition.
 */
export function getTransitionAdvisory(
	_proposalId: string,
	fromStatus: string,
	toStatus: string,
	content: string,
	proposalAge?: number,
): {
	allowed: boolean;
	advisories: AdvisoryWarning[];
	artifactStatus: ArtifactStatus;
	quality: TransitionQuality;
	message: string;
} {
	const from = fromStatus as ProposalStatus;
	const to = toStatus as ProposalStatus;

	// Validate statuses
	if (!STATUS_ORDER.includes(from) || !STATUS_ORDER.includes(to)) {
		return {
			allowed: false,
			advisories: [],
			artifactStatus: analyzeArtifacts(content),
			quality: "warning",
			message: `Invalid status transition: ${fromStatus} → ${toStatus}`,
		};
	}

	const artifacts = analyzeArtifacts(content);
	const quality = calculateTransitionQuality(from, to, artifacts, proposalAge);
	const advisories = generateAdvisories(from, to, artifacts, quality);

	// Count critical advisories
	const criticalCount = advisories.filter(
		(a) => a.severity === "critical",
	).length;

	return {
		allowed: criticalCount === 0, // Block only on critical issues
		advisories,
		artifactStatus: artifacts,
		quality,
		message:
			criticalCount === 0
				? `Transition ${from} → ${to} allowed with ${advisories.length} advisory note(s)`
				: `Transition blocked: ${criticalCount} critical issue(s)`,
	};
}

/**
 * Check if notification should be sent for fast-tracked proposals.
 */
export function shouldNotifyPeers(
	quality: TransitionQuality,
	toStatus: ProposalStatus,
): boolean {
	// Notify on fast-tracked completions
	if (quality === "fast-tracked" && toStatus === "Complete") {
		return true;
	}
	// Notify on skipped stages
	if (quality === "skipped") {
		return true;
	}
	return false;
}

/**
 * Format peer notification message.
 */
export function formatPeerNotification(
	proposalId: string,
	agentId: string,
	quality: TransitionQuality,
	fromStatus: ProposalStatus,
	toStatus: ProposalStatus,
): string {
	if (quality === "fast-tracked") {
		return `🚨 Fast-tracked: @${agentId} moved ${proposalId} from ${fromStatus} to ${toStatus} quickly. Please review for completeness.`;
	}
	if (quality === "skipped") {
		return `⚠️ Skipped stages: @${agentId} jumped ${proposalId} from ${fromStatus} to ${toStatus}. Please verify intermediate work.`;
	}
	return `📝 Transition: ${proposalId} ${fromStatus} → ${toStatus} by @${agentId}`;
}
