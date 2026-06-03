> **Type:** architecture | design note  
> **MCP-tracked:** P455 (Round 2 lane C: control-plane DB query module)  
> **Source-of-truth:** Postgres `roadmap.project`, `roadmap_proposal.proposal`, `control_runtime.cubic`

# CWD-Derived Context Resolution for `hive` CLI

**Purpose:** Normative specification for resolving project and agency context from the current working directory (`$CWD`) when explicit flags (`--project`, `--agency`) and environment variables (`HIVE_PROJECT`, `HIVE_AGENCY`) are not provided.

**Audience:** Backend Architect (implementer), Senior Dev (consuming the spec), MCP Builder (control-plane schema owner).

**Status:** Approved for implementation. Supersedes contract §5 "TODO" tag on CWD resolution.

---

## 1. Context Resolution Hierarchy

**Precedence (highest to lowest):**

1. **Explicit Flags** (`--project P`, `--agency A`, `--host H`) — always override.
2. **Environment Variables** (`HIVE_PROJECT`, `HIVE_AGENCY`, `HIVE_HOST`) — second priority.
3. **CWD-Derived Context** (this spec) — third priority.
4. **Control-Plane Default** (`roadmap_identity.human_user.default_project_id`, etc.) — fallback.
5. **Fail-fast** — if all four levels fail, exit code 2 (NOT_FOUND) with guidance.

This document specifies layer 3: CWD-derived context resolution.

---

## 2. Chosen Algorithm: Option B (Worktree-First with Git Fallback)

**Selected:** Option B (Database-backed project registry lookup) with deterministic fallback to Git worktree boundaries.

**Rationale:**
- **Single source of truth:** All project metadata lives in `roadmap.project.worktree_root`. Query once; don't parse multiple file formats.
- **Resilient:** Works in subdirectories (walk up from `$CWD` until a prefix match is found).
- **No file-system pollution:** Avoids `.hive/config.json` or `roadmap.yaml` overhead in every worktree.
- **Consistent with existing patterns:** Mirrors `src/apps/server/index.ts:resolveProjectScope()` which queries `roadmap.project` to resolve scope (contract §5, CONVENTIONS.md §8d).
- **Fail-safe:** Gracefully falls back to user guidance if no match is found.

---

## 3. Resolution Algorithm (Normative)

### 3.1 Input

- `$CWD`: current working directory (e.g., `/data/code/AgentHive/src/apps`)
- Access to control-plane database (`hiveCentral` in target; `agenthive` in transition state per CONVENTIONS.md §6.0)

### 3.2 Resolution Steps (in order; short-circuit on match)

**Step 1: Query `roadmap.project` for prefix match**

```sql
SELECT project_id, slug, name, worktree_root
  FROM roadmap.project
 WHERE status = 'active'
   AND $1 LIKE (worktree_root || '%')
   AND worktree_root IS NOT NULL
 ORDER BY LENGTH(worktree_root) DESC
 LIMIT 1
```

Where `$1 = $CWD`.

**If exactly one match found:** Use `project_id` and `slug` from the row. Stop.

**If no match found:** Continue to Step 2.

**If multiple matches** (edge case: prefix ambiguity; should not happen if worktree_root values are well-formed):
- Take the row with the longest `worktree_root` (deepest match wins).
- Log a warning: "Multiple projects matched CWD prefix; using deepest match: <slug>."

**Step 2: Check for `.hive/config.json` in git repository root**

- Call `git rev-parse --show-toplevel` from `$CWD`.
  - If not in a git repo, or git fails (return code non-zero), skip to Step 3.
  - If in a git repo, let `GIT_ROOT = <output>`.
