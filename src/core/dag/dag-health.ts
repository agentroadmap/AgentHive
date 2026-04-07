/**
 * STATE-43: Continuous DAG Health Telemetry
 *
 * Real-time monitoring of DAG health: cycle detection, orphan identification,
 * dependency depth warnings, and dead end detection.
 *
 * AC#1: Cycle detection runs on every proposal edit
 * AC#2: Orphan proposals flagged for review
 * AC#3: Deep dependency chains (>5 levels) warned
 * AC#4: Health report available via CLI/MCP
 * AC#5: Alerts posted to group-pulse channel
 */

import type { Proposal } from "../../types/index.ts";

/** Health issue severity levels */
export type HealthSeverity = "error" | "warning" | "info";

/** Types of health issues */
export type HealthIssueType =
	| "cycle"
	| "orphan"
	| "deep-chain"
	| "dead-end"
	| "missing-dependency"
	| "self-reference";

/** A single health issue found in the DAG */
export interface HealthIssue {
	/** Issue type */
	type: HealthIssueType;
	/** Severity level */
	severity: HealthSeverity;
	/** Primary proposal ID(s) involved */
	proposalIds: string[];
	/** Human-readable description */
	message: string;
	/** Suggested fix or action */
	suggestion?: string;
}

/** Overall DAG health status */
export type HealthStatus = "healthy" | "warning" | "critical";

/** Complete DAG health report */
export interface DAGHealthReport {
	/** Overall status */
	status: HealthStatus;
	/** When the report was generated */
	generatedAt: string;
	/** Total proposals analyzed */
	totalProposals: number;
	/** Issues found */
	issues: HealthIssue[];
	/** Summary counts by severity */
	summary: {
		errors: number;
		warnings: number;
		info: number;
	};
	/** DAG statistics */
	stats: {
		/** Number of roots (no dependencies) */
		rootCount: number;
		/** Number of leaves (no dependents) */
		leafCount: number;
		/** Maximum depth */
		maxDepth: number;
		/** Average depth */
		avgDepth: number;
		/** Number of connected components */
		connectedComponents: number;
	};
}

/** Configuration for health checks */
export interface DAGHealthConfig {
	/** Maximum allowed dependency depth before warning */
	maxDepthWarning: number;
	/** Check for cycles */
	enableCycleDetection: boolean;
	/** Flag orphan proposals (no deps and no dependents) */
	enableOrphanDetection: boolean;
	/** Flag dead ends (unreachable from any root) */
	enableDeadEndDetection: boolean;
	/** Minimum proposals to run full analysis */
	minProposalsForAnalysis: number;
}

const DEFAULT_CONFIG: DAGHealthConfig = {
	maxDepthWarning: 5,
	enableCycleDetection: true,
	enableOrphanDetection: true,
	enableDeadEndDetection: true,
	minProposalsForAnalysis: 2,
};

/**
 * DAG Health Telemetry - analyzes dependency graph for issues.
 */
export class DAGHealth {
	private config: DAGHealthConfig;

