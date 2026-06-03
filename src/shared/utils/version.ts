import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These will be replaced at build time for compiled executables when available
declare const __EMBEDDED_VERSION__: string | undefined;
declare const __EMBEDDED_REVISION__: string | undefined;

export interface VersionInfo {
	version: string;
	revision: string | null;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// Repo root is three levels up from src/shared/utils/. Old code went two levels
// and pointed at src/package.json (does not exist) which made every fallback hit
// "0.0.0" — see P1614.
const PACKAGE_ROOT = join(MODULE_DIR, "..", "..", "..");
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json");

async function readVersionFrom(path: string): Promise<string | null> {
	try {
		const content = await readFile(path, "utf-8");
		const packageJson = JSON.parse(content);
		const v = packageJson?.version;
		return typeof v === "string" && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}

/**
 * Get the version from package.json or embedded version
 * @returns The version string from package.json or embedded at build time
 */
export async function getVersion(): Promise<string> {
	// If this is a compiled executable with embedded version, use that
	if (typeof __EMBEDDED_VERSION__ !== "undefined") {
		return String(__EMBEDDED_VERSION__);
	}

	// Try the dev-time path (three levels up from src/shared/utils).
	const dev = await readVersionFrom(PACKAGE_JSON_PATH);
	if (dev) return dev;

	// Fallback to CWD-relative — covers builds running from a directory that
	// contains a package.json (e.g. the deployed server on bot at /data/code/AgentHive).
	const cwd = await readVersionFrom(join(process.cwd(), "package.json"));
	if (cwd) return cwd;

	return "0.0.0";
}

/**
 * Get the current revision (short git SHA) when available.
 */
export async function getRevision(): Promise<string | null> {
	if (typeof __EMBEDDED_REVISION__ !== "undefined") {
		const revision = String(__EMBEDDED_REVISION__).trim();
		return revision.length > 0 ? revision : null;
	}

	try {
		const revision = execSync(
			`git -C "${PACKAGE_ROOT}" rev-parse --short HEAD`,
			{
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf-8",
				timeout: 1000,
			},
		).trim();
		return revision.length > 0 ? revision : null;
	} catch {
		return null;
	}
}

export async function getVersionInfo(): Promise<VersionInfo> {
	const [version, revision] = await Promise.all([getVersion(), getRevision()]);
	return { version, revision };
}

export function formatVersionLabel(info: VersionInfo): string {
	if (info.revision) {
		return `v${info.version} • rev ${info.revision}`;
	}
	return `v${info.version}`;
}
