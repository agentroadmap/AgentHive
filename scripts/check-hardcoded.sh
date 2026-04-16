#!/bin/bash
# Pre-commit hook to catch hardcoded database names and URLs
# Usage: ./scripts/check-hardcoded.sh

set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Checking for hardcoded values..."

# Patterns to detect (database names, URLs, IDs)
PATTERNS=(
  "agent-roadmap-v2"  # Old database name
  "roadmap2"          # Current database name (should be in config)
  "roadmap"           # MCP server name (should be in config)
  "127.0.0.1:3000"    # Local service URL (should be in config)
  "localhost:3000"    # Local service URL (should be in config)
  "c200[0-9a-f]"      # Database IDs (should be in config)
)

# Files to check (exclude node_modules, config, tests, and migration files)
CHECK_FILES=$(find src/ -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v test | grep -v config)

# Check each pattern
for pattern in "${PATTERNS[@]}"; do
  matches=$(grep -rn "$pattern" $CHECK_FILES 2>/dev/null | head -5)
  if [ -n "$matches" ]; then
    echo -e "${RED}❌ Found hardcoded value: ${pattern}${NC}"
    echo "$matches"
    echo ""
  fi
done

# Check if any matches were found
if [ -n "$(grep -rn "${PATTERNS[0]}" $CHECK_FILES 2>/dev/null)" ]; then
  echo -e "${YELLOW}⚠️  Hardcoded values detected!${NC}"
  echo "Please use config.yml or environment variables instead."
  echo ""
  echo "Files to fix:"
  grep -rn "${PATTERNS[0]}" $CHECK_FILES 2>/dev/null | cut -d: -f1 | sort -u
  exit 1
fi

echo "✅ No hardcoded values found!"
exit 0
