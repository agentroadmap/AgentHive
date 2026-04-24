const fs = require("node:fs");
const { execSync } = require("node:child_process");
const path = require("node:path");

const outfile = "scripts/agenthive.cjs";
const outdir = path.dirname(outfile);
const bundleName = `${path.basename(outfile)}.js`;
const bundlePath = path.join(outdir, bundleName);
const bundleTmpPath = `${bundlePath}.tmp-${process.pid}`;
const outfileTmpPath = `${outfile}.tmp-${process.pid}`;

console.log(`Building ${outfile}...`);

try {
	execSync(
		`bun build src/apps/agenthive-cli.ts --target=node --outfile=${bundleTmpPath}`,
		{ stdio: "inherit" },
	);
	fs.renameSync(bundleTmpPath, bundlePath);
	const wrapper = `#!/usr/bin/env node
import('./${bundleName}').catch((err) => {
  console.error(err);
  process.exit(1);
});
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
