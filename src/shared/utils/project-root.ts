import { getProjectRoot } from "./find-roadmap-root.ts";

export async function requireProjectRoot(): Promise<string> {
	const root = await getProjectRoot(process.cwd());
	if (!root) {
		throw new Error("Not inside a roadmap project directory");
	}
	return root;
}

export { findRoadmapRoot, getProjectRoot } from "./find-roadmap-root.ts";
