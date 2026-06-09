// @agenthive/scan-core main export
// Generic scanner engine and CLI infrastructure (no rules bundled)

export { runScan, type ScannerResult } from "./engine.js";
export {
  loadRules,
  type Rule,
  type RuleSet,
  type Finding,
  type ScannerConfig,
  type ConfidenceLevel,
  type SeverityLevel,
  saveBaseline,
  loadBaseline,
  diffBaseline,
} from "./rules.js";
export { writeOutput } from "./output.js";
export { createAllowlistTemplate, getAllowlist, isAllowed } from "./allowlist.js";

export const SCHEMA_VERSION = 1;
export const PACKAGE_VERSION = "1.0.0";
