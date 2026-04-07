import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * simple advisory file-based lock to coordinate atomic operations across processes.
 * Uses 'wx' flag for atomic file creation.
 */
export class FileLock {
	private lockPath: string;

	constructor(projectRoot: string, lockName: string) {
		// Store locks in the shared roadmap cache directory
		this.lockPath = join(projectRoot, "roadmap", ".cache", `${lockName}.lock`);
	}

	/**
	 * Acquire the lock. Retries for a duration before giving up.
	 * @param timeoutMs Maximum time to wait for the lock
	 * @param retryIntervalMs Time between retries
	 */
	async acquire(timeoutMs = 5000, retryIntervalMs = 100): Promise<boolean> {
		const startTime = Date.now();

		// Ensure the directory exists
		await mkdir(join(this.lockPath, ".."), { recursive: true });

		while (Date.now() - startTime < timeoutMs) {
			try {
				// 'wx' flag: open for writing, fails if file exists (atomic)
				const handle = await open(this.lockPath, "wx");

				// Write current PID to the lock file for debugging
				await handle.writeFile(process.pid.toString());
				await handle.close();

				return true;
			} catch (error: any) {
				if (error.code === "EEXIST") {
					// Lock exists, check if it's stale (10 seconds)
					if (await this.isStale(10000)) {
						await this.release();
						continue; // Try again immediately
					}
					// Wait and retry
					await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
				} else {
					throw error;
				}
			}
		}

		return false;
	}

	/**
	 * Release the lock.
	 */
	async release(): Promise<void> {
		try {
			await rm(this.lockPath, { force: true });
		} catch (_error) {
			// Ignore if already gone
		}
	}

	/**
	 * Simple staleness check based on mtime.
	 */
	private async isStale(maxAgeMs: number): Promise<boolean> {
		try {
			const s = await stat(this.lockPath);
			const age = Date.now() - s.mtimeMs;
			return age > maxAgeMs;
		} catch {
			return false;
		}
	}

	/**
	 * Executes a function within the protection of the lock.
	 */
	static async withLock<T>(
		projectRoot: string,
		lockName: string,
		fn: () => Promise<T>,
		options?: { timeoutMs?: number },
	): Promise<T> {
		const lock = new FileLock(projectRoot, lockName);
		const acquired = await lock.acquire(options?.timeoutMs);

		if (!acquired) {
			throw new Error(
				`Failed to acquire lock: ${lockName} after ${options?.timeoutMs || 5000}ms`,
			);
		}

		try {
			return await fn();
		} finally {
			await lock.release();
		}
	}
}
