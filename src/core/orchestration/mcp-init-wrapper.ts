/**
 * MCP Init Wrapper — P1730: isolate and instrument MCP connect/init with timeout
 *
 * Problem: concurrent spawns contend on MCP-sse-server's single port (127.0.0.1:6421/sse).
 * When 5+ children initialize MCP at the same time, the init phase can hang for 20+ minutes.
 *
 * Solution: wrap the child's MCP init in a separate timeout (60-90s) so that if MCP
 * cannot connect/authenticate within that window, the child fails fast instead of
 * blocking for the full task timeout (1.2M ms).
 *
 * This module provides:
 * 1. initMcpWithTimeout(): connect to MCP with instrumented timing + separate timeout
 * 2. mcpInitTimings: in-memory registry of init durations by worktree/run for diagnostics
 */

import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";

/**
 * Timing snapshot for a single MCP init attempt.
 * Records wall-clock durations for connect, auth, and first message.
 */
export interface McpInitTiming {
	runId: string; // agent_runs.id or diagnostic UUID
	worktree: string;
	startMs: number;
	connectMs?: number; // time to TCP connect to MCP server
	authMs?: number; // time from connect to auth complete
	firstMessageMs?: number; // time to first MCP tool response
	totalMs?: number; // total elapsed
	status: "pending" | "connected" | "authenticated" | "ready" | "timeout" | "error";
	errorMessage?: string;
}

/**
 * In-memory registry of MCP init timings for diagnostics.
 * Used to record baseline + max durations at different concurrency levels (cap=1 vs cap=5+).
 * Keyed by [worktree, timestamp] for easy GC.
 */
const mcpInitTimings = new Map<string, McpInitTiming>();

export function recordMcpInitTiming(timing: McpInitTiming): void {
	const key = `${timing.worktree}:${timing.runId}`;
	mcpInitTimings.set(key, timing);
}

export function getMcpInitTimings(): McpInitTiming[] {
	return Array.from(mcpInitTimings.values());
}

export function clearMcpInitTimings(): void {
	mcpInitTimings.clear();
}

/**
 * Get diagnostic summary of MCP init performance at a specific concurrency cap.
 * Returns baseline (min) and max durations so AC-1 can compare cap=1 vs cap=5+.
 */
export function getMcpInitDiagnostics(capLevel?: number): {
	cap?: number;
	sampleCount: number;
	baselineMs: number | null;
	maxMs: number | null;
	avgMs: number | null;
	samples: McpInitTiming[];
} {
	const samples = Array.from(mcpInitTimings.values());
	const durations = samples
		.map((s) => s.totalMs)
		.filter((d) => d !== undefined) as number[];

	return {
		cap: capLevel,
		sampleCount: samples.length,
		baselineMs: durations.length > 0 ? Math.min(...durations) : null,
		maxMs: durations.length > 0 ? Math.max(...durations) : null,
		avgMs:
			durations.length > 0
				? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
				: null,
		samples,
	};
}

/**
 * Wrap a spawned child's stdin with an MCP init timeout guard.
 *
 * When the child connects to MCP, this monitors the connection handshake and fails
 * the child if the init phase doesn't complete within AGENTHIVE_MCP_CONNECT_TIMEOUT_MS.
 *
 * The child emits log lines (to stderr) that mark milestones:
 *   [mcp-init] connect start
 *   [mcp-init] connect complete
 *   [mcp-init] auth start
 *   [mcp-init] auth complete
 *   [mcp-init] ready
 *
 * This function parses those lines and kills the child if no "ready" is seen
 * within the timeout window.
 *
 * @param child - the spawned child process
 * @param runId - agent_runs.id for diagnostics
 * @param worktree - worktree name for diagnostics
 * @param timeoutMs - MCP connect timeout in milliseconds (default 90000)
 * @returns cleanup function to cancel the timeout (if init succeeds before timeout)
 */
