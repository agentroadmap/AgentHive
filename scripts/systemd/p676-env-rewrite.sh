#!/usr/bin/env bash
#
# P676 — rewrite EnvironmentFile= lines on all 10 agenthive-* services
# to point at the new capability-scoped env files (env.ro / env.app).
#
# Idempotent: running twice is a no-op once units already point at the new
# files. Prints what it would do under DRY_RUN=1; otherwise applies in place
# and runs `systemctl daemon-reload` at the end.
#
# Service → role mapping (from P676 design):
#
#   roadmap_ro   : agenthive-state-feed, agenthive-discord-bridge
#   roadmap_app  : agenthive-board, agenthive-mcp, agenthive-orchestrator,
#                  agenthive-gate-pipeline, agenthive-claude-agency,
#                  agenthive-copilot-agency, agenthive-a2a,
#                  agenthive-notification-router
#
# Usage:
#   sudo DRY_RUN=1 bash scripts/systemd/p676-env-rewrite.sh   # preview
#   sudo bash scripts/systemd/p676-env-rewrite.sh             # apply

set -euo pipefail

DRY_RUN=${DRY_RUN:-0}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}

declare -A SERVICE_ROLE=(
	[agenthive-state-feed]=ro
	[agenthive-discord-bridge]=ro
	[agenthive-board]=app
	[agenthive-mcp]=app
	[agenthive-orchestrator]=app
	[agenthive-gate-pipeline]=app
	[agenthive-claude-agency]=app
	[agenthive-copilot-agency]=app
	[agenthive-a2a]=app
	[agenthive-notification-router]=app
)

run() {
	if [[ $DRY_RUN -eq 1 ]]; then
		echo "[dry-run] $*"
	else
		eval "$@"
	fi
}

for svc in "${!SERVICE_ROLE[@]}"; do
	role=${SERVICE_ROLE[$svc]}
	unit="$UNIT_DIR/${svc}.service"
	target="/etc/agenthive/env.${role}"

	if [[ ! -f "$unit" ]]; then
		echo "skip: $unit not found"
		continue
	fi

	if grep -q "^EnvironmentFile=$target\$" "$unit"; then
		echo "ok:   $svc already on $target"
		continue
	fi

	# Match either /etc/agenthive/env or /home/xiaomi/.agenthive.env (discord-bridge)
	echo "edit: $svc → $target"
	run "sed -i.p676.bak -E \
	    's|^EnvironmentFile=(/etc/agenthive/env|/home/xiaomi/\\.agenthive\\.env)\$|EnvironmentFile=$target|' \
	    '$unit'"
done

run "systemctl daemon-reload"

cat <<EOF

Done. Restart services in waves per docs/operations/p676-role-split-rollback-2026-04-29.md:

  Wave 1: sudo systemctl restart agenthive-state-feed agenthive-discord-bridge
  Wave 2: sudo systemctl restart agenthive-board agenthive-mcp
  Wave 3: sudo systemctl restart agenthive-orchestrator agenthive-gate-pipeline agenthive-notification-router
  Wave 4: sudo systemctl restart agenthive-claude-agency agenthive-copilot-agency agenthive-a2a

After verifying no permission errors:
  sudo -u postgres psql -d agenthive -c 'ALTER ROLE admin CONNECTION LIMIT 5;'

EOF
