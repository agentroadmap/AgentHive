import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { resolveLaunchConfig } = require("../../scripts/cli.cjs");

describe("CLI wrapper launch config", () => {
	it("prefers the local TypeScript source when available", () => {
		const result = resolveLaunchConfig({
			baseDir: "/repo",
			execPath: "/usr/bin/node",
			platform: "linux",
			rawArgs: ["--version", "/repo/dist/roadmap"],
			existsSync: (entryPath: string) =>
				entryPath === "/repo/src/apps/cli.ts" ||
				entryPath === "/repo/dist/roadmap",
			resolveBinary: () => {
				throw new Error("should not resolve platform binary");
			},
		});

		assert.strictEqual(result.command, "/usr/bin/node");
		assert.deepStrictEqual(result.launchArgs, ["/repo/src/apps/cli.ts"]);
		assert.deepStrictEqual(result.cleanedArgs, ["--version"]);
	});

	it("uses the bundled binary when source is unavailable", () => {
		const result = resolveLaunchConfig({
			baseDir: "/repo",
			execPath: "/usr/bin/node",
			platform: "linux",
			rawArgs: ["proposal", "list", "--plain"],
			existsSync: (entryPath: string) => entryPath === "/repo/dist/roadmap",
			resolveBinary: () => {
				throw new Error("should not resolve platform binary");
			},
		});

		assert.strictEqual(result.command, "/repo/dist/roadmap");
		assert.deepStrictEqual(result.launchArgs, []);
		assert.deepStrictEqual(result.cleanedArgs, ["proposal", "list", "--plain"]);
	});

	it("falls back to the platform binary when neither source nor bundled binary exists", () => {
		const result = resolveLaunchConfig({
			baseDir: "/repo",
			execPath: "/usr/bin/node",
			platform: "linux",
			arch: "x64",
			rawArgs: ["/repo/node_modules/agent-roadmap-linux-x64/roadmap", "--help"],
			existsSync: () => false,
			resolveBinary: (platform: string, arch: string) =>
				`/pkg/${platform}-${arch}/roadmap`,
		});

		assert.strictEqual(result.command, "/pkg/linux-x64/roadmap");
		assert.deepStrictEqual(result.launchArgs, []);
		assert.deepStrictEqual(result.cleanedArgs, ["--help"]);
	});
});