- Check if `$GIT_ROOT/.hive/config.json` exists (readable).
  - If exists: Try to parse as JSON.
    - If parses and contains `project` field (string): use as slug to query `roadmap.project` by slug.
    - If parses and contains `agency` field (string): resolve agency identity separately (not this spec's scope; handled by agency resolver).
    - On parse error: Log warning "Invalid `.hive/config.json`; skipping." Continue to Step 3.
  - If does not exist: Continue to Step 3.

**Step 3: Check for `roadmap.yaml` in git repository root**

- (Requires git root from Step 2; if Step 2 was skipped, skip Step 3.)
- Check if `$GIT_ROOT/roadmap.yaml` exists (readable).
  - If exists: Try to parse as YAML.
    - If parses and contains `project:` field (string): use as slug to query `roadmap.project` by slug.
    - On parse error: Log warning "Invalid `roadmap.yaml`; skipping." Continue to Step 4.
  - If does not exist: Continue to Step 4.

**Step 4: Query `roadmap.project` for git repo URL match**

- (Requires git root from Step 2; if Step 2 was skipped, skip Step 4.)
- Extract the git remote URL: `git -C $GIT_ROOT config --get remote.origin.url` (or similar; handle variations like `git@host:...`, `https://...`).
- Normalize the URL (strip `.git` suffix if present; lowercase scheme).
- Query:
  ```sql
  SELECT project_id, slug, name
    FROM roadmap.project
   WHERE status = 'active'
     AND git_repo_url IS NOT NULL
     AND LOWER(git_repo_url) = LOWER($1)
   LIMIT 1
  ```
  Where `$1 = <normalized URL>`.
  - If match found: Use `project_id` and `slug`. Stop.

**Step 5: No context resolved from CWD**

- Return `null` for `projectId` and `projectSlug`.
- Caller will attempt fallback to control-plane default (layer 4) or fail-fast (layer 5).

### 3.3 Error Handling

**Database unreachable during any step:**
- Treat as REMOTE_FAILURE (exit code 5, retriable).
- Message: "Cannot resolve project context: database unreachable at <host>:<port>/<database>."
- Hint: "Run `hive doctor` to diagnose. Retrying may help."

**Ambiguous context (e.g., $CWD matches multiple worktree_root values with same length):**
- Log a warning and use the oldest `project_id` (tiebreaker by insertion order or creation timestamp).
- This should be rare if worktree_root values are unique (enforced by unique constraint).

**No project context found after all steps, and no env/flag override:**
- Exit code 2 (NOT_FOUND).
- Message: "Cannot resolve project context from `$CWD`, environment, or control-plane defaults."
- Hint: "Try one of: (1) Set `HIVE_PROJECT=<slug>` or `--project <slug>`; (2) Register `$CWD` in control plane (`hive project register`); (3) Create `.hive/config.json` in repo root with `{\"project\": \"<slug>\"}`."

---

## 4. Agency Resolution (Related, Not This Spec's Scope)

Agency context follows a similar pattern:
1. Explicit flag `--agency <identity>`
2. Environment variable `HIVE_AGENCY=<identity>`
3. CWD-derived: If `$CWD` is inside an active worktree (from `control_runtime.cubic`), use `cubic.agency_id` to resolve the agency. (Lane B's MCP Builder will implement the cubic lookup.)
4. Control-plane default: `roadmap_identity.human_user.default_agency_id` for the authenticated user.

This spec does not cover agency resolution in detail; the full contract (cli-hive-contract.md §5) is normative.

---

## 5. Edge Cases and Gotchas

### 5.1 Worktree Root Trailing Slashes

**Invariant:** `worktree_root` values in `roadmap.project` do **not** have trailing slashes (e.g., `/data/code/AgentHive`, not `/data/code/AgentHive/`).

**Matching logic:** Use `$CWD LIKE (worktree_root || '%')` to match `$CWD` as a prefix. This correctly handles subdirectories:
- `worktree_root = /data/code/AgentHive`
- `$CWD = /data/code/AgentHive/src/apps`
- Match: ✓ (because `src/apps` starts with `/`)

If `$CWD == worktree_root` exactly, it still matches (good).

### 5.2 Archived or Inactive Projects

**Invariant:** Only query `WHERE status = 'active'`. Archived projects are never returned.

### 5.3 No Database Access (Offline Mode)

AgentHive CLI assumes network access to the control-plane DB for mutations and reads (contract §6). CWD resolution that fails due to DB unreachability is treated as a retriable remote failure (exit code 5), not a usage error.

If the user has set `--project` or `HIVE_PROJECT`, CWD resolution is skipped entirely — no DB hit required.

### 5.4 Multiple Nested Worktrees

If `$CWD` matches multiple prefix entries (unlikely if worktree_root is unique), the deepest match wins:

```sql
ORDER BY LENGTH(worktree_root) DESC
```

Example:
- `/data/code/AgentHive` (worktree_root for project A)
- `/data/code/AgentHive/projects/audio-fork` (worktree_root for project B, a forked subtree)
- `$CWD = /data/code/AgentHive/projects/audio-fork/src`
- Result: Project B (deeper match)

This is intentional. Nested worktrees are **not** recommended in AgentHive architecture, but if they exist, the deepest match is safest.

### 5.5 Git Fallback When Not in a Worktree

If `$CWD` is inside a git repo that is **not** registered as a worktree (e.g., a user's personal fork with no entry in `roadmap.project`):
- Steps 2–4 attempt to read `.hive/config.json`, `roadmap.yaml`, or match by git remote URL.
- If none match, fall through to Step 5 (no context resolved).
- This is expected: unregistered repos don't have implicit project context.

---

## 6. Implementation Checklist for Backend Architect

**In `src/apps/hive-cli/common/control-plane-client.ts`:**

- [ ] Implement `resolveProjectFromCwd(cwd: string): Promise<ProjectRow | null>` method.
  - Query `roadmap.project` per §3.2 Step 1.
  - If no match, try git-based fallbacks (Steps 2–4) **iff** git is available.
  - Return `ProjectRow` if found; `null` if not.
  - Map DB errors to `HiveError` with code `remote-failure` and exit code 5.

- [ ] Validate that `ProjectRow` type includes: `project_id`, `slug`, `name`, `worktree_root`, `status`, `git_repo_url` (nullable).

- [ ] Write tests:
  - [ ] `resolveProjectFromCwd` with `$CWD` inside a registered worktree — returns correct project.
  - [ ] `resolveProjectFromCwd` with `$CWD` not in any worktree — returns null.
  - [ ] Git fallback: `resolveProjectFromCwd` with git repo matching `git_repo_url` — returns correct project.
  - [ ] DB unreachable — maps to `HiveError` with code `remote-failure`, exit code 5.

---

## 7. Future Evolution

**Out of scope for P455 Round 2:**
- Custom resolver plugins (git-style `hive-resolve-project`).
- Local cache of project registry (to support offline mode).
- Cross-project context (a single command spanning multiple projects).

**Potential future enhancements:**
- If many commands are run in quick succession, cache the resolved project for the session lifetime to avoid repeated DB queries. (Implement in `control-plane-client.ts` with TTL = session length.)
- Support `HIVE_PROJECT` env var with **glob patterns** for shortcuts (e.g., `HIVE_PROJECT=*audio*` → match the unique project with `audio` in its slug). (Requires more sophisticated glob matching; out of scope for v1.)

---

## References

- **Contract:** `docs/architecture/cli-hive-contract.md` §5 (Context Resolution Rules)
- **System ops design:** `docs/architecture/cli-hive-system-ops.md` (operator-facing commands)
- **DB topology:** `CONVENTIONS.md` §6 (Database Conventions, §6.0 for control-plane)
- **Existing precedent:** `src/apps/server/index.ts:resolveProjectScope()` (resolves project scope via `roadmap.project` query)
