#!/bin/bash
# Pre-commit hook: prevent accidental commits of scratch files to tracked dirs
# See docs/operations/scratch-pre-commit-hook.md for installation and usage
# P452: Layer 1 cleanup scaffold

set -e

# Get list of staged files
STAGED=$(git diff --cached --name-only)

SCRATCH_PATTERNS=(
  "gate-decisions-"
  "P[0-9]*-ship-"
  "-handoff-"
)

PROTECTED_DIRS=(
  "docs/architecture/"
  "docs/governance/"
  "docs/proposals/"
  "src/"
  "scripts/src/"
)

ERROR_FOUND=0

for file in $STAGED; do
  # Check if file matches any scratch pattern
  for pattern in "${SCRATCH_PATTERNS[@]}"; do
    if [[ "$file" =~ $pattern ]]; then
      # Check if it's in a protected (tracked) directory
      IN_PROTECTED=0
      for protected in "${PROTECTED_DIRS[@]}"; do
        if [[ "$file" =~ ^$protected ]]; then
          IN_PROTECTED=1
          break
        fi
      done

      # Exception: allow in tmp/ or docs/proposals/
      if [[ "$file" =~ ^tmp/ ]] || [[ "$file" =~ ^docs/proposals/ ]]; then
        IN_PROTECTED=0
      fi

      if [[ $IN_PROTECTED -eq 1 ]]; then
        echo "ERROR: Scratch file '$file' cannot be committed to tracked dir"
        echo "  Pattern matched: '$pattern'"
        echo "  Move to tmp/ or docs/proposals/ instead"
        ERROR_FOUND=1
      fi
    fi
  done
done

if [[ $ERROR_FOUND -eq 1 ]]; then
  echo ""
  echo "P452: Scratch guard rejected. See docs/operations/scratch-pre-commit-hook.md"
  exit 1
fi

exit 0
