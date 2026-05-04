#!/usr/bin/env bash
# P474: Pre-commit CI hook — block forbidden hardcoded literals in source code.
# This hook enforces the use of ConfigResolver for database, endpoint, and port configuration.
#
# Phase 1 targets:
# - Hardcoded /data/code/ absolute paths in actual code (not docs/comments)
# - Hardcoded port 6420/6421/3000 in code assignments (not examples in comments)
# - Hardcoded MCP URLs in actual resolution logic (not config-keys.ts examples)

set -euo pipefail

FAIL=0

# P474 Phase 1: Target the main violations that block ConfigResolver adoption
# These are real hardcoded assignments that should use ConfigResolver instead.

# 1. Absolute /data/code/orphans fallback in cubic-cleanup (should use ConfigResolver)
if grep -r 'const.*=.*"/data/code/orphans"' src/ 2>/dev/null; then
  echo "FAIL [hardcoded-orphans-path]: /data/code/orphans should use ConfigResolver.get()"
  grep -rn 'const.*=.*"/data/code/orphans"' src/
  FAIL=1
fi

# 2. Hardcoded MCP URLs in production code (not in comments/tests/tools)
# Only flag actual code assignments, not config-keys.ts examples or comments
if grep -r 'const.*=.*"http://127.0.0.1:6421' src/ 2>/dev/null \
   | grep -v 'config-keys\.ts:' \
   | grep -v 'tools/' \
   | grep -v '//.*http' \
   | grep -q .; then
  echo "FAIL [hardcoded-mcp-url]: http://127.0.0.1:6421 should use ConfigResolver"
  grep -rn 'const.*=.*"http://127.0.0.1:6421' src/ \
    | grep -v 'config-keys\.ts:' | grep -v 'tools/' | grep -v '//.*http'
  FAIL=1
fi

# 3. Hardcoded port 3000 in daemon defaults (not examples in comments/tools)
if grep -r 'const.*=.*"http://127.0.0.1:3000"' src/ 2>/dev/null \
   | grep -v 'config-keys\.ts:' \
   | grep -v 'tools/' \
   | grep -v '//.*http' \
   | grep -q .; then
  echo "FAIL [hardcoded-daemon-url]: http://127.0.0.1:3000 should use ConfigResolver"
  grep -rn 'const.*=.*"http://127.0.0.1:3000"' src/ \
    | grep -v 'config-keys\.ts:' | grep -v 'tools/' | grep -v '//.*http'
  FAIL=1
fi

exit $FAIL
