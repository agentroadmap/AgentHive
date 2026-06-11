#!/usr/bin/env bash
# P675 AC-20: Install systemd units for schema-drift monitor + other services.
#
# This script installs .service and .timer files from deploy/systemd/ and scripts/systemd/
# to the system's /etc/systemd/system directory, then reloads the daemon and enables
# the units. Requires sudo.
#
# Usage:
#   sudo ./deploy/install-systemd-units.sh
#   sudo ./deploy/install-systemd-units.sh --unit agenthive-schema-drift-monitor.service

set -euo pipefail
cd "$(dirname "$0")/.."

UNIT_FILTER="${1:---unit '*'}"  # Install all units by default
UNITS_DIRS=("deploy/systemd" "scripts/systemd")

if [[ $EUID -ne 0 ]]; then
	echo "This script must be run as root (use sudo)"
	exit 1
fi

# Verify at least one source directory exists
found_dir=0
for dir in "${UNITS_DIRS[@]}"; do
	if [[ -d "$dir" ]]; then
		found_dir=1
		break
	fi
done

if [[ $found_dir -eq 0 ]]; then
	echo "Error: no systemd unit directories found (${UNITS_DIRS[@]})"
	exit 1
fi

# Install from all available directories
for UNITS_DIR in "${UNITS_DIRS[@]}"; do
	[[ ! -d "$UNITS_DIR" ]] && continue

	echo "==> Installing systemd units from $UNITS_DIR"

	# Install .service and .timer files
	for unit_file in "$UNITS_DIR"/*.service "$UNITS_DIR"/*.timer; do
		[[ -f "$unit_file" ]] || continue
		unit_name=$(basename "$unit_file")

		# Skip if a unit filter was provided and this file doesn't match
		if [[ "$UNIT_FILTER" != "--unit '*'" ]] && [[ "$unit_name" != "$UNIT_FILTER" ]]; then
			continue
		fi

		echo "  Installing $unit_name"
		cp "$unit_file" "/etc/systemd/system/$unit_name"
	done

	# Install wrapper shell scripts
	for script_file in "$UNITS_DIR"/*.sh; do
		[[ -f "$script_file" ]] || continue
		script_name=$(basename "$script_file")
		echo "  Installing $script_name to /usr/local/bin"
		cp "$script_file" "/usr/local/bin/$script_name"
		chmod +x "/usr/local/bin/$script_name"
	done
done

echo "==> Reloading systemd daemon"
systemctl daemon-reload

# Enable the timer unit so it starts on boot
if [[ -f /etc/systemd/system/agenthive-schema-drift-monitor.timer ]]; then
	echo "==> Enabling agenthive-schema-drift-monitor.timer"
	systemctl enable agenthive-schema-drift-monitor.timer
	echo "  Timer is now active (next run in up to 15 minutes)"
fi

echo "==> Done"
echo ""
echo "Verify:"
echo "  systemctl status agenthive-schema-drift-monitor.timer"
echo "  systemctl list-timers agenthive-schema-drift-monitor.timer"
