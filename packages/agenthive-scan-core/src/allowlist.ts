import fs from "fs/promises";
import yaml from "js-yaml";
import path from "path";

export interface AllowlistEntry {
  path: string;
  rules: string[] | "*";
  reason: string;
}

export async function getAllowlist(allowlistPath: string): Promise<AllowlistEntry[]> {
  try {
    const content = await fs.readFile(allowlistPath, "utf-8");
    const parsed = yaml.load(content) as AllowlistEntry[];
    return parsed || [];
  } catch {
    // Return empty if file doesn't exist
    return [];
  }
}

export function isAllowed(
  filePath: string,
  ruleId: string,
  allowlist: AllowlistEntry[]
): boolean {
  for (const entry of allowlist) {
    if (filePath.endsWith(entry.path) || path.basename(filePath) === entry.path) {
      if (entry.rules === "*" || (Array.isArray(entry.rules) && entry.rules.includes(ruleId))) {
        return true;
      }
    }
  }
  return false;
}

export async function createAllowlistTemplate(): Promise<string> {
  return `# Hardcoding Scanner Allowlist
# Entries below suppress findings for files that are known exceptions

- path: scripts/agenthive.cjs.js
  rules: "*"
  reason: generated bundle, hardcoded paths are acceptable

- path: docs/architecture/control-plane-multi-project-architecture.md
  rules:
    - paths.agenthive-project-root
    - endpoints.mcp-url
    - identity.hardcoded-username
  reason: architecture documentation must show target literals for explanation

- path: database/ddl/01-schema.sql
  rules:
    - identity.hardcoded-username
  reason: initial DDL contains literal postgres user references
`;
}
