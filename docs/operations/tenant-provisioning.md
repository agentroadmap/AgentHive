# Tenant Repository Provisioning Runbook (P516)

## Overview

This runbook guides operators through provisioning a new tenant project repository, worktree, and registry configuration.

**Scope:** Manual provisioning for v1 (P516). Automated provisioning is planned for P518.

**Prerequisites:**
- Access to GitLab (to create repositories)
- Shell access to the agent host (to run git commands)
- Postgres access to the control plane (`roadmap.project` table)
- Operator authorization (AGENTHIVE_OPERATOR_KEY)

## Provisioning Checklist

### Step 1: Create GitLab Repository

**Goal:** Set up the tenant's git repository on GitLab.

```bash
# Log in to GitLab and navigate to Projects → New Project
# Or use GitLab CLI (if available)
# Example: gitlab.local/tenants/monkeyKing-audio.git
```

**Requirements:**
- Repository name matches project slug (e.g., `monkeyKing-audio`)
- Visibility: Internal or Private
- Initialize with .gitignore (Node.js template recommended)
- Do NOT initialize with README or LICENSE (we'll provide a template)

**Verify:**
```bash
git ls-remote gitlab.local/tenants/monkeyKing-audio.git HEAD
# Should return the commit hash (or error if repo doesn't exist)
```

### Step 2: Clone Repository to Filesystem

**Goal:** Create the project root directory and clone the tenant's repository.

```bash
PROJECT_SLUG="monkeyKing-audio"
GIT_REPO_URL="gitlab.local/tenants/${PROJECT_SLUG}.git"
PROJECT_ROOT="/data/code/${PROJECT_SLUG}"

# Create project root (must not exist yet)
mkdir -p "${PROJECT_ROOT}"

# Clone the repository
git clone "${GIT_REPO_URL}" "${PROJECT_ROOT}"

# Verify clone succeeded
ls -la "${PROJECT_ROOT}/.git"
```

**Expected output:**
```
/data/code/monkeyKing-audio/
├── .git/
├── .gitignore
└── README.md (if initialized with template)
```

### Step 3: Create Worktree

**Goal:** Set up the primary working directory as a git worktree.

```bash
PROJECT_SLUG="monkeyKing-audio"
PROJECT_ROOT="/data/code/${PROJECT_SLUG}"
GIT_DEFAULT_BRANCH="main"

# Create worktree in the standard location
git -C "${PROJECT_ROOT}" worktree add worktree "${GIT_DEFAULT_BRANCH}"

# Verify worktree creation
ls -la "${PROJECT_ROOT}/worktree/.git"
git -C "${PROJECT_ROOT}/worktree" status
```

**Expected output:**
```
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

**Troubleshooting - "worktree already exists":**
```bash
# Remove stale worktree entry if it exists
git -C "${PROJECT_ROOT}" worktree repair
# Then retry the `worktree add` command
```

### Step 4: Update Registry

**Goal:** Register the tenant in the control-plane project registry with git and worktree configuration.

```bash
PROJECT_SLUG="monkeyKing-audio"
GIT_REPO_URL="gitlab.local/tenants/monkeyKing-audio.git"
GIT_DEFAULT_BRANCH="main"
WORKTREE_ROOT="/data/code/monkeyKing-audio/worktree"

# Connect to the control plane database
psql -h 127.0.0.1 -p 5432 -U admin -d agenthive

# Update the existing project row
UPDATE roadmap.project
SET git_repo_url = '${GIT_REPO_URL}',
    git_default_branch = '${GIT_DEFAULT_BRANCH}',
    worktree_root = '${WORKTREE_ROOT}'
WHERE slug = '${PROJECT_SLUG}';

-- Verify the update
SELECT project_id, slug, git_repo_url, git_default_branch, worktree_root
FROM roadmap.project
WHERE slug = '${PROJECT_SLUG}';
```

**Expected output:**
```
 project_id |       slug       |                    git_repo_url                    | git_default_branch |                worktree_root
------------+------------------+----------------------------------------------------+--------------------+------------------------------------------------
         12 | monkeyKing-audio | gitlab.local/tenants/monkeyKing-audio.git | main               | /data/code/monkeyKing-audio/worktree
(1 row)
```

### Step 5: Verify Setup with Health Check

**Goal:** Validate that the registry, worktree, and git configuration are correct.

```bash
PROJECT_ID="12"  # From the UPDATE query above

# Run health check via MCP
# (This requires the mcp_ops tool to be available)
# curl -X POST http://localhost:6421/mcp \
#   -H "Content-Type: application/json" \
#   -d '{"action":"health_check","project_id":"'${PROJECT_ID}'"}'

# Or manually verify the setup:
WORKTREE_ROOT="/data/code/monkeyKing-audio/worktree"

# Check worktree exists
test -d "${WORKTREE_ROOT}" && echo "✓ Worktree exists"

# Check .git is present
test -e "${WORKTREE_ROOT}/.git" && echo "✓ .git found"

# Check git status works
git -C "${WORKTREE_ROOT}" status > /dev/null && echo "✓ Git status succeeds"

# Check git log works
git -C "${WORKTREE_ROOT}" log --oneline -1 && echo "✓ Git history accessible"
```

**Expected output:**
```
✓ Worktree exists
✓ .git found
✓ Git status succeeds
✓ git worktree at /data/code/monkeyKing-audio/worktree on main
```

## Idempotent Repair

If any step fails or needs to be repeated, use the repair procedure:

### Scenario: Worktree is Corrupted

```bash
PROJECT_SLUG="monkeyKing-audio"
PROJECT_ROOT="/data/code/${PROJECT_SLUG}"

# Repair the worktree registry
git -C "${PROJECT_ROOT}" worktree repair

# Verify repair succeeded
git -C "${PROJECT_ROOT}" worktree list
```

### Scenario: Registry Entry is Missing or Incorrect

```bash
# Re-run Step 4 (Update Registry) with correct values
psql -h 127.0.0.1 -p 5432 -U admin -d agenthive

UPDATE roadmap.project
SET git_repo_url = 'gitlab.local/tenants/monkeyKing-audio.git',
    git_default_branch = 'main',
    worktree_root = '/data/code/monkeyKing-audio/worktree'
WHERE slug = 'monkeyKing-audio';
```

### Scenario: Worktree Directory Lost or Corrupted

```bash
PROJECT_SLUG="monkeyKing-audio"
PROJECT_ROOT="/data/code/${PROJECT_SLUG}"
GIT_DEFAULT_BRANCH="main"

# Remove corrupted worktree
git -C "${PROJECT_ROOT}" worktree prune

# Recreate worktree
git -C "${PROJECT_ROOT}" worktree add worktree "${GIT_DEFAULT_BRANCH}"

# Verify
git -C "${PROJECT_ROOT}/worktree" status
```

## Full Provisioning Script (Bash)

Use this script to automate the entire provisioning process:

```bash
#!/bin/bash
set -e

PROJECT_SLUG="${1:-monkeyKing-audio}"
GIT_REPO_URL="gitlab.local/tenants/${PROJECT_SLUG}.git"
PROJECT_ROOT="/data/code/${PROJECT_SLUG}"
WORKTREE_ROOT="${PROJECT_ROOT}/worktree"
GIT_DEFAULT_BRANCH="main"

echo "=== Provisioning Tenant: ${PROJECT_SLUG} ==="

# Step 1: Clone repository
echo "Step 1: Cloning repository from ${GIT_REPO_URL}..."
if [ -d "${PROJECT_ROOT}" ]; then
  echo "  ERROR: ${PROJECT_ROOT} already exists. Remove it first:"
  echo "  rm -rf ${PROJECT_ROOT}"
  exit 1
fi
mkdir -p "${PROJECT_ROOT}"
git clone "${GIT_REPO_URL}" "${PROJECT_ROOT}"
echo "  ✓ Repository cloned"

# Step 2: Create worktree
echo "Step 2: Creating worktree at ${WORKTREE_ROOT}..."
git -C "${PROJECT_ROOT}" worktree add worktree "${GIT_DEFAULT_BRANCH}"
echo "  ✓ Worktree created"

# Step 3: Update registry
echo "Step 3: Updating registry..."
psql -h 127.0.0.1 -p 5432 -U admin -d agenthive << SQL
UPDATE roadmap.project
SET git_repo_url = '${GIT_REPO_URL}',
    git_default_branch = '${GIT_DEFAULT_BRANCH}',
    worktree_root = '${WORKTREE_ROOT}'
WHERE slug = '${PROJECT_SLUG}';
SQL
echo "  ✓ Registry updated"

# Step 4: Verify setup
echo "Step 4: Verifying setup..."
test -d "${WORKTREE_ROOT}" && echo "  ✓ Worktree directory exists"
test -e "${WORKTREE_ROOT}/.git" && echo "  ✓ .git present"
git -C "${WORKTREE_ROOT}" status > /dev/null && echo "  ✓ Git status works"

echo "=== Provisioning Complete ==="
echo "Project slug: ${PROJECT_SLUG}"
echo "Repository:   ${GIT_REPO_URL}"
echo "Worktree:     ${WORKTREE_ROOT}"
```

**Usage:**
```bash
chmod +x provision-tenant.sh
./provision-tenant.sh monkeyKing-audio
```

## Post-Provisioning Steps

After successful provisioning:

1. **Initialize tenant codebase:** Copy `.gitlab-ci.yml` and `package.json` templates to worktree
2. **Test agent dispatch:** Spawn an agent with `project_id=<tenant>` and verify CWD is the worktree
3. **Document tenant:** Add entry to project dashboard with provisioning date and admin contact

## Troubleshooting

### Error: "Repository not found"

- Verify GitLab repository exists: `git ls-remote ${GIT_REPO_URL}`
- Check SSH/HTTPS credentials are configured
- Ensure you have permission to clone the repository

### Error: "worktree already exists"

- Run `git -C ${PROJECT_ROOT} worktree repair` to clean up stale entries
- Remove the directory if it exists: `rm -rf ${PROJECT_ROOT}/worktree`
- Retry the `worktree add` command

### Error: "fatal: multiple working trees found"

- List worktrees: `git -C ${PROJECT_ROOT} worktree list`
- Remove stale entries: `git -C ${PROJECT_ROOT} worktree prune`

### Error: "permission denied" on registry update

- Verify you have Postgres credentials with INSERT/UPDATE on `roadmap.project`
- Check PGHOST, PGPORT, PGUSER environment variables
- Try connecting manually: `psql -h 127.0.0.1 -U admin -d agenthive`

## References

- **P516:** Per-project git repo separation (architecture & design)
- **P518:** Automated tenant provisioning (future; will automate these steps)
- **Git Worktrees:** https://git-scm.com/docs/git-worktree
- **GitLab Documentation:** https://docs.gitlab.com/ee/
