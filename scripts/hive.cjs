#!/usr/bin/env node
/**
 * hive CLI runner — jiti-based dev/production shim.
 * In production this is replaced by a bundled scripts/hive.cjs.js built by build-hive.cjs.
 * At dev time jiti transpiles TypeScript on-the-fly.
 */
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { existsSync } = require("node:fs");

const bundled = resolve(__dirname, "hive.cjs.js");

if (existsSync(bundled)) {
  // Production: load the pre-built bundle.
  require(bundled);
} else {
  // Development: use jiti for on-the-fly TypeScript.
  const jiti = require("jiti")(resolve(__dirname, ".."));
  jiti(resolve(__dirname, "../src/apps/hive-cli/index.ts"));
}
