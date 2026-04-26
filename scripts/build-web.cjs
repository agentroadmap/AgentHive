#!/usr/bin/env node
/*
 * P477 AC-6: Reliable browser build pipeline.
 *
 * Builds the dashboard-web bundle into src/web/ in a single shot:
 *   - Forces CWD to the repo root (so wouter + react resolve to ONE
 *     node_modules tree — running from a worktree pulled wouter through
 *     a symlink and produced two React copies, breaking useContext at
 *     runtime).
 *   - Refreshes tailwind into src/apps/dashboard-web/styles/style.css.
 *   - Runs `bun build src/web/main.tsx --outdir=src/web` and verifies the
 *     produced bundle is single-React.
 *   - Atomically swaps the new main.js + main.css over the served files
 *     so partially-written bundles never reach the browser.
 *
 * Usage:
 *   npm run build:web        # full css + js
 *   npm run build:web -- --js-only
 *   npm run build:web -- --watch (uses bun --watch for js only)
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const jsOnly = args.has("--js-only");

function fail(msg) {
	console.error(`[build-web] ${msg}`);
	process.exit(1);
}

function which(cmd) {
	try {
		return execFileSync("which", [cmd], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

const bun = which("bun") || "bun";
if (!bun) fail("bun not found in PATH (required for the dashboard-web bundle)");

if (process.cwd() !== repoRoot) {
	process.chdir(repoRoot);
	console.log(`[build-web] cwd → ${repoRoot}`);
}

if (!jsOnly) {
	console.log("[build-web] building tailwind css …");
	execFileSync(
		path.join(repoRoot, "node_modules/@tailwindcss/cli/dist/index.mjs"),
		[
			"-i",
			"src/apps/dashboard-web/styles/source.css",
			"-o",
			"src/apps/dashboard-web/styles/style.css",
			"--minify",
		],
		{ stdio: "inherit" },
	);
}

const entry = "src/web/main.tsx";
const outDir = "src/web";
const stagingDir = path.join(repoRoot, ".build-web-staging");

if (watch) {
	console.log("[build-web] starting bun --watch (Ctrl+C to stop) …");
	const child = spawn(
		bun,
		["build", entry, "--outdir", outDir, "--watch"],
		{ stdio: "inherit", cwd: repoRoot },
	);
	child.on("exit", (code) => process.exit(code ?? 0));
	return;
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

console.log("[build-web] bundling dashboard-web …");
execFileSync(bun, ["build", entry, "--outdir", stagingDir], {
	stdio: "inherit",
	cwd: repoRoot,
});

const stagedJs = path.join(stagingDir, "main.js");
const stagedCss = path.join(stagingDir, "main.css");
if (!fs.existsSync(stagedJs)) fail("bundle did not produce main.js");

const bundleSrc = fs.readFileSync(stagedJs, "utf8");
const dualReact = bundleSrc.match(/AgentHive\/node_modules\/react\b/g);
if (dualReact && dualReact.length > 0) {
	fail(
		"dual-React detected in bundle — refusing to deploy. " +
			`Found ${dualReact.length} reference(s) to AgentHive/node_modules/react. ` +
			"This means a worktree symlink pulled in a second React copy. " +
			"Run from /data/code/AgentHive (the repo root) with a clean node_modules.",
	);
}

const stat = fs.statSync(stagedJs);
const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
console.log(`[build-web] bundle ok: ${sizeMB} MB, single React`);

const finalJs = path.join(repoRoot, outDir, "main.js");
const finalCss = path.join(repoRoot, outDir, "main.css");

fs.renameSync(stagedJs, finalJs);
if (fs.existsSync(stagedCss)) fs.renameSync(stagedCss, finalCss);
fs.rmSync(stagingDir, { recursive: true, force: true });

console.log(`[build-web] deployed → ${finalJs}`);
if (fs.existsSync(finalCss)) console.log(`[build-web] deployed → ${finalCss}`);