export function wrapMcpInitTimeout(
	child: ChildProcess,
	runId: string,
	worktree: string,
	timeoutMs: number = Number(
		process.env.AGENTHIVE_MCP_CONNECT_TIMEOUT_MS ?? "90000",
	),
): () => void {
	const timing: McpInitTiming = {
		runId,
		worktree,
		startMs: Date.now(),
		status: "pending",
	};

	let timeoutHandle: NodeJS.Timeout | null = null;
	let cleaned = false;

	// Listen to stderr for MCP init milestone markers
	const onStderr = (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			if (line.includes("[mcp-init] connect start")) {
				timing.status = "connected";
			} else if (line.includes("[mcp-init] auth complete")) {
				timing.status = "authenticated";
			} else if (line.includes("[mcp-init] ready")) {
				timing.status = "ready";
				timing.totalMs = Date.now() - timing.startMs;
				recordMcpInitTiming(timing);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				cleanup();
			}
		}
	};

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (child.stderr) {
			child.stderr.removeListener("data", onStderr);
		}
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	};

	// Attach stderr listener
	if (child.stderr) {
		child.stderr.on("data", onStderr);
	}

	// Set timeout: if MCP init doesn't complete within timeoutMs, kill the child
	timeoutHandle = setTimeout(() => {
		if (cleaned) return;
		timing.status = "timeout";
		timing.totalMs = Date.now() - timing.startMs;
		timing.errorMessage = `MCP init timeout after ${timeoutMs}ms in status '${timing.status}'`;
		recordMcpInitTiming(timing);

		console.error(
			`[mcp-init-wrapper] MCP init timeout for ${worktree} (run=${runId}): ` +
				`status=${timing.status}, elapsed=${timing.totalMs}ms, timeout=${timeoutMs}ms`,
		);

		// Kill the child with SIGTERM; escalation to SIGKILL happens in runProcess.
		try {
			if (child.exitCode === null) {
				child.kill("SIGTERM");
			}
		} catch (err) {
			console.error(
				`[mcp-init-wrapper] failed to kill child for MCP timeout:`,
				err,
			);
		}

		cleanup();
	}, timeoutMs);

	// Return cleanup function so caller can cancel timeout if init succeeds early
	return cleanup;
}

/**
 * AC-1 diagnosis: write a report of MCP init performance across cap levels.
 * Used by developers/operators to understand whether init contention is the bottleneck.
 */
export function getMcpInitDiagnosisReport(): string {
	const diagnostics = getMcpInitDiagnostics();

	const lines = [
		"## P1730 AC-1 Diagnosis: MCP Init Timing Report",
		``,
		`Collected ${diagnostics.sampleCount} MCP init samples.`,
		``,
	];

	if (diagnostics.sampleCount === 0) {
		lines.push(`No samples collected yet. Run agents under load and retry.`);
		return lines.join("\n");
	}

	lines.push(
		`Baseline (min): ${diagnostics.baselineMs}ms`,
		`Maximum: ${diagnostics.maxMs}ms`,
		`Average: ${diagnostics.avgMs}ms`,
		``,
	);

	// Group by status to show distribution
	const byStatus = new Map<string, McpInitTiming[]>();
	for (const sample of diagnostics.samples) {
		if (!byStatus.has(sample.status)) {
			byStatus.set(sample.status, []);
		}
		byStatus.get(sample.status)!.push(sample);
	}

	lines.push(`Distribution by status:`);
	for (const [status, samples] of byStatus) {
		const pct = Math.round(
			(samples.length / diagnostics.sampleCount) * 100,
		);
		lines.push(
			`  ${status}: ${samples.length} (${pct}%) — ` +
				`max ${Math.max(...samples.map((s) => s.totalMs || 0))}ms`,
		);
	}

	lines.push(``, `Next steps:`);
	lines.push(`- If max > 60s, MCP init contention confirmed → proceed to AC-4`);
	lines.push(
		`- If max < 10s, init is not the bottleneck → investigate shared resources (DB pool, OAuth tokens)`,
	);

	return lines.join("\n");
}
