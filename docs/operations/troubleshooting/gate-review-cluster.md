# Gate-Review Cluster Alert

**Trigger**: Discord message starting with `⚠️ **Gate-review cluster**`

**Source**: `tg_proposal_review_cluster_detect` trigger on `roadmap_proposal.proposal_reviews`

---

## What the alert means

The trigger detected that a single reviewer identity issued 3 or more `approve` verdicts within a 60-second window. This pattern matches the rubber-stamp fingerprint observed on 2026-05-16 (twice: 6 approves in <1s at 00:57 UTC; 12 approves in 27s at 23:55 UTC). One of those clusters falsely advanced P1017 to MERGE.

The alert fires at count milestones of 3, 6, 9, … so a burst of 12 generates two alerts, not 12.

---

## Step 1 — Query the cluster details

```sql
SELECT r.id, r.proposal_id, p.display_id, r.verdict, r.notes, r.reviewed_at
FROM roadmap_proposal.proposal_reviews r
JOIN roadmap_proposal.proposal p ON p.id = r.proposal_id
WHERE r.reviewer_identity = '<identity from alert>'
  AND r.verdict = 'approve'
  AND r.reviewed_at >= now() - interval '5 minutes'
ORDER BY r.reviewed_at;
```

If the cluster is older, adjust the interval.

---

## Step 2 — Audit each proposal in the cluster

For each `proposal_id` returned:

```sql
-- Check AC state
SELECT item_number, description, status
FROM roadmap_proposal.acceptance_criteria
WHERE proposal_id = <id>
ORDER BY item_number;

-- Check gate_decision_log (should have a matching row if a transition happened)
SELECT * FROM roadmap_proposal.gate_decision_log
WHERE proposal_id = <id>
ORDER BY created_at DESC LIMIT 5;
```

Red flags indicating rubber-stamp:
- Multiple ACs with `status = 'pending'` or `status = 'blocked'`
- No matching `gate_decision_log` row despite a state transition
- Review `notes` are a single generic sentence identical across proposals

---

## Step 3 — Write corrective operator-audit reviews

For each proposal where the cluster approve contradicts live AC state:

```sql
-- Insert a corrective review that supersedes the rubber-stamp
INSERT INTO roadmap_proposal.proposal_reviews
  (proposal_id, reviewer_identity, verdict, notes, is_blocking, reviewed_at)
VALUES
  (<id>, 'operator-audit', 'request_changes',
   'Rubber-stamp approve from <identity> reverted — AC state shows N pending/blocked items. Re-review required.',
   true, now());
```

If a state transition was triggered by the rubber-stamp and needs reverting, use the MCP `transition` action with operator authorization or update `proposal_state_transitions` directly with `transitioned_by = 'operator-audit'`.

---

## Step 4 — Investigate the reviewer agent

Check whether the reviewer agency is still running and healthy:

```bash
sudo systemctl status agenthive-orchestrator.service
psql -d agenthive -c "SELECT * FROM roadmap_control.agent_registry WHERE agent_identity LIKE '%gate-reviewer%' ORDER BY last_seen DESC LIMIT 5;"
```

If the agent is in a crash-restart loop or running in degraded state, consider:
- Stopping the agency: `sudo systemctl stop <agency>.service`
- Filing a hotfix proposal for the root cause

---

## Historical audit

To check the 7-day history for clusters that would have triggered the alarm:

```bash
psql -d agenthive -f scripts/audits/find-historical-clusters.sql
```

---

## Threshold tuning

The 60-second window and >=3 threshold are set in the trigger function
`roadmap_proposal.fn_gate_review_cluster_detect`. To change them, update
migration `136-p1131-cluster-alarm.sql` and re-apply, or `CREATE OR REPLACE
FUNCTION` directly with the new constants.