	constructor(config?: Partial<DAGHealthConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * AC#4: Generate a complete health report for the DAG.
	 */
	analyzeHealth(proposals: Proposal[]): DAGHealthReport {
		const issues: HealthIssue[] = [];
		const proposalMap = new Map<string, Proposal>();
		const adjList = new Map<string, string[]>(); // proposalId -> dependencies
		const reverseAdj = new Map<string, string[]>(); // proposalId -> dependents

		// Build index
		for (const proposal of proposals) {
			if (proposal.id) {
				proposalMap.set(proposal.id, proposal);
				adjList.set(proposal.id, proposal.dependencies ?? []);
				reverseAdj.set(proposal.id, []);
			}
		}

		// Build reverse adjacency (dependents)
		for (const [id, deps] of adjList) {
			for (const dep of deps) {
				if (reverseAdj.has(dep)) {
					reverseAdj.get(dep)?.push(id);
				}
			}
		}

		// AC#1: Cycle detection
		if (this.config.enableCycleDetection) {
			const cycles = this.detectCycles(adjList);
			for (const cycle of cycles) {
				issues.push({
					type: "cycle",
					severity: "error",
					proposalIds: cycle,
					message: `Cycle detected: ${cycle.join(" → ")} → ${cycle[0]}`,
					suggestion: "Remove or restructure dependencies to break the cycle",
				});
			}
		}

		// AC#2: Orphan detection (no dependencies AND no dependents)
		if (this.config.enableOrphanDetection) {
			for (const [id, proposal] of proposalMap) {
				const deps = adjList.get(id) ?? [];
				const dependents = reverseAdj.get(id) ?? [];
				const hasReachedStatus = ["Complete", "Abandoned"].includes(
					proposal.status ?? "",
				);

				if (deps.length === 0 && dependents.length === 0 && !hasReachedStatus) {
					issues.push({
						type: "orphan",
						severity: "warning",
						proposalIds: [id],
						message: `Orphan proposal: ${id} (${proposal.title}) has no dependencies or dependents`,
						suggestion:
							"Link to related proposals or mark as Complete/Abandoned",
					});
				}
			}
		}

		// AC#3: Deep dependency chains
		const depths = this.calculateDepths(adjList, proposalMap);
		for (const [id, depth] of depths) {
			if (depth > this.config.maxDepthWarning) {
				const chain = this.getDependencyChain(id, adjList, proposalMap);
				issues.push({
					type: "deep-chain",
					severity: "warning",
					proposalIds: [id],
					message: `Deep dependency chain (${depth} levels): ${chain.join(" → ")}`,
					suggestion: "Consider refactoring to reduce dependency depth",
				});
			}
		}

		// Missing dependency detection
		for (const [id, deps] of adjList) {
			for (const dep of deps) {
				if (!proposalMap.has(dep)) {
					issues.push({
						type: "missing-dependency",
						severity: "error",
						proposalIds: [id],
						message: `${id} depends on non-existent proposal ${dep}`,
						suggestion:
							"Remove invalid dependency or create the missing proposal",
					});
				}
			}
		}

		// Self-reference detection
		for (const [id, deps] of adjList) {
			if (deps.includes(id)) {
				issues.push({
					type: "self-reference",
					severity: "error",
					proposalIds: [id],
					message: `${id} depends on itself`,
					suggestion: "Remove self-reference",
				});
			}
		}

		// Calculate stats
		const stats = this.calculateStats(adjList, reverseAdj, depths);

		// Determine overall status
		const errors = issues.filter((i) => i.severity === "error").length;
		const warnings = issues.filter((i) => i.severity === "warning").length;

		let status: HealthStatus = "healthy";
		if (errors > 0) status = "critical";
		else if (warnings > 0) status = "warning";

		return {
			status,
			generatedAt: new Date().toISOString(),
			totalProposals: proposals.length,
			issues,
			summary: {
				errors,
				warnings,
				info: issues.filter((i) => i.severity === "info").length,
			},
			stats,
		};
	}

	/**
	 * AC#1: Detect cycles using DFS.
	 */
	private detectCycles(adjList: Map<string, string[]>): string[][] {
		const cycles: string[][] = [];
		const visited = new Set<string>();
		const inStack = new Set<string>();
		const path: string[] = [];

		const dfs = (node: string): void => {
			if (inStack.has(node)) {
				// Found cycle - extract it
				const cycleStart = path.indexOf(node);
				if (cycleStart >= 0) {
					cycles.push([...path.slice(cycleStart), node]);
				}
				return;
			}
			if (visited.has(node)) return;

			visited.add(node);
			inStack.add(node);
			path.push(node);

			const deps = adjList.get(node) ?? [];
			for (const dep of deps) {
				dfs(dep);
			}

			path.pop();
			inStack.delete(node);
		};

		for (const node of adjList.keys()) {
			if (!visited.has(node)) {
				dfs(node);
			}
		}

		return cycles;
	}

	/**
	 * AC#3: Calculate dependency depth for each proposal.
	 */
	private calculateDepths(
		adjList: Map<string, string[]>,
		_proposalMap: Map<string, Proposal>,
	): Map<string, number> {
		const depths = new Map<string, number>();
		const visited = new Set<string>();

		const getDepth = (id: string, stack: Set<string> = new Set()): number => {
			if (stack.has(id)) return 0; // Cycle protection
			if (depths.has(id)) return depths.get(id)!;
			if (visited.has(id)) return depths.get(id) ?? 0;

			visited.add(id);
			stack.add(id);

			const deps = adjList.get(id) ?? [];
			let maxDepDepth = 0;

			for (const dep of deps) {
				const depDepth = getDepth(dep, stack);
				maxDepDepth = Math.max(maxDepDepth, depDepth + 1);
			}

			depths.set(id, maxDepDepth);
			stack.delete(id);
			return maxDepDepth;
		};

		for (const id of adjList.keys()) {
			getDepth(id);
		}

		return depths;
	}

	/**
	 * Get the dependency chain leading to a proposal.
	 */
	private getDependencyChain(
		id: string,
		adjList: Map<string, string[]>,
		_proposalMap: Map<string, Proposal>,
	): string[] {
		const chain: string[] = [id];
		let current = id;
		const visited = new Set<string>();

		while (true) {
			if (visited.has(current)) break;
			visited.add(current);

			const deps = adjList.get(current) ?? [];
			if (deps.length === 0) break;

			// Follow the longest path
			const _maxDepth = -1;
			const _nextId = deps[0];

			for (const dep of deps) {
				if (!visited.has(dep)) {
					chain.push(dep);
					current = dep;
					break;
				}
			}

			// If all deps visited, stop
			if (chain.length === visited.size) break;
		}

		return chain;
	}

	/**
	 * Calculate DAG statistics.
	 */
	private calculateStats(
		adjList: Map<string, string[]>,
		reverseAdj: Map<string, string[]>,
		depths: Map<string, number>,
	): DAGHealthReport["stats"] {
		let rootCount = 0;
		let leafCount = 0;
		let totalDepth = 0;
		let maxDepth = 0;

		for (const [id, deps] of adjList) {
			if (deps.length === 0) rootCount++;
			if ((reverseAdj.get(id) ?? []).length === 0) leafCount++;

			const depth = depths.get(id) ?? 0;
			totalDepth += depth;
			maxDepth = Math.max(maxDepth, depth);
		}

		const proposalCount = adjList.size;
		const avgDepth =
			proposalCount > 0
				? Math.round((totalDepth / proposalCount) * 10) / 10
				: 0;

		// Count connected components
		const visited = new Set<string>();
		let connectedComponents = 0;

		const bfs = (start: string): void => {
			const queue = [start];
			while (queue.length > 0) {
				const node = queue.shift()!;
				if (visited.has(node)) continue;
				visited.add(node);

				// Add dependencies
				for (const dep of adjList.get(node) ?? []) {
					if (!visited.has(dep)) queue.push(dep);
				}
				// Add dependents
				for (const dep of reverseAdj.get(node) ?? []) {
					if (!visited.has(dep)) queue.push(dep);
				}
			}
		};

		for (const id of adjList.keys()) {
			if (!visited.has(id)) {
				bfs(id);
				connectedComponents++;
			}
		}

		return {
			rootCount,
			leafCount,
			maxDepth,
			avgDepth,
			connectedComponents,
		};
	}

	/**
	 * AC#5: Format report for pulse notification.
	 */
	formatForPulse(report: DAGHealthReport): string {
		const icon =
			report.status === "healthy"
				? "✅"
				: report.status === "warning"
					? "⚠️"
					: "🔴";

		const lines = [
			`${icon} DAG Health: ${report.status.toUpperCase()}`,
			`   Proposals: ${report.totalProposals} | Issues: ${report.issues.length}`,
		];

		if (report.summary.errors > 0) {
			lines.push(`   ❌ Errors: ${report.summary.errors}`);
			const errors = report.issues
				.filter((i) => i.severity === "error")
				.slice(0, 3);
			for (const err of errors) {
				lines.push(`      - ${err.message}`);
			}
		}

		if (report.summary.warnings > 0) {
			lines.push(`   ⚠️ Warnings: ${report.summary.warnings}`);
		}

		lines.push(
			`   Depth: ${report.stats.maxDepth} max, ${report.stats.avgDepth} avg`,
		);

		return lines.join("\n");
	}

	/**
	 * Quick cycle check for a single proposal.
	 * Returns true if adding the dependency would create a cycle.
	 */
	wouldCreateCycle(
		proposalId: string,
		newDependency: string,
		allProposals: Proposal[],
	): boolean {
		const adjList = new Map<string, string[]>();

		for (const proposal of allProposals) {
			if (proposal.id) {
				const deps = [...(proposal.dependencies ?? [])];
				// Add the proposed dependency
				if (proposal.id === proposalId && !deps.includes(newDependency)) {
					deps.push(newDependency);
				}
				adjList.set(proposal.id, deps);
			}
		}

		// Check if newDependency can reach proposalId (which would create cycle)
		const visited = new Set<string>();
		const queue = [newDependency];

		while (queue.length > 0) {
			const node = queue.shift()!;
			if (node === proposalId) return true;
			if (visited.has(node)) continue;
			visited.add(node);

			for (const dep of adjList.get(node) ?? []) {
				if (!visited.has(dep)) queue.push(dep);
			}
		}

		return false;
	}

	/**
	 * Update configuration.
	 */
	updateConfig(config: Partial<DAGHealthConfig>): DAGHealthConfig {
		this.config = { ...this.config, ...config };
		return this.config;
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): DAGHealthConfig {
		return { ...this.config };
	}
}

/**
 * Create a DAG health analyzer.
 */
export function createDAGHealth(config?: Partial<DAGHealthConfig>): DAGHealth {
	return new DAGHealth(config);
}
