/**
 * Hard-exit failsafe for long-running services.
 *
 * Registers a backup SIGTERM listener that force-exits the process if the
 * primary graceful handler has not called process.exit() within `timeoutMs`.
 * Prevents indefinitely-hanging shutdowns (e.g. HTTP server.close() waiting
 * for long-lived SSE connections to drain while systemd already sent SIGTERM).
 *
 * Call AFTER registering your graceful SIGTERM handler so the timer starts
 * only when SIGTERM actually arrives. The 10 000 ms default matches the
 * SIGTERM e2e test exit budget.
 */
export function armHardExit(name: string, timeoutMs = 10_000): void {
	process.on("SIGTERM", () => {
		setTimeout(() => {
			process.stderr.write(
				`[${name}] SIGTERM hard-exit: graceful shutdown timed out after ${timeoutMs}ms\n`,
			);
			process.exit(1);
		}, timeoutMs);
	});
}
