/**
 * Graceful-exit failsafe (P3198).
 *
 * Long-running AgentHive services (orchestrator, a2a-host, agency, mcp) drain
 * cleanly on SIGTERM but the Node event loop can stay alive afterwards because a
 * shared handle was never released — most commonly an un-`unref`'d pool watchdog
 * interval or a pg LISTEN client whose socket is still open. systemd then kills
 * the unit with `Failed with result 'timeout'`, wedging the restart job and any
 * units queued behind it.
 *
 * This module gives every entrypoint the same two tools that already lived,
 * copy-pasted, inside scripts/start-agency.ts:
 *
 *   - `armHardExit(label, ms)` — schedule an unref'd failsafe timer. If the
 *     graceful path has not already called `process.exit()` within `ms`, dump
 *     the handles still holding the loop open (AC-1 diagnostic) and force-exit 0.
 *     Because the timer is `unref`'d it never *delays* a clean exit — it only
 *     fires when something else is keeping the loop alive.
 *
 *   - `dumpActiveHandles(label)` — best-effort snapshot of the resources still
 *     pinning the event loop, for diagnosing which holder leaked.
 *
 * The graceful path should still run to completion and call `process.exit(0)`
 * itself; the failsafe is purely a backstop for a drain step that hangs.
 */

interface HardExitHandle {
	/** Cancel the failsafe (call once a clean exit is imminent, optional). */
	cancel(): void;
}

/**
 * Summarise the handles/resources still keeping the event loop alive. Uses the
 * undocumented `process._getActiveHandles` / `process._getActiveResources` —
 * guarded so a runtime that lacks them (or changes the shape) cannot throw on
 * the shutdown path.
 */
export function dumpActiveHandles(label: string): void {
	try {
		const counts = new Map<string, number>();
		const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);

		const proc = process as unknown as {
			_getActiveHandles?: () => unknown[];
			_getActiveRequests?: () => unknown[];
		};
		for (const h of proc._getActiveHandles?.() ?? []) {
			add(
				(h as { constructor?: { name?: string } })?.constructor?.name ??
					"unknown",
			);
		}
		for (const r of proc._getActiveRequests?.() ?? []) {
			add(
				`req:${(r as { constructor?: { name?: string } })?.constructor?.name ?? "unknown"}`,
			);
		}

		const summary = [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, n]) => `${name}=${n}`)
			.join(", ");
		console.warn(
			`[${label}] active handles after drain: ${summary || "(none reported)"}`,
		);
	} catch (err) {
		console.warn(
			`[${label}] active-handle dump failed: ${err instanceof Error ? err.message : err}`,
		);
	}
}

/**
 * Arm an `unref`'d failsafe that force-exits the process if the graceful
 * shutdown path has not already exited within `timeoutMs`.
 *
 * @param label   log prefix, e.g. "orchestrator-shim"
 * @param timeoutMs grace budget before forcing exit (default 8s — under the
 *                  typical systemd `TimeoutStopSec` so we beat the SIGKILL).
 */
export function armHardExit(label: string, timeoutMs = 8_000): HardExitHandle {
	const timer = setTimeout(() => {
		dumpActiveHandles(label);
		console.warn(
			`[${label}] graceful stop exceeded ${timeoutMs}ms — forcing exit`,
		);
		process.exit(0);
	}, timeoutMs);
	// Do not let the failsafe itself keep the loop alive; it still fires while
	// other handles hold the loop open, which is exactly the case we guard.
	timer.unref();
	return {
		cancel() {
			clearTimeout(timer);
		},
	};
}
