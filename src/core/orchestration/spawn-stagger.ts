/**
 * Spawn Stagger — P1730 AC-4: Mitigate MCP-init thundering herd
 *
 * Problem: when 5+ concurrent spawns start at the same time, all children
 * attempt to initialize MCP to 127.0.0.1:6421/sse simultaneously. The
 * contention causes hangs in futex/accept, leading to 20-min livelock timeouts.
 *
 * Solution: stagger spawn START times (not just MCP init) to spread the herd
 * across a configurable window. Each worktree/agency gets a small random jitter,
 * so a batch of 5 claims doesn't hammer MCP at the exact same microsecond.
 *
 * This is called from spawnAgent (high-level) or runSpawn (low-level) to inject
 * a small delay before the subprocess is forked. The delay is:
 *   - Zero when only 1 spawn is in flight (no herd)
 *   - Jittered within [0, AGENTHIVE_SPAWN_JITTER_MS] when multiple spawns are active
 *   - Spread across the tick window via per-spawn counter (spawn N gets delay N*stagger_base)
 */

/**
 * Global in-flight spawn counter (per generation). Incremented when a spawn starts
 * waiting, decremented when it exits the stagger window.
 *
 * Generations are time-based (1-second buckets in production), but tests override
 * with virtual generations to ensure isolation. _resetSpawnStaggerForTest() increments
 * the virtual generation to start a fresh counter.
 */
let lastTimeSecond = Math.floor(Date.now() / 1000);
let virtualGeneration = 0; // Only incremented by test reset
let isTestMode = false;
const inFlightSpawns = new Map<number, number>();

function getGeneration(): number {
	if (isTestMode) {
		return virtualGeneration;
	}
	// Production: use time-based generation (1-second buckets)
	const now = Math.floor(Date.now() / 1000);
	if (now > lastTimeSecond) {
		lastTimeSecond = now;
		// Cleanup old entries (keep current + 1 prior generation)
		for (const key of inFlightSpawns.keys()) {
			if (key < now - 1) {
				inFlightSpawns.delete(key);
			}
		}
	}
	return now;
}

function getInFlightCount(): number {
	const gen = getGeneration();
	return inFlightSpawns.get(gen) ?? 0;
}

function incrementInFlightCount(): number {
	const gen = getGeneration();
	const count = (inFlightSpawns.get(gen) ?? 0) + 1;
	inFlightSpawns.set(gen, count);
	return count;
}

export interface SpawnStaggerConfig {
	/** Base stagger interval in milliseconds (e.g., 1500). Default: env var or 1500. */
	staggerMs?: number;
	/** Max jitter per spawn in milliseconds (e.g., 500). Default: env var or 500. */
	jitterMs?: number;
}

/**
 * Apply a small delay before spawning to stagger concurrent starts.
 *
 * Called from spawnAgent() to inject a small wait before forking the CLI subprocess.
 * The delay is proportional to how many other spawns are in-flight, plus random jitter.
 *
 * Design:
 *   - If in-flight count is 0 or 1: delay = 0 (no herd, no stagger)
 *   - If in-flight count is N >= 2: delay = N * staggerMs + random(0, jitterMs)
 *   - Caps at a reasonable max (e.g., 30s) to avoid starving long queues
 *
 * The delay is transparent to the caller; this function just sleeps and returns.
 * No API signature changes needed — the spawn is still fire-and-forget, just
 * with a brief delay baked in.
 *
 * @param config - optional override for staggerMs/jitterMs
 * @returns a promise that resolves when the stagger delay has elapsed
 */
export async function applySpawnStagger(
	config: SpawnStaggerConfig = {},
): Promise<void> {
	const staggerMs = config.staggerMs ??
		Number(process.env.AGENTHIVE_SPAWN_STAGGER_MS ?? 1500);
	const jitterMs = config.jitterMs ??
		Number(process.env.AGENTHIVE_SPAWN_JITTER_MS ?? 500);

	// Increment counter and get this spawn's sequence number
	const spawnSequence = incrementInFlightCount();

	// No stagger for first two spawns (no herd); stagger starts from the 3rd spawn
	if (spawnSequence <= 2) {
		return;
	}

	// Delay = (spawn_number - 2) * stagger_base + random jitter
	// Spawn 3 gets (3-2)*base = 1*base, spawn 4 gets 2*base, etc.
	const baseDelay = (spawnSequence - 2) * staggerMs;
	const jitterDelay = Math.floor(Math.random() * jitterMs);
	const totalDelay = baseDelay + jitterDelay;

	// Cap at 30 seconds to avoid excessive delays for large queues
	const cappedDelay = Math.min(totalDelay, 30_000);

	if (cappedDelay > 0) {
		await new Promise((resolve) => setTimeout(resolve, cappedDelay));
	}
}

/**
 * Get diagnostics on the current in-flight spawn count (for testing/debugging).
 *
 * @internal — used by tests and diagnostics
 */
export function getSpawnStaggerDiagnostics(): {
	inFlightCount: number;
	generation: number;
} {
	return {
		inFlightCount: getInFlightCount(),
		generation: getGeneration(),
	};
}

/** @internal — reset for tests. Clears all in-flight data and increments virtual generation. */
export function _resetSpawnStaggerForTest(): void {
	isTestMode = true;
	virtualGeneration++;
	inFlightSpawns.clear();
}
