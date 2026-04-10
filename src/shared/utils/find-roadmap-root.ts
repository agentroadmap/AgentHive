import { execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Check if a path exists and is a directory
 */
async function isDirectory(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

/**
 * Finds the roadmap workspace root by walking up the directory tree.
 *
 * Search order:
 * 1. Walk up from startDir looking for `roadmap/` directory or `roadmap.json` file
 * 2. If not found, fall back to git repository root (via `git rev-parse --show-toplevel`)
 * 3. Return null if no roadmap workspace is found
 *
 * @param startDir - The directory to start searching from (typically process.cwd())
 * @returns The project root path, or null if no roadmap workspace is found
 */
export async function findRoadmapRoot(
	startDir: string,
): Promise<string | null> {
	let current = startDir;

	// Walk up the directory tree looking for roadmap/ or roadmap.json
	while (current !== dirname(current)) {
		// Check for roadmap/ directory
		const roadmapDir = join(current, "roadmap");
		if (await isDirectory(roadmapDir)) {
			return current;
		}

		// Check for roadmap.json file
		const roadmapJson = join(current, "roadmap.json");
		if (await fileExists(roadmapJson)) {
			return current;
		}

		current = dirname(current);
	}

	// Fallback: try git repository root
	try {
		const gitRoot = execSync("git rev-parse --show-toplevel", {
			cwd: startDir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();

		if (gitRoot) {
			// Verify the git root has a roadmap setup
			const roadmapDir = join(gitRoot, "roadmap");
			const roadmapJson = join(gitRoot, "roadmap.json");

			if ((await isDirectory(roadmapDir)) || (await fileExists(roadmapJson))) {
				return gitRoot;
			}
		}
	} catch {
		// Not in a git repository or git not available
	}

	return null;
}

// Cache for the project root within a single CLI execution
let cachedProjectRoot: string | null | undefined;

/**
 * Gets the roadmap workspace root, with caching for performance.
 * Call clearProjectRootCache() to reset the cache if needed.
 */
export async function getProjectRoot(startDir: string): Promise<string | null> {
	if (cachedProjectRoot !== undefined) {
		return cachedProjectRoot;
	}

	cachedProjectRoot = await findRoadmapRoot(startDir);
	return cachedProjectRoot;
}

/**
 * Clears the cached project root. Useful for testing.
 */
export function clearProjectRootCache(): void {
	cachedProjectRoot = undefined;
}
