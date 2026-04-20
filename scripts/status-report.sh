#!/bin/bash
# AgentHive Status Report — pure SQL, no LLM required
set -euo pipefail

export PGPASSWORD="${PG_PASSWORD:-}"
PG="psql -h 127.0.0.1 -U xiaomi -d agenthive -t -A"

# --- Services ---
SERVICES=""
for svc in agenthive-orchestrator agenthive-gate-pipeline agenthive-mcp; do
  line=$(sudo /bin/systemctl status "$svc" 2>&1 | grep -m1 "^ *Active:" || echo "")
  state=$(echo "$line" | awk '{print $2}')
  if [ "$state" = "active" ]; then
    SERVICES="${SERVICES}🟢 ${svc}\n"
  else
    SERVICES="${SERVICES}🔴 ${svc}\n"
  fi
done

# --- Git ---
GIT_BRANCH=$(cd /data/code/AgentHive && git branch --show-current 2>/dev/null || echo "?")
GIT_HEAD=$(cd /data/code/AgentHive && git log --oneline -1 2>/dev/null || echo "?")

# --- Worktrees ---
WT_ROOT="/data/code/worktree"
if [ -d "$WT_ROOT" ]; then
  WT_DIRS=$(ls -d "$WT_ROOT"/*/  2>/dev/null || true)
  WT_COUNT=$(echo "$WT_DIRS" | grep -c . 2>/dev/null || echo 0)
  if [ "$WT_COUNT" -gt 0 ]; then
    WT_NAMES=$(ls -1 "$WT_ROOT"/ 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
    WORKTREE_LINE="${WT_COUNT}: ${WT_NAMES}"
  else
    WORKTREE_LINE="0 — ⚠️ empty"
  fi
else
  WORKTREE_LINE="⚠️ ${WT_ROOT} missing"
fi

# Check active cubics for missing worktrees
CUBIC_WT_MISMATCH=$($PG -c "
SELECT COUNT(*) FROM roadmap.cubics c
WHERE c.status = 'active'
  AND c.worktree_path NOT LIKE '/data/code/worktree/%';" 2>/dev/null)

# --- Cubics ---
CUBICS_ACTIVE=$($PG -c "SELECT COUNT(*) FROM roadmap.cubics WHERE status = 'active';" 2>/dev/null)
CUBICS_DETAIL=$($PG -F', ' -c "
SELECT phase || ':' || count
FROM (SELECT phase, COUNT(*) as count FROM roadmap.cubics WHERE status = 'active' GROUP BY phase ORDER BY phase) sub;
" 2>/dev/null)
CUBICS_DETAIL=$(echo "$CUBICS_DETAIL" | tr '\n' ' ' | sed 's/ $//')

# --- Proposals by type × state ---
PROPOSALS_BY_TYPE=$($PG -F'|' -c "
SELECT type || ' ' || upper_status || ':' || count
FROM (
  SELECT type,
    CASE
      WHEN upper(status) = 'DRAFT' THEN 'Draft'
      WHEN upper(status) = 'REVIEW' THEN 'Review'
      WHEN upper(status) = 'DEVELOP' THEN 'Develop'
      WHEN upper(status) = 'MERGE' THEN 'Merge'
      WHEN upper(status) = 'COMPLETE' THEN 'Complete'
      ELSE status
    END AS upper_status,
    COUNT(*) as count
  FROM roadmap_proposal.proposal
  WHERE upper(status) NOT IN ('COMPLETE', 'DEPLOYED')
  GROUP BY type,
    CASE
      WHEN upper(status) = 'DRAFT' THEN 'Draft'
      WHEN upper(status) = 'REVIEW' THEN 'Review'
      WHEN upper(status) = 'DEVELOP' THEN 'Develop'
      WHEN upper(status) = 'MERGE' THEN 'Merge'
      WHEN upper(status) = 'COMPLETE' THEN 'Complete'
      ELSE status
    END
) sub
ORDER BY
  CASE type WHEN 'product' THEN 1 WHEN 'component' THEN 2 WHEN 'feature' THEN 3 WHEN 'issue' THEN 4 WHEN 'hotfix' THEN 5 ELSE 6 END,
  CASE upper_status WHEN 'Draft' THEN 1 WHEN 'Review' THEN 2 WHEN 'Develop' THEN 3 WHEN 'Merge' THEN 4 END;
" 2>/dev/null)

TOTAL_ACTIVE=$($PG -c "SELECT COUNT(*) FROM roadmap_proposal.proposal WHERE upper(status) NOT IN ('COMPLETE', 'DEPLOYED');" 2>/dev/null)
TOTAL_DONE=$($PG -c "SELECT COUNT(*) FROM roadmap_proposal.proposal WHERE upper(status) IN ('COMPLETE', 'DEPLOYED');" 2>/dev/null)
TOTAL_ALL=$($PG -c "SELECT COUNT(*) FROM roadmap_proposal.proposal;" 2>/dev/null)

# --- Last hour ---
CHANGES=$($PG -F'|' -c "
SELECT display_id || ' ' || status || ' (' || maturity || ')'
FROM roadmap_proposal.proposal
WHERE modified_at > now() - interval '1 hour'
ORDER BY modified_at DESC LIMIT 10;
" 2>/dev/null)

GATES=$($PG -F'|' -c "
SELECT proposal_id || ': ' || from_state || ' → ' || to_state || ' (' || decision || ' by ' || decided_by || ')'
FROM roadmap_proposal.gate_decision_log
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC LIMIT 10;
" 2>/dev/null)

OPEN_DISPATCHES=$($PG -c "SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch WHERE offer_status = 'open';" 2>/dev/null)
CLAIMED_HOUR=$($PG -c "SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch WHERE offer_status = 'claimed' AND claimed_at > now() - interval '1 hour';" 2>/dev/null)

# --- Build report ---
NOW=$(date -u '+%Y-%m-%d %H:%M UTC')
REPORT="**AgentHive Status — $NOW**

**🟢 Services**
$(echo -e "$SERVICES")
**📦 Git** \`${GIT_BRANCH}\` — \`${GIT_HEAD}\`

**🌲 Worktrees** — ${WORKTREE_LINE}
$(if [ "${CUBIC_WT_MISMATCH:-0}" -gt 0 ]; then echo "⚠️ ${CUBIC_WT_MISMATCH} active cubics have wrong worktree path (should be /data/code/worktree/ not /data/code/worktree-)"; fi)

**🔵 Cubics** — ${CUBICS_ACTIVE} active (${CUBICS_DETAIL})

**📊 Proposals** — ${TOTAL_ACTIVE} active / ${TOTAL_DONE} done / ${TOTAL_ALL} total"

# Group by type
CURRENT_TYPE=""
while IFS='|' read -r entry; do
  [ -z "$entry" ] && continue
  TYPE=$(echo "$entry" | awk '{print $1}')
  REST=$(echo "$entry" | sed "s/^$TYPE //")
  if [ "$TYPE" != "$CURRENT_TYPE" ]; then
    CURRENT_TYPE="$TYPE"
    REPORT="${REPORT}
*${TYPE}*  ${REST}"
  else
    REPORT="${REPORT} | ${REST}"
  fi
done <<< "$PROPOSALS_BY_TYPE"

if [ -n "$CHANGES" ]; then
  REPORT="${REPORT}

**⚡ Changes (last hour)**"
  while IFS='|' read -r c; do
    [ -z "$c" ] && continue
    REPORT="${REPORT}
${c}"
  done <<< "$CHANGES"
else
  REPORT="${REPORT}

⚡ Quiet hour"
fi

if [ -n "$GATES" ]; then
  REPORT="${REPORT}

**🚪 Gates**"
  while IFS='|' read -r g; do
    [ -z "$g" ] && continue
    REPORT="${REPORT}
${g}"
  done <<< "$GATES"
fi

REPORT="${REPORT}

**💬 Dispatches** — ${OPEN_DISPATCHES} open, ${CLAIMED_HOUR} claimed"

echo "$REPORT"
