# Scratch Pre-Commit Hook (P452)

## Overview

The scratch pre-commit hook (`scripts/git-hooks/pre-commit-scratch-guard.sh`) prevents accidental commits of scratch/session files to tracked directories like `docs/architecture/`, `docs/governance/`, `src/`, and `scripts/src/`.

## What Gets Blocked

The hook fails on any staged commit that:
1. Adds files matching scratch patterns:
   - `gate-decisions-*.md` (gate review notes)
   - `P*-ship-*.md` (ship/verification reports)
   - `*-handoff-*.md` (session handoffs)

2. **To tracked directories** (where code and durable docs live):
   - `docs/architecture/`
   - `docs/governance/`
   - `docs/proposals/`
   - `src/`
   - `scripts/src/`

## What Gets Allowed

- Same scratch patterns are **allowed** in:
  - `tmp/` — runtime scratch space (gitignored)
  - `docs/proposals/` — proposal markdown archive (legacy, tracked but archival)

## Installation

Install the hook once in your local worktree:

```bash
cd /data/code/AgentHive
ln -s ../../scripts/git-hooks/pre-commit-scratch-guard.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or manually (no symlink):

```bash
cp scripts/git-hooks/pre-commit-scratch-guard.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Testing the Hook

Create a dummy scratch file in a tracked dir and try to stage it:

```bash
echo "test" > docs/architecture/gate-decisions-test.md
git add docs/architecture/gate-decisions-test.md
# Expected: hook rejects with error message
```

Move it to `tmp/` and try again:

```bash
mv docs/architecture/gate-decisions-test.md tmp/gate-decisions-test.md
git add tmp/gate-decisions-test.md
# Expected: hook allows (tmp is gitignored)
```

## Troubleshooting

### Hook not running

If `git commit` doesn't invoke the hook:

1. Verify hook is executable: `ls -la .git/hooks/pre-commit`
2. Verify symlink/copy is correct: `cat .git/hooks/pre-commit | head -5`
3. Check for bash syntax errors: `bash -n .git/hooks/pre-commit`

### Hook is too strict

To temporarily bypass (not recommended):

```bash
git commit --no-verify -m "message"
```

But prefer moving the file to `tmp/` instead.

### Want to add new patterns?

Edit `scripts/git-hooks/pre-commit-scratch-guard.sh`, update the `SCRATCH_PATTERNS` array, and rebuild the hook in your `.git/hooks/` directory.

## See Also

- [P452 Design](../proposals/P452-design.md) — Three-layer scratch cleanup strategy
- [CONVENTIONS.md](../CONVENTIONS.md) — Full governance model
