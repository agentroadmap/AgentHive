const fs = require("node:fs");
const { execSync } = require("node:child_process");
const path = require("node:path");

const args = process.argv.slice(2);
const outfileIndex = args.indexOf("--outfile");
const outfile =
	outfileIndex !== -1 ? args[outfileIndex + 1] : "scripts/cli.cjs";
const outdir = path.dirname(outfile);
const bundleName = `${path.basename(outfile)}.js`;
const bundlePath = path.join(outdir, bundleName);
const bundleTmpPath = `${bundlePath}.tmp-${process.pid}`;
const outfileTmpPath = `${outfile}.tmp-${process.pid}`;

console.log(`Building ${outfile}...`);

function copyAsset(source, target) {
	fs.writeFileSync(target, fs.readFileSync(source), { mode: 0o664 });
}

try {
	fs.mkdirSync(path.join(outdir, "mcp"), { recursive: true });
	copyAsset(
		"src/apps/guidelines/agent-guidelines.md",
		path.join(outdir, "agent-guidelines.md"),
	);
	copyAsset(
		"src/apps/guidelines/project-manager-roadmap.md",
		path.join(outdir, "project-manager-roadmap.md"),
	);
	copyAsset(
		"src/apps/guidelines/mcp/agent-nudge.md",
		path.join(outdir, "mcp/agent-nudge.md"),
	);

	const mcpFiles = [
		"chat-skill.md",
		"init-required.md",
		"overview.md",
		"overview-tools.md",
		"proposal-creation.md",
		"proposal-execution.md",
		"proposal-finalization.md",
	];
	for (const file of mcpFiles) {
		copyAsset(
			path.join("src/apps/guidelines/mcp", file),
			path.join(outdir, file),
		);
	}
} catch (e) {
	console.error("Failed to copy assets:", e.message);
}

try {
	execSync(
		`bun build src/apps/cli.ts --target=node --outfile=${bundleTmpPath}`,
		{ stdio: "inherit" },
	);
	fs.renameSync(bundleTmpPath, bundlePath);
	const wrapper = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function defaultResolveBinary(platform, arch) {
  return path.join(__dirname, 'node_modules', \`agent-roadmap-\${platform}-\${arch}\`, 'roadmap');
}

function isInstalledBinaryPath(entryPath) {
  return /(?:^|[\\\\/])agent-roadmap-[^\\\\/]+[\\\\/].*roadmap(?:\\.exe)?$/.test(entryPath);
}

function resolveLaunchConfig(options = {}) {
  const {
    baseDir = __dirname,
    execPath = process.execPath,
    platform = process.platform,
    arch = process.arch,
    rawArgs = process.argv.slice(2),
    existsSync = fs.existsSync,
    resolveBinary = defaultResolveBinary,
  } = options;

  const sourcePath = path.join(baseDir, 'src', 'apps', 'cli.ts');
  const legacySourcePath = path.join(baseDir, 'src', 'cli.ts');
  const bundledBinaryPath = path.join(baseDir, 'dist', 'roadmap');
  const cleanedArgs = rawArgs.filter((arg) => {
    if (arg === sourcePath || arg === legacySourcePath || arg === bundledBinaryPath) {
      return false;
    }
    return !isInstalledBinaryPath(arg);
  });

  if (existsSync(sourcePath)) {
    return {
      command: execPath,
      launchArgs: [sourcePath],
      cleanedArgs,
    };
  }

  if (existsSync(legacySourcePath)) {
    return {
      command: execPath,
      launchArgs: [legacySourcePath],
      cleanedArgs,
    };
  }

  if (existsSync(bundledBinaryPath)) {
    return {
      command: bundledBinaryPath,
      launchArgs: [],
      cleanedArgs,
    };
  }

  const platformBinaryPath = resolveBinary(platform, arch);
  return {
    command: platformBinaryPath,
    launchArgs: [],
    cleanedArgs,
  };
}

module.exports.resolveLaunchConfig = resolveLaunchConfig;

if (require.main === module) {
  import('./${bundleName}').catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
`;
	fs.writeFileSync(outfileTmpPath, wrapper);
	fs.chmodSync(outfileTmpPath, 0o755);
	fs.renameSync(outfileTmpPath, outfile);
} catch (e) {
	try {
		if (fs.existsSync(bundleTmpPath)) fs.unlinkSync(bundleTmpPath);
		if (fs.existsSync(outfileTmpPath)) fs.unlinkSync(outfileTmpPath);
	} catch {}
	console.error("Build failed:", e.message);
	process.exit(1);
}
