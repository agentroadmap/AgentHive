#!/bin/bash
# P1068: Sync agency-agents role library from GitHub to vendor/ and populate DB tables
#
# Usage:
#   ./scripts/sync-agency-agents.sh [--force]
#
# This script:
# 1. Clones or pulls github.com/msitarzewski/agency-agents to vendor/agency-agents
# 2. Reads all .md role definition files
# 3. Populates capability_taxonomy and role_definition DB tables
# 4. Marks previously active roles as inactive if no longer in upstream

set -euo pipefail

# Configuration
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/agency-agents"
VENDOR_LOCAL_DIR="${REPO_ROOT}/vendor/agency-agents-local"
UPSTREAM_REPO="${AGENCY_AGENTS_REPO:-https://github.com/msitarzewski/agency-agents.git}"

# Logging
log() { echo "[sync-agency-agents] $*" >&2; }
error() { echo "[sync-agency-agents] ERROR: $*" >&2; exit 1; }

# Step 1: Clone or pull upstream
log "Syncing upstream repo: $UPSTREAM_REPO"
if [ ! -d "$VENDOR_DIR/.git" ]; then
  git clone --depth 1 "$UPSTREAM_REPO" "$VENDOR_DIR" 2>&1 | grep -E "^(Cloning|Receiving)" || true
else
  git -C "$VENDOR_DIR" pull --ff-only origin main 2>&1 | grep -E "^(Already|Fast|Updating)" || true
fi

UPSTREAM_SHA=$(git -C "$VENDOR_DIR" rev-parse HEAD)
log "Upstream SHA: $UPSTREAM_SHA"

# Step 2: Discover all role files
log "Discovering role definition files..."
DISCOVERED_ROLES=$(mktemp)
trap "rm -f $DISCOVERED_ROLES" EXIT

find "$VENDOR_DIR" -name "*.md" -type f | while read -r mdfile; do
  relpath="${mdfile#$VENDOR_DIR/}"

  # Skip top-level files and special directories
  [[ "$relpath" != *"/"* ]] && continue
  [[ "$relpath" == ".git/"* ]] && continue
  [[ "$relpath" == ".github/"* ]] && continue
  [[ "$relpath" == "examples/"* ]] && continue
  [[ "$relpath" == "integrations/"* ]] && continue

  domain=$(echo "$relpath" | cut -d/ -f1)
  [ -z "$domain" ] && continue

  filename=$(basename "$mdfile" .md)
  [[ "$filename" == ${domain}-* ]] && role_name="${filename#${domain}-}" || role_name="$filename"
  role_slug="${domain}/${role_name}"

  [ -s "$mdfile" ] && echo "$role_slug|$relpath|$mdfile" >> "$DISCOVERED_ROLES"
done

log "Found $(wc -l < "$DISCOVERED_ROLES") role definitions"

# Step 3: Upsert roles into database
log "Upserting role definitions to database..."
insert_count=0

while IFS='|' read -r role_slug relpath mdfile; do
  content_hash=$(sha256sum "$mdfile" | awk '{print $1}')
  domain=$(echo "$role_slug" | cut -d/ -f1)

  # Insert capability_taxonomy
  psql -d agenthive << EOSQL > /dev/null 2>&1 || true
INSERT INTO roadmap_proposal.capability_taxonomy (role_slug, domain, vendor_path, synced_sha, is_active, synced_at)
VALUES ('$role_slug', '$domain', '$relpath', '$UPSTREAM_SHA', true, now())
ON CONFLICT (role_slug) DO UPDATE
SET domain = EXCLUDED.domain,
    vendor_path = EXCLUDED.vendor_path,
    synced_sha = EXCLUDED.synced_sha,
    is_active = true,
    synced_at = now();
EOSQL

  # Insert role_definition with content
  psql -d agenthive << EOSQL > /dev/null 2>&1 || true
INSERT INTO roadmap_proposal.role_definition (role_slug, content_md, content_hash, synced_at, synced_sha)
VALUES ('$role_slug', \$CONTENT\$$(cat "$mdfile")\$CONTENT\$, '$content_hash', now(), '$UPSTREAM_SHA')
ON CONFLICT (role_slug) DO UPDATE
SET content_md = EXCLUDED.content_md,
    content_hash = EXCLUDED.content_hash,
    synced_at = now(),
    synced_sha = EXCLUDED.synced_sha;
EOSQL

  insert_count=$((insert_count + 1))
done < "$DISCOVERED_ROLES"

log "Inserted/updated $insert_count role definitions"

# Step 4: Mark removed roles as inactive
log "Marking removed roles as inactive..."
CURRENT_ROLES=$(mktemp)
trap "rm -f $DISCOVERED_ROLES $CURRENT_ROLES" EXIT

psql -d agenthive -t -c "SELECT role_slug FROM roadmap_proposal.capability_taxonomy WHERE is_active = true;" > "$CURRENT_ROLES" 2>/dev/null || true

while read -r role_slug; do
  grep -q "^$role_slug|" "$DISCOVERED_ROLES" || \
    psql -d agenthive -c "UPDATE roadmap_proposal.capability_taxonomy SET is_active = false WHERE role_slug = '$role_slug';" > /dev/null 2>&1 || true
done < "$CURRENT_ROLES"

# Step 5: Record sync
echo "$UPSTREAM_SHA" > "$VENDOR_DIR/.sync-sha"
log "Sync complete: SHA=$UPSTREAM_SHA"
exit 0
