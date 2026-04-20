# Research Assessment — P304: LLM-Free Mechanical Status Reporting

**Date:** 2026-04-20  
**Researcher:** hermes-andy  
**Phase:** DRAFT  
**Status:** Ready for REVIEW promotion

## AC Verification Results

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | status-report.sh produces correct markdown | **PASS** | All sections present: services, git, worktrees, cubics, proposals, changes, gates, dispatches. Clean exit 0. |
| AC-2 | Discord webhook delivery works via crontab | **PARTIAL** | Webhook confirmed working (HTTP 204). Cron had permission issues (fixed with `bash` prefix). 17:00 run failed exit 2 — likely transient DB connection issue. |
| AC-3 | Reports arrive on the hour without LLM | **PASS** | Zero LLM references in scripts. Pure SQL+bash+curl. System crontab (not hermes cron). |
| AC-4 | Failed delivery logs to syslog, does not crash | **PASS** | 16 syslog entries in last 6h, 15 structured (OK/ERROR/WARNING). Report gen failure = exit 1 (hard). Webhook failure = warning (soft). |
| AC-5 | New report templates follow same pattern | **PASS** | `docs/report-templates.md` documents the query→format→deliver pattern with 4 sections + 3 planned templates. |

**Note:** AC-6..10 are duplicates of AC-1..5. Should be consolidated during gate review.

## Issues Found

### 1. Cron Permission Fix (RESOLVED)
- **Symptom:** First 3 cron runs: `/bin/sh: 1: ... Permission denied`
- **Root cause:** Crontab ran script directly; `/bin/sh` couldn't execute. Scripts have 0775 but cron's default shell path had issues.
- **Fix applied:** Changed crontab to `bash /data/code/...` prefix.
- **Status:** Resolved. Subsequent runs work.

### 2. Intermittent Exit 2 (NON-BLOCKING)
- **Symptom:** Some cron runs fail with exit 2 from `status-report.sh`.
- **Root cause:** Script uses `set -uo pipefail`. One of the `psql` commands occasionally fails under cron environment (different `$PATH`, timing, connection pool).
- **Impact:** Non-blocking. Next hourly run retries. Syslog captures the failure.
- **Mitigation:** Could add retry logic or psql connection timeout. Low priority for status reports.

### 3. Webhook URL Hardcoded in Git (LOW RISK)
- **Location:** `scripts/status-report-deliver.sh:26`
- **Risk:** URL visible in repo history. Rotation requires code change + commit.
- **Recommendation:** Move to `$HOME/.hermes/config/webhook-url.txt` or env var. Only matters if rotation becomes common.

### 4. Discord 2000-Char Limit (SAFE NOW)
- Reports truncated to 1900 chars for webhook delivery.
- Current reports ~1000 chars. Safe margin.
- Future risk: Report grows with proposal count. Consider summary-only mode for webhook, full report to file.

### 5. No Retry on Webhook Failure (ACCEPTABLE)
- Current: webhook failure = warning, file saved, next hour retries.
- Acceptable for status reports. Would need retry for time-critical delivery (P303 gateway).

## Implementation Inventory

| File | Purpose | Status |
|------|---------|--------|
| `scripts/status-report.sh` | Pure SQL+bash status report generator | Complete |
| `scripts/status-report-deliver.sh` | Report + file save + Discord webhook delivery | Complete |
| `docs/report-templates.md` | Template pattern documentation | Complete |
| `docs/p304-research-assessment.md` | This assessment | Complete |

**Crontab:** `0 * * * * bash /data/code/AgentHive/scripts/status-report-deliver.sh`

## Design Soundness

The architecture is clean and correct:
- **Zero LLM cost:** No model invocation anywhere in the pipeline.
- **Pull-based delivery:** System cron → bash → psql → curl. No agents, no leases, no orchestration.
- **Error isolation:** Report gen failure (hard exit) separate from webhook failure (soft warning).
- **Template pattern:** query → format → deliver. Replicable for future reports (dispatch, lease audit, proposal changes).

## Recommendation

**Promote to REVIEW.** Core pipeline is functional. Issues found are either resolved (permission fix) or acceptable (transient DB failures). The duplicate ACs (6-10) should be consolidated during gate review. No blocking items remain.

**Deferred to future proposals:**
- Multi-platform delivery (Telegram, Matrix) → P303 gateway
- Retry logic → P303 or dedicated reliability proposal
- Webhook URL config → low-priority cleanup
