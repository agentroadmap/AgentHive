#!/bin/bash
# TUI Test Harness via tmux
#
# Drives `roadmap board` in a detached tmux session, sends keys, captures
# rendered pane contents. Real screen buffer — not raw ANSI — so we can
# grep for visible text the user would actually see.
#
# Usage:
#   ./scripts/tui-test-harness.sh                  # run all checks
#   ./scripts/tui-test-harness.sh capture <view>   # show a single view
#     where <view> is one of: board, cockpit, headlines, chat
#
# Each test prints PASS/FAIL and, on FAIL, the captured pane content.

set -u

SESSION="tui-test-$$"
COLS=200
ROWS=50
WORK="${TMPDIR:-/tmp}/tui-test-$$"
mkdir -p "$WORK"

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

start_tui() {
	tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "roadmap board"
	sleep 3  # let board render initially
}

send_keys() {
	# $1 = key spec (e.g. "Tab", "q", "Escape", "Enter", "a")
	# $2 = pause after, in seconds (float)
	tmux send-keys -t "$SESSION" "$1"
	sleep "${2:-1}"
}

capture() {
	tmux capture-pane -t "$SESSION" -p
}

expect_marker() {
	# $1 = test name
	# $2 = marker text expected in the visible pane
	local name="$1"
	local marker="$2"
	if capture | grep -qF -- "$marker"; then
		echo "  PASS: $name — found \"$marker\""
		return 0
	else
		echo "  FAIL: $name — missing \"$marker\""
		capture | head -20 | sed 's/^/    | /'
		return 1
	fi
}

expect_no_crash() {
	local name="$1"
	if capture | grep -qE "TypeError|done is not a function|Uncaught"; then
		echo "  FAIL: $name — crash signature in pane"
		capture | grep -E "TypeError|done is not a function|Uncaught" | sed 's/^/    | /'
		return 1
	else
		echo "  PASS: $name — no crash signature"
		return 0
	fi
}

process_still_alive() {
	tmux list-sessions 2>/dev/null | grep -q "^$SESSION:"
}

# ─── Single-view capture mode ────────────────────────────────────────
if [ "${1:-}" = "capture" ]; then
	view="${2:?usage: capture <board|cockpit|headlines|chat>}"
	start_tui
	case "$view" in
		board) ;;  # initial view
		cockpit) send_keys Tab 2 ;;
		headlines) send_keys Tab 2; send_keys Tab 2 ;;
		chat) send_keys Tab 2; send_keys Tab 2; send_keys Tab 2 ;;
		*) echo "unknown view: $view" >&2; exit 2 ;;
	esac
	capture
	exit 0
fi

# ─── Full regression suite ───────────────────────────────────────────
echo "== TUI regression via tmux =="
echo

start_tui

FAILED=0

echo "[1] initial board view renders"
expect_marker "board has DRAFT column" "DRAFT" || FAILED=$((FAILED+1))
expect_marker "board has Filters bar" "Filters" || FAILED=$((FAILED+1))
expect_no_crash "board startup" || FAILED=$((FAILED+1))
echo

echo "[2] Tab → cockpit view"
send_keys Tab 2
expect_marker "cockpit header" "ENGINEER'S COCKPIT" || FAILED=$((FAILED+1))
expect_marker "cockpit Workforce panel" "Workforce" || FAILED=$((FAILED+1))
expect_no_crash "cockpit" || FAILED=$((FAILED+1))
echo

echo "[3] Tab → headlines view"
send_keys Tab 2
expect_marker "headlines header" "LIVE PULSE" || FAILED=$((FAILED+1))
expect_no_crash "headlines" || FAILED=$((FAILED+1))
echo

echo "[4] Tab → chat view"
send_keys Tab 2
expect_marker "chat title or sidebar" "Channels" || FAILED=$((FAILED+1))
expect_no_crash "chat init" || FAILED=$((FAILED+1))
echo

echo "[5] typing in chat input"
send_keys "hello" 1
expect_marker "typed text appears" "hello" || FAILED=$((FAILED+1))
echo

echo "[6] Esc inside input — REGRESSION TEST for 'done is not a function'"
send_keys Escape 2
expect_no_crash "Esc in chat input" || FAILED=$((FAILED+1))
if process_still_alive; then
	echo "  PASS: process still alive after Esc"
else
	echo "  FAIL: process died after Esc"
	FAILED=$((FAILED+1))
fi
echo

echo "[7] q → clean exit (REGRESSION for 'quit is not clean')"
send_keys q 1
sleep 3  # give the process.exit(0) a chance to fire
if process_still_alive; then
	echo "  FAIL: process still alive 3s after q (the quit-hang bug)"
	FAILED=$((FAILED+1))
	# Force teardown
	tmux send-keys -t "$SESSION" C-c
	sleep 1
else
	echo "  PASS: process exited cleanly after q"
fi
echo

echo "== Result =="
if [ "$FAILED" -eq 0 ]; then
	echo "All checks passed."
	exit 0
else
	echo "$FAILED check(s) failed."
	exit 1
fi
