/**
 * STATE-58: Docs CLI Command
 *
 * Command for generating and serving documentation from roadmap proposal.
 * Enhanced for STATE-58.1: Full proposal detail pages and GitHub Pages deployment.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DocGeneratorOptions } from "../../core/infrastructure/doc-generator.ts";
import {
	generateDocs,
	generateGitHubPagesWorkflow,
	watchAndRegenerate,
} from "../../core/infrastructure/doc-generator.ts";

export interface DocsCommandOptions {
	output?: string;
	includeDAG?: boolean;
	noDAG?: boolean;
	includeChangelog?: boolean;
	noChangelog?: boolean;
	format?: "markdown" | "html";
	watch?: boolean;
	serve?: boolean;
	port?: number;
	workflow?: boolean;
	full?: boolean; // STATE-58.1: Generate full per-proposal detail pages
	incremental?: boolean; // STATE-58.1: Only regenerate changed proposals
}

/**
 * Run the docs command
 */
export async function runDocsCommand(
	projectRoot: string,
	args: string[],
): Promise<void> {
	const subcommand = args[0] || "generate";

	const options: DocGeneratorOptions = {
		outputDir: "docs",
		includeDAG: true,
		includeChangelog: true,
		format: "markdown",
	};

	// Parse options
	for (let i = 1; i < args.length; i++) {
		switch (args[i]) {
			case "--output":
			case "-o":
				options.outputDir = args[++i] || "docs";
				break;
			case "--no-dag":
				options.includeDAG = false;
				break;
			case "--dag":
				options.includeDAG = true;
				break;
			case "--no-changelog":
				options.includeChangelog = false;
				break;
			case "--format":
			case "-f":
				options.format = (args[++i] as "markdown" | "html") || "markdown";
				break;
			// STATE-58.1: Full detail mode and incremental generation
			case "--full":
				options.fullDetail = true;
				break;
			case "--no-full":
				options.fullDetail = false;
				break;
			case "--incremental":
				options.incremental = true;
				break;
		}
	}

	switch (subcommand) {
		case "generate":
		case "gen":
			await handleGenerate(projectRoot, options, args.includes("--workflow"));
			break;

		case "watch":
			await handleWatch(projectRoot, options);
			break;

		case "serve":
			await handleServe(projectRoot, options, parsePort(args));
			break;

		case "init-workflow":
		case "workflow":
			await handleGenerateWorkflow(projectRoot);
			break;

		default:
			console.log(`Unknown docs subcommand: ${subcommand}`);
			console.log("Available: generate, watch, serve, init-workflow");
			process.exit(1);
	}
}

async function handleGenerate(
	projectRoot: string,
	options: DocGeneratorOptions,
	generateWorkflow = false,
): Promise<void> {
	console.log("📚 Generating documentation...");

	const result = await generateDocs(projectRoot, options);

	if (result.success) {
		console.log(`\n✅ Documentation generated successfully!`);
		console.log(`\nGenerated ${result.files.length} files:`);
		for (const file of result.files) {
			console.log(`  - ${file.path} (${formatBytes(file.size)})`);
		}
		console.log(`\nOutput directory: ${options.outputDir}`);

		// STATE-58.1: Optionally generate GitHub workflow
		if (generateWorkflow) {
			await handleGenerateWorkflow(projectRoot);
		}
	} else {
		console.error("❌ Documentation generation failed:");
		for (const error of result.errors) {
			console.error(`  - ${error}`);
		}
		process.exit(1);
	}
}

async function handleGenerateWorkflow(projectRoot: string): Promise<void> {
	console.log("\n🔧 Generating GitHub Pages workflow...");

	const workflow = generateGitHubPagesWorkflow();
	const workflowPath = resolve(projectRoot, workflow.path);
	const workflowDir = resolve(projectRoot, ".github/workflows");

	if (!existsSync(workflowDir)) {
		mkdirSync(workflowDir, { recursive: true });
	}

	writeFileSync(workflowPath, workflow.content, "utf-8");
	console.log(`✅ Workflow created at: ${workflowPath}`);
	console.log("\nTo enable GitHub Pages:");
	console.log("1. Go to your repo Settings > Pages");
	console.log("2. Set source to 'GitHub Actions'");
	console.log("3. Push to main to trigger deployment");
}

async function handleWatch(
	projectRoot: string,
	options: DocGeneratorOptions,
): Promise<void> {
	console.log("👀 Watching for changes...");
	console.log("Press Ctrl+C to stop\n");

	const cleanup = await watchAndRegenerate(projectRoot, options, (result) => {
		if (result.success) {
			console.log(
				`[${new Date().toLocaleTimeString()}] ✅ Documentation regenerated (${result.files.length} files)`,
			);
		} else {
			console.error(
				`[${new Date().toLocaleTimeString()}] ❌ Regeneration failed`,
			);
		}
	});

	// Handle cleanup on exit
	process.on("SIGINT", () => {
		cleanup();
		console.log("\n👋 Watch stopped");
		process.exit(0);
	});

	// Keep process alive
	await new Promise(() => {});
}

async function handleServe(
	projectRoot: string,
	options: DocGeneratorOptions,
	port: number,
): Promise<void> {
	// First generate
	await handleGenerate(projectRoot, options);

	// Then start a simple HTTP server
	const http = await import("node:http");
	const fs = await import("node:fs");
	const path = await import("node:path");

	const outputDir = resolve(projectRoot, options.outputDir);

	const server = http.createServer((req, res) => {
		let filePath = req.url === "/" ? "/README.md" : req.url || "";
		filePath = path.join(outputDir, filePath);

		if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			const content = fs.readFileSync(filePath, "utf-8");
			const ext = path.extname(filePath);
			const contentType = ext === ".md" ? "text/markdown" : "text/plain";
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	});

	server.listen(port, () => {
		console.log(
			`\n🌐 Documentation server running at http://localhost:${port}`,
		);
		console.log("Press Ctrl+C to stop");
	});

	process.on("SIGINT", () => {
		server.close();
		console.log("\n👋 Server stopped");
		process.exit(0);
	});
}

function parsePort(args: string[]): number {
	const portIndex = args.indexOf("--port");
	if (portIndex >= 0 && args[portIndex + 1]) {
		return Number.parseInt(args[portIndex + 1], 10) || 3000;
	}
	return 3000;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
