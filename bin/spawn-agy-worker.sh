#!/usr/bin/env bash
#
# spawn-agy-worker.sh — spawn an Antigravity (agy) worker for a claimed AgentHive offer.
#
# This is the antigravity agency's spawn adapter. AgentHive's OS-level AgentSpawner
# has per-CLI arg builders for claude/gemini/codex/copilot but NO `agy` adapter, so
# the antigravity liaison (a cold-wake/bash agent, like claude-bot-gary.a) spawns its
# a*-named workers through this script instead of the OS spawner.
#
# Usage:
#   spawn-agy-worker.sh <model> <worktree_dir> <brief...>
#
# Example:
#   spawn-agy-worker.sh "Claude Sonnet 4.6 (Thinking)" /data/code/worktree/antigravity \
#     "You are ada.review. Perform an independent D1 spec review of proposal P477. \
#      Read its design via:  bin/agenthive-mcp.sh mcp_proposal '{\"action\":\"detail\",\"id\":477}'"
#
# Notes:
#   * --model takes the EXACT agy display string (verified): e.g.
#       "Gemini 3.5 Flash (Medium)", "Gemini 3.1 Pro (High)",
#       "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)".
#   * Workers reach AgentHive via bin/agenthive-mcp.sh (curl) + psql, NOT native MCP.
#   * Runs in print mode (-p) so it exits with the worker's result on stdout.
#
# Env:
#   AGY_BIN   override agy binary (default ~/.local/bin/agy)
#
set -euo pipefail

AGY="${AGY_BIN:-$HOME/.local/bin/agy}"
MODEL="${1:?usage: spawn-agy-worker.sh <model> <worktree_dir> <brief>}"
DIR="${2:?missing worktree dir}"
shift 2
BRIEF="$*"

[ -n "$BRIEF" ] || { echo "spawn-agy-worker: missing brief" >&2; exit 1; }
[ -x "$AGY" ]    || { echo "spawn-agy-worker: agy not executable at $AGY" >&2; exit 1; }
[ -d "$DIR" ]    || { echo "spawn-agy-worker: worktree dir not found: $DIR" >&2; exit 1; }

exec "$AGY" -p "$BRIEF" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  --add-dir "$DIR"
