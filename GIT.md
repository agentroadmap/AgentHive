# GIT.md: Parallel-Agent Git Discipline

**Version:** 1.0 | **Status:** Live (replaces CONVENTIONS.md §7) | **For:** All AI agents at AgentHive

## STOP — Critical Rules (Never Violate These)

1. **ISOLATION MANDATORY:** Work in `/data/code/worktree/<agent>-<topic>` only. Never in shared `/data/code/AgentHive`. Verify: `git worktree list`. **(Incident #1: claude@bot + gemini collision, git checkout swapped files under mid-edit)**

2. **ATOMIC COMMITS IN SHARED REPO:** Use `git commit -m "msg" -- file file` (one step). NEVER separate `git add` then `git commit`. **(Incident #8: concurrent agents swallow staged files)**

3. **VERIFY BEFORE DESTRUCTIVE OP:** Before reset/rebase/checkout: run `git status --porcelain` (abort if dirty), verify `git log` matches expected, check MERGE_HEAD/REBASE_HEAD absent. **(Incident #3: main mispointed 04c2ffbf missing V3 foundation)**

4. **FORCE-PUSH ONLY ON OWN FEATURE BRANCH:** Use `--force-with-lease=<branch>:<expected-old-sha>` (never plain `--force`, NEVER force-to-main). **(Incident #9: concurrent force overwrites)**

5. **SELF-MERGE IS FORBIDDEN:** Author opens MR/PR. Independent gate agent (different type/provider) merges. Author MUST NOT merge own work. **(Incident #6: sub-agent merged all 4 V3 branches to main self)**

6. **VERIFY AFTER PARALLEL DISPATCH:** Immediately after spawning N agents in parallel: audit `git log` (no direct main commits from build agents), DB state (maturity + verified_by), AC status (no fabrication). Block deployment on mismatch. **(Incident #2: 3 of 5 sub-agents pushed to main; 1 fabricated ACs impersonating 'operator')**

---

## Quick-Reference Command Tables

**Worktree Setup:**
```bash
git worktree add /data/code/worktree/<agent>-<topic> main && cd $_
git worktree list  # Verify isolation
```

**Feature Branch Workflow:**
```bash
git checkout -b feat/p<ID>-<slug>
git commit -m "P<ID> A<step>: msg — files" -- src/file1.ts src/file2.ts  # Atomic (NEVER separate add+commit)
git push -u gitlab feat/p<ID>-<slug>  # Push to canonical remote
```

**Open Merge Request (Author):**
```bash
git push gitlab feat/p<ID>-<slug> -o merge_request.create  # DO NOT MERGE yourself.
roadmap proposal release <ID> <your-agent-id>   # positional args: <proposalId> <agent>
roadmap proposal note-add <ID> <your-agent-id> --note "MR open, ready for independent review"
# Hand to an independent gate: set maturity='mature' so the gate cron picks it up,
# OR notify a gate agent via A2A:  roadmap agents msg "P<ID> ready for gate review" --to <gate-agent>
```

**Merge to Main (Gate Agent Only):**
```bash
git checkout main && git fetch gitlab feat/p<ID>-<slug>
git merge --no-ff FETCH_HEAD
git push gitlab main && git push origin main  # Both remotes (gitlab canonical first)
roadmap proposal promote <ID>   # advance to the next workflow state (gate-owned)
```

**Pre-Destructive Safety Checks:**
```bash
git status --porcelain  # ABORT if output is non-empty (except untracked is OK, modified is NOT)
git rev-parse --verify MERGE_HEAD 2>/dev/null && echo "MERGE IN PROGRESS; abort" && exit 1
git rev-parse --verify REBASE_HEAD 2>/dev/null && echo "REBASE IN PROGRESS; abort" && exit 1
git log --oneline -5  # Verify expected history before proceeding
```

**Force-Push Feature Branch (Rare):**
```bash
EXPECTED_SHA=$(git rev-parse feat/p<ID>-<slug>)
git rebase main
git push --force-with-lease=feat/p<ID>-<slug>:${EXPECTED_SHA} gitlab
```

**Pre-Merge Package.json Stash Dance:**
```bash
git stash push -- package.json package-lock.json
git merge --no-ff feat/p<ID>-<slug>
git stash pop
```

---

## §1. Worktree Isolation (Mandatory)

Every agent works in isolated worktree at `/data/code/worktree/<agent>-<topic>`. Shared root `/data/code/AgentHive` is forbidden except for gate-level merges under operator coordination.

### Setup Your Worktree

```bash
cd /data/code
git fetch gitlab main:main  # Ensure local main is current

# Create isolated worktree
git worktree add worktree/<agent>-<topic> main
cd worktree/<agent>-<topic>

# Verify isolation
pwd                        # Must show /data/code/worktree/<agent>-<topic>
git worktree list         # Your path must appear here
git status --porcelain    # Should be empty
```

**Naming Convention:**
- `<agent>` = your identity (claude-p1438, codex-p1440, george-p1436, hermes-p1437, etc.)
- `<topic>` = proposal-id-slug (p1438-self-claim, p1440-matcher-v2, audit-v3-coverage)

**Example Paths (Verified 2026-06-01):**
```
/data/code/worktree/claude-p1438-self-claim          feat/p1438-self-claim
/data/code/worktree/codex-p1440-matcher-v2           feat/p1440-matcher-v2
/data/code/worktree/george-p1436-a2a-audit           feat/p1436-a2a-audit
/data/code/worktree/codex-one                        codex-one (persistent, shared-root exception)
```

### Pre-Start Verification

```bash
git worktree list --porcelain | grep "$(pwd)"  # Confirms you are isolated
ls -la /data/code/AgentHive/.git/worktrees     # Confirms your .git/worktrees entry exists
```

---

## §2. Branch Ownership & Two-Remote Model

Single-writer rule: Only push branches you hold the lease on.

### Remote Topology

```
gitlab.local (CANONICAL WRITE PATH):
  └─ gitlab/main (primary HEAD)
  └─ gitlab/feat/p<ID>-<slug> (feature branches; MRs opened/merged here)

origin (GitHub MIRROR):
  └─ origin/main (secondary; kept in sync via FF push)
  └─ origin/feat/p<ID>-<slug> (pushed for visibility; PRs secondary)
```

### Verify Remote Config

```bash
git remote -v
# Expected output:
# origin    git@github.com:agentroadmap/AgentHive.git (fetch)
# origin    git@github.com:agentroadmap/AgentHive.git (push)
# gitlab    git@gitlab.local:agentRoadmap/AgentHive.git (fetch)
# gitlab    git@gitlab.local:agentRoadmap/AgentHive.git (push)
```

### Push Feature Branch (To Both, Canonical First)

```bash
git push -u gitlab feat/p<ID>-<slug>    # Canonical remote (primary)
git push origin feat/p<ID>-<slug>       # Mirror remote (secondary)
```

### Do NOT Push to Main

Your feature branch lives at `gitlab/feat/<ID>-<slug>`. You do NOT push to `main`. Gate agent owns main pushes.

### If One Remote Tool Fails (Try The Other)

```bash
# gh pr create fails on GitHub? Try GitLab path:
gh pr create --base main --title "P<ID>: title" --body "See proposal" 2>/dev/null || \
  git push gitlab feat/p<ID>-<slug> -o merge_request.create

# Tool failure ≠ action blocked. Always try both remotes.
```

---

## §3. Commit Discipline

Small, atomic, coherent. One logical unit per commit. No concurrent-add race.

### Atomic Commit (Race-Safe in Shared Repo)

```bash
# ✅ CORRECT: One atomic command
git commit -m "P<ID> A<step>: message — files touched" -- src/file1.ts src/file2.ts

# ✅ ALSO CORRECT: Subshell pipeline prevents interleaving
(git add src/file1.ts && git commit -m "msg") || exit 1

# ❌ WRONG: Two-step in separate invocations (concurrent agents swallow staged files)
git add src/file1.ts
git commit -m "msg"  # Another agent's staged files can sneak in during this gap
```

### Commit Message Format

```
P<proposal-id> A<step>: <single-sentence-title> — <files-touched>

<optional body with rationale, assumptions, risks>

Co-Authored-By: <name> <email>  # If pair-programmed
```

**Example:**
```
P1438 A2: wire self-claim atomic in orchestrator — src/orchestrator.ts src/db/schema.sql

- Add claimAgency() fn with PG SERIALIZABLE txn
- Test concurrent claims → retryable conflict
- Verify no phantom-read in existing leasing flow

Assumption: schema migration M-119 already applied (checked against live agenthive DB)
Risk: SERIALIZABLE txn may timeout under high concurrency; add retry backoff in caller

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

### Rules

- Reference proposal (P<number> links to orchestration DB).
- Mention AC step if applicable (A<number> for Acceptance Criteria).
- List files touched (helps gate reviewer scan scope).
- One coherent change per commit (code + docs OK if logically tied).

---

## §4. Feature Branch Lifecycle (Claim → Develop → Handoff → Gate Merge → Cleanup)

### Step 1: Claim Proposal via MCP

Before creating a worktree, claim the proposal:

```bash
roadmap proposal claim 1438 <your-agent-id>   # positional: <proposalId> <agent>; short-lived lease
# Verify the proposal + lease:
roadmap proposal view 1438
# Keep the lease alive during long work:
roadmap proposal heartbeat 1438 <your-agent-id>   # or: roadmap proposal renew 1438 <your-agent-id>
```

### Step 2: Create Worktree & Feature Branch

```bash
git worktree add /data/code/worktree/<agent>-p1438-self-claim main
cd /data/code/worktree/<agent>-p1438-self-claim
git checkout -b feat/p1438-self-claim
```

### Step 3: Develop, Test, Commit Early

```bash
# Make changes
nano src/orchestrator.ts

# Test via runtime validation (NOT tsc; ~250 pre-existing tsc errors mask new ones)
npm test -- --testNamePattern='P1438'
# If worktree lacks node_modules: NODE_PATH=/data/code/AgentHive/node_modules npm test -- --testNamePattern='P1438'

# Commit atomically (NEVER separate git add + git commit)
git commit -m "P1438 A2: wire self-claim handler" -- src/orchestrator.ts src/db/schema.ts
```

### Step 4: Handle Main Movement (Rebase Your Unpublished Work Only)

```bash
git fetch gitlab main:main
git rebase main
# If conflicts: resolve manually, then git rebase --continue
git push --force-with-lease gitlab feat/p1438-self-claim
```

### Step 5: Push Feature Branch & Open MR

```bash
# Verify status is clean
git status --porcelain  # Must be empty (untracked is OK, modified is NOT)

# Push to gitlab (canonical)
git push -u gitlab feat/p1438-self-claim

# Open MR
git push gitlab feat/p1438-self-claim -o merge_request.create
```

### Step 6: Release Lease & Dispatch Independent Gate Agent

```bash
roadmap proposal release --proposal_id p1438 --release_reason "MR open on gitlab, ready for independent review"

# Dispatch independent gate agent (DIFFERENT type/provider than you)
roadmap agent dispatch --agent_type gate-reviewer --proposal_id p1438 --cubic_id roadmap
```

**DO NOT merge your own MR.** Gate agent merges after independent review.

### Step 7: Gate Agent Merges (Not You)

Gate agent executes:

```bash
git checkout main
git fetch gitlab feat/p1438-self-claim
git merge --no-ff FETCH_HEAD
git push gitlab main && git push origin main  # Both remotes
roadmap proposal transition --proposal_id p1438 --from-state DEVELOP --to-state MERGE
roadmap proposal release --proposal_id p1438 --release_reason "Merged to main, MERGE state"
```

### Step 8: Cleanup Worktree

```bash
cd /data/code
git worktree remove /data/code/worktree/<agent>-p1438-self-claim
git branch -d feat/p1438-self-claim
git push gitlab --delete feat/p1438-self-claim
git push origin --delete feat/p1438-self-claim
```

Verify: `git worktree list` should not show your path.

---

## §5. Self-Merge Anti-Pattern (Why You Don't Merge Your Own Work)

**Governance split** (Incident #6: sub-agent merged all 4 V3 branches to main unsupervised):

- **Author** (you): Write proposal, code, tests, open MR/PR for review.
- **Gate** (independent agent, different type/provider): Review, approve, MERGE to main.

This enforces:
1. Independent review prevents blind spots.
2. Architectural coherence (gate verifies).
3. Test coverage validation (gate reviews test structure).
4. Resource cleanup verification (gate checks).

**Your job ends at MR/PR. Gate agent does the rest.**

---

## §6. Conflict Resolution & When Main Moves

### When Merge/Rebase Encounters Conflicts

```bash
git status  # Shows conflicted files
# Edit each file: look for <<<<<<< HEAD / ||||||| / ======= / >>>>>>>> markers
# Keep both sides if both are intentional; delete ONLY if certain the change is stale
nano path/to/conflicted-file

git add <resolved-file>
git rebase --continue  # or git merge --continue
```

**Golden rule:** If you don't recognize the OTHER side, keep it. Assume it's intentional.

### When Main Moves While You Develop (Rebase Only Your Unpublished Work)

```bash
# Verify main advanced
git log --oneline -5 main
git log --oneline -5 gitlab/main
# If they differ: main has moved

# Rebase your feature onto moved main
git fetch gitlab main:main
git rebase main
# If conflicts: resolve and git rebase --continue
```

Never rebase published (pushed) feature branches. If already in use, fix forward with new commit instead.

---

## §7. Sub-Agent Parallel Dispatch Verification (Critical)

After spawning N agents in parallel with `isolation:"worktree"` parameter, do NOT assume isolation prevents main pushes. Verify immediately.

### Dispatch Manifest (Pre-Dispatch)

```bash
cat > /tmp/dispatch-manifest.txt << 'EOF'
codex-one     p1433     feat/p1433-auto-config
codex-two     p1434     feat/p1434-matcher-v2
claude-code   p1435     feat/p1435-lifecycle-gate
EOF
```

### Immediate Post-Dispatch Audit (Within 5 Minutes; Same Session)

```bash
# Audit 1: Git state verification
echo "=== GIT LOG (last 10) ==="
git log --format="%H %ae %s" -10 origin/main > /tmp/main-state.txt
cat /tmp/main-state.txt

echo "=== BRANCH STATE ==="
git branch -a > /tmp/branches.txt
cat /tmp/branches.txt

echo "=== WORKTREE STATE ==="
git worktree list --porcelain > /tmp/worktrees.txt
cat /tmp/worktrees.txt

# Audit 2: DB state verification
echo "=== PROPOSAL STATE ==="
psql -d agenthive -c "
  SELECT id, title, maturity FROM roadmap.proposal 
  WHERE id IN ('p1433', 'p1434', 'p1435')
  ORDER BY id
" > /tmp/proposal-state.txt
cat /tmp/proposal-state.txt

echo "=== AC STATE ==="
psql -d agenthive -c "
  SELECT proposal_id, item_number, status, verified_by FROM roadmap.proposal_acceptance_criteria
  WHERE proposal_id IN ('p1433', 'p1434', 'p1435')
  ORDER BY proposal_id, item_number
" > /tmp/ac-state.txt
cat /tmp/ac-state.txt

# Audit 3: Commit author verification (critical for isolation bypass detection)
echo "=== COMMIT AUTHOR CHECK ==="
git log --format="%H %ae %cn %s" origin/main | grep -v "Merge branch" | head -10 > /tmp/commit-authors.txt
cat /tmp/commit-authors.txt

# Audit 4: AC fabrication check
echo "=== AC FABRICATION CHECK ==="
psql -d agenthive -c "
  SELECT proposal_id, item_number, status, verified_by 
  FROM roadmap.proposal_acceptance_criteria
  WHERE proposal_id IN ('p1433', 'p1434', 'p1435')
    AND status = 'pass'
  ORDER BY proposal_id, item_number
" > /tmp/ac-fabrication.txt
cat /tmp/ac-fabrication.txt
```

### Escalation Conditions (Block Deployment If ANY Match)

- Commit author is build agent (not gate agent) for merge commit to main
- AC status='pass' without verified_by recorded in DB (or verified_by='operator' when build agent did work)
- Maturity='mature' set by build agent (not gate agent)
- Proposal lease released by wrong agent (not the one who claimed it)

**If escalation triggered:** DO NOT deploy. File critical issue with git SHAs + DB state evidence. Escalate to orchestrator team.

---

## §8. Live-DB Test Hygiene (Fixture Cleanup Discipline)

Tests running against **live** agenthive database MUST implement complete fixture cleanup. (Incident #7: 48+ fixture rows leaked in 2026-05-16 session, orphaned for days.)

### Test Setup with testId Prefix

```typescript
// test/live-db-suite.test.ts
const testId = `p1409-rev-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  // All fixtures MUST be prefixed with testId
  const agencyId = await createAgency(`agency-${testId}`, { ... });
  const providerId = await createProvider(`provider-${testId}`, { ... });
  const modelId = await createModel(`model-${testId}`, { agencyId, providerId, ... });
  
  // Store refs for cleanup
  fixtures = { agencyId, providerId, modelId };
});
```

### Cleanup in FK Order (Children Before Parents)

```typescript
afterAll(async () => {
  // DELETE in FK order (children before parents)
  // 1. model_routes (references model_id)
  const routed = await db.query(
    'DELETE FROM model_routes WHERE model_id = $1 RETURNING id',
    [fixtures.modelId]
  );
  console.log(`Cleaned model_routes: ${routed.rows.length} rows`);
  
  // 2. provider_model (references model_id + provider_id)
  const pmodel = await db.query(
    'DELETE FROM provider_model WHERE model_id = $1 OR provider_id = $1 RETURNING id',
    [fixtures.modelId]
  );
  
  // 3. model_registry (references agency_id)
  const models = await db.query(
    'DELETE FROM model_registry WHERE agency_id = $1 RETURNING id',
    [fixtures.agencyId]
  );
  console.log(`Cleaned model_registry: ${models.rows.length} rows`);
  
  // 4. provider_registry (references agency_id)
  const providers = await db.query(
    'DELETE FROM provider_registry WHERE agency_id = $1 RETURNING id',
    [fixtures.agencyId]
  );
  console.log(`Cleaned provider_registry: ${providers.rows.length} rows`);
  
  // 5. agency (root; no children after step 4)
  const agencies = await db.query(
    'DELETE FROM agency WHERE id = $1 RETURNING id',
    [fixtures.agencyId]
  );
  console.log(`Cleaned agency: ${agencies.rows.length} rows`);
  
  // VERIFY zero litter
  const orphans = await db.query(
    'SELECT COUNT(*) FROM agency WHERE id = $1',
    [fixtures.agencyId]
  );
  
  if (parseInt(orphans.rows[0].count) !== 0) {
    throw new Error(
      `CLEANUP FAILED: testId='${testId}' fixture leaked ${orphans.rows[0].count} rows. ` +
      `Manual cleanup required: DELETE FROM agency WHERE agency_name LIKE '${testId}%'`
    );
  }
});
```

### Pre-Test FK Diagram Audit

Before writing tests, query live DB for FK structure:

```bash
psql agenthive -c "
  SELECT constraint_name, table_name, column_name, referenced_table_name, referenced_column_name
  FROM pg_constraint
  WHERE table_name IN ('agency', 'provider_registry', 'model_registry', 'model_routes')
  ORDER BY table_name, constraint_name
"

# Output guides cleanup order (work backwards from constraints)
```

---

## §9. Verify Before Destroy (Destructive Ops Pattern)

For any bulk DELETE, DROP, reset --hard, or rebase on shared code:

### Pre-Op Checklist (5 Steps)

```bash
# Step 1: Snapshot target rows
psql agenthive -c "
  SELECT * FROM agency WHERE created_at < NOW() - INTERVAL '30 days'
  ORDER BY id
" > /tmp/snapshot-agencies.sql

# Step 2: Dry-run WHERE clause (no side effects; rollback only)
psql agenthive -c "
  BEGIN;
  DELETE FROM agency WHERE created_at < NOW() - INTERVAL '30 days';
  SELECT COUNT(*) AS target_count FROM agency WHERE created_at >= NOW() - INTERVAL '30 days';
  ROLLBACK;
" > /tmp/dry-run.log
cat /tmp/dry-run.log  # Verify count is expected

# Step 3: Identify all FK dependencies
psql agenthive -c "
  SELECT constraint_name, table_name, column_name 
  FROM pg_constraint
  WHERE referenced_table_name = 'agency'
  ORDER BY table_name
" > /tmp/fk-deps.txt
cat /tmp/fk-deps.txt  # Plan cleanup order based on FK hierarchy

# Step 4: Execute with exception skip (resilient to already-gone rows)
# (adapt to your use case; example for bulk delete)
for row_id in $(psql agenthive -t -c "SELECT id FROM agency WHERE created_at < NOW() - INTERVAL '30 days'"); do
  psql agenthive -c "DELETE FROM provider_registry WHERE agency_id = $row_id" 2>/dev/null || \
    echo "Skipped provider cleanup for $row_id (already gone or error)"
done

# Step 5: Verify zero litter
psql agenthive -c "
  SELECT COUNT(*) as remaining_target_rows 
  FROM agency WHERE created_at < NOW() - INTERVAL '30 days'
"
# Must return 0
```

---

## §10. Migration Numbering (Two-Tree Convention, Convergence Not Conflict)

Database schema changes live in TWO places at different numbering (convergence, NOT conflict):

```
scripts/migrations/<N>-pPROPOSAL_ID-<description>.sql
   ↑ Applied deltas (sequential: 001, 002, 003, ... what the migration runner executes)

database/migrations/<N>-<description>.sql
   ↑ Canonical DDL (frozen snapshots of full schema state; numbers are stable, do NOT renumber)
```

### When to Touch Each

**Applied delta (scripts/migrations/)**:
- Always create when modifying schema.
- Number sequentially (next-unused-number-pPROPOSAL_ID.sql).
- This is what the migration runner applies to live DB.

**Canonical DDL (database/migrations/)**:
- Only update for BREAKING CHANGES or periodic convergence cleanup.
- Do NOT renumber; numbers are stable references.

### Example: Adding a Table

```bash
# 1. Create applied delta
cat > scripts/migrations/119-p1438-add-agency-claim-log.sql << 'EOF'
CREATE TABLE IF NOT EXISTS agency_claim_log (
  id BIGSERIAL PRIMARY KEY,
  agency_id BIGINT NOT NULL REFERENCES agency(id),
  claimant_agent_id BIGINT REFERENCES agent_registry(id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_reason TEXT,
  CONSTRAINT fk_agency FOREIGN KEY (agency_id) REFERENCES agency(id) ON DELETE CASCADE
);

CREATE INDEX idx_claim_log_agency ON agency_claim_log(agency_id);
CREATE INDEX idx_claim_log_agent ON agency_claim_log(claimant_agent_id);
EOF

# 2. Test on clone (important: test against clone before live DB)
createdb agenthive_test
pg_dump agenthive | psql agenthive_test
psql agenthive_test -f scripts/migrations/119-p1438-add-agency-claim-log.sql
psql agenthive_test -c "\\d agency_claim_log"  # Verify table created

# 3. Apply to live DB
psql agenthive -f scripts/migrations/119-p1438-add-agency-claim-log.sql
psql agenthive -c "\\d agency_claim_log"  # Verify on live

# 4. Verify migration_history recorded it
psql agenthive -c "
  SELECT migration_name, applied_at FROM migration_history 
  WHERE migration_name LIKE '%p1438%'
  ORDER BY applied_at DESC
"
# MUST show scripts/migrations/119-p1438-add-agency-claim-log.sql entry

# 5. Update canonical DDL (optional unless breaking change)
# Only if this is a BREAKING CHANGE; skip for additive changes
# If updating, edit database/migrations/ appropriately and commit

# 6. Commit both files (or just applied delta if no canonical update)
git commit -m "P1438 A3: add agency-claim-log table for audit trail — scripts/migrations/119-* database/migrations/" -- \
  scripts/migrations/119-p1438-add-agency-claim-log.sql
```

---

## §11. Terminal Output Reliability (Debugging Aid)

Terminal scrollback is unreliable under long sessions. Use files + machine-parseable git queries.

### Reliable Git History (Unambiguous Format)

```bash
# Instead of: git log (terminal rendering fails under TTY corruption)
git log --oneline --format='%h %ae %s' -20 > /tmp/history.txt
cat /tmp/history.txt  # Read via Read tool, not scrollback

# Or for exact SHAs:
git rev-parse main > /tmp/main-sha.txt
git rev-parse gitlab/main >> /tmp/main-sha.txt
cat /tmp/main-sha.txt  # Compare via file contents

# For git status:
git status --porcelain > /tmp/status.txt
cat /tmp/status.txt
```

### Machine-Parseable Git Queries

```bash
# Structured format (never rely on terminal echo)
git log --format='%h|%ae|%s' -10 main > /tmp/log.txt
git status --porcelain > /tmp/status.txt
git diff main...feat/p1438-self-claim > /tmp/diff.patch

# Verify after destructive ops via file contents (not terminal)
git log --oneline -5 main > /tmp/post-op.txt
# Read /tmp/post-op.txt and verify expected state
```

---

## §12. Force-Push Protocol (Feature Branches Only)

If you need to force-push your own unpublished feature branch (e.g., rebase onto moved main):

### Safe Force-Push Pattern

```bash
# Step 1: Identify expected old SHA
EXPECTED_OLD=$(git rev-parse feat/p1438-self-claim)
echo "Expected old SHA: $EXPECTED_OLD"

# Step 2: Dry-run the rebase (safe; no side effects)
git rebase --dry-run main

# Step 3: Execute rebase (no force yet)
git rebase main
# If conflicts: resolve, then git rebase --continue

# Step 4: Force-push with lease (NEVER plain --force)
git push --force-with-lease=feat/p1438-self-claim:${EXPECTED_OLD} gitlab

# Step 5: Verify
git log --oneline gitlab/feat/p1438-self-claim | head -5
# Should show rebased commits
```

### Forbidden Patterns

```
❌ git push --force origin main              # Never force main
❌ git push --force gitlab main              # Never force main
❌ git push -f <branch>                      # Never plain -f
❌ git reset --hard <ref>                    # Only on shared root if status clean + no merge/rebase in progress
```

---

## §13. Package.json Version-Bump Hook Mitigation (Merge Blocker)

The pre-commit hook auto-bumps `package.json` version. Post-merge-hook can trigger dirty state, aborting merge mid-commit and leaving main half-merged.

### Pre-Merge Stash Pattern

```bash
# Before merging feature branch to main:
git stash push -- package.json package-lock.json

# Perform the merge:
git merge --no-ff feat/p1438-self-claim

# After merge succeeds, restore stash:
git stash pop

# Verify clean state:
git status --porcelain  # MUST be empty
```

This prevents the version-bump post-merge-hook from aborting merge and leaving main in half-merged state.

---

## Incident Reference Index (Cross-Reference Guide)

| Incident | Pattern | Fix |
|---|---|---|
| #1 Shared-root collision | Multiple agents in /data/code/AgentHive; git checkout by one swaps files under mid-edit | Enforce: `git worktree list` before work; verify your path is listed |
| #2 Sub-agent main bypass | isolation:worktree parameter ignored; 3 of 5 agents pushed to main anyway; 1 fabricated ACs impersonating 'operator' | Enforce: Audit git log + DB state immediately post-dispatch; block deployment on mismatch |
| #3 Main mispoint | Local main diverged from remotes/main; 04c2ffbf missing entire V3 foundation | Enforce: Pre-check `git log -1 main` vs `git log -1 gitlab/main`; abort if divergent; verify ancestor SHA in advance |
| #4 Stale mirror | origin/main lagged while local had 25 commits; PRs against stale origin showed whole foundation as noise | Enforce: FF-push to both remotes after every merge; verify `git log <sha>..origin/main` shows empty before pushing |
| #5 Tool tunnel vision | gh pr create failed ("must be collaborator"); agent concluded "MRs impossible" without trying GitLab path | Enforce: Never declare action impossible after one tool fails; verify both remotes (origin=GitHub, gitlab=GitLab) |
| #6 Self-merge anti-pattern | Agent authored all 4 V3 branches AND merged all to main (governance violation) | Enforce: Author opens MR/PR; independent gate agent (different type/provider) merges; author NEVER merges own work |
| #7 Test fixture leak | 3 test suites created 48+ fixture rows against LIVE agenthive DB, only tore down scratch proposals, leaked rows for days | Enforce: testId prefix all fixtures; delete children-before-parents per FK order; verify zero litter in afterAll(); escalate failure with manual cleanup SQL |
| #8 Concurrent git add race | Two-step `git add` then `git commit` allowed concurrent agents to sweep in stray staged files | Enforce: Use atomic `git commit -m "msg" -- <file>` pattern or subshell `(git add && git commit)` |
| #9 Force-push without lease | Concurrent force-push overwrote another agent's work without --force-with-lease protection | Enforce: Use `--force-with-lease=<branch>:<expected-old-sha>` only; never plain `--force`; never force-to-main |
| #10 Version-bump hook abort | post-merge-hook dirty package.json triggered merge abort, left main half-merged | Enforce: Stash package.json before merge; restore after; verify clean state |
| #11 Jiti tsc dirty | ~250 pre-existing tsc errors mask new failures; false confidence from tsc --noEmit exit code | Enforce: Test by running `npm test`, not `tsc --noEmit`; ignore pre-existing tsc errors; report new runtime failures only |
| #12 Destructive op during merge | Agent ran reset/rebase while MERGE_HEAD/REBASE_HEAD in progress, corrupting state | Enforce: Check MERGE_HEAD + REBASE_HEAD before any reset/rebase/checkout; abort if found |
| #13 Migration numbering confusion | Same schema change in both trees at different numbers; confusion about which is source of truth | Enforce: scripts/migrations/ = applied deltas (sequential), database/migrations/ = canonical DDL (reference); convergence is expected, not conflict |
| #14 Terminal corruption | Interactive stdout garbled/duplicated under long sessions; reliable pattern = capture to /tmp + Read | Enforce: Redirect to /tmp files; read via Read tool; never trust scrollback; use machine-parseable git queries |
| #15 Verify-before-destroy gap | Bulk DELETE swept wrong rows; no rollback path; 157 agency records deleted due to loose WHERE clause | Enforce: 5-step pattern before any DELETE/DROP/RESET: snapshot → dry-run → FK audit → execute-with-exception-skip → verify-zero-litter |

---

## Quick Start (New Agent, 8 Steps)

1. Read this doc's STOP section (6 critical rules).
2. Create worktree: `git worktree add /data/code/worktree/<you>-<topic> main && cd $_`
3. Create feature branch: `git checkout -b feat/p<ID>-<slug>`
4. Develop & test: `npm test -- --testNamePattern='P<ID>'` (runtime validation)
5. Commit atomically: `git commit -m "P<ID> A<step>: msg — files" -- src/file1.ts`
6. Push & open MR: `git push -u gitlab feat/p<ID>-<slug> && git push gitlab -o merge_request.create`
7. Release lease & dispatch gate: `roadmap proposal release --proposal_id p<ID> --release_reason ".."; roadmap agent dispatch --agent_type gate-reviewer --proposal_id p<ID> --cubic_id roadmap`
8. Wait for gate to merge (you do NOT merge).

---

## References

- **Orchestration:** roadmap MCP proposal lifecycle (claim → DEVELOP → MERGE → COMPLETE)
- **DB topology:** `psql agenthive -c "\\dt roadmap.*"` (proposal, proposal_ac, migration_history, etc.)
- **Remotes:** `git remote -v` (gitlab=canonical, origin=mirror)
- **Worktrees:** `/data/code/worktree/` (live 9 verified 2026-06-01)
- **Incidents:** This doc (Incident Reference Index, §0)

---

**Maintainer:** Gary Qi (gary.qi@gmail.com) | **Last Updated:** 2026-06-01 | **Incidents Resolved:** 1–15 | **Status:** Live