1. MCP.md + ORCHESTRATION.md authoring: Author in parallel with GIT.md launch or defer to P-series proposal? (Scope blocks critical-path launches if deferred; recommend parallel authoring. Track as P1439 + P1440.)

2. CONVENTIONS.md §7 retirement timing: Merge GIT.md and retire §7 in same commit, or separate commit with operator notification? (Recommend: same commit, with 'retire(§7)' tag in message for audit trail.)

3. Codex shared-root exception policy: Document codex-one/codex-two as blessed exception for distributed merge ops in AGENTS.md, or enforce strict isolation for all agents? (Current reality: codex uses shared root; policy decision needed from operator. Recommend: document as exception with lease guardrail.)

4. Test fixture cleanup escalation: Auto-pause dispatch on cleanup failure, or log escalation + require manual operator intervention? (Current: no automation. Recommend: escalate to critical-queue for human review; don't auto-pause to avoid cascade failures.)

5. Parallel-dispatch manifest format: Keep simple tab-separated text, or define machine-parseable JSON/YAML + auto-generation tooling? (Recommend: tab-separated for now; JSON/YAML TBD in future ops tooling when scale hits 100+ parallel agents.)

6. Sub-agent post-dispatch audit automation: Auto-run by orchestrator immediately after all agents exit, or require gate agent to trigger manually? (Recommend: gate-triggered audit to prevent stale data between dispatch + audit window; manual enforcement of audit → escalation flow.)

7. Two-remote push ordering: Enforce gitlab-first with automatic rollback-to-gitlab-only logic, or keep as manual-fallback rule? (Current: manual fallback. Recommend: auto-retry with exponential backoff; if origin fails, log warning but don't block main advancement.)

8. Force-push communication protocol: Auto-trigger MCP message to tracking agents when force-push detected, or manual operator broadcast only? (Current: manual broadcast. Recommend: auto-message for transparency; operator can mute in escalation policy.)

9. Package.json stash enforcement: Pre-merge hook should warn agent if package.json not stashed, or document as best-practice only? (Recommend: document as best-practice + add tooling TODO to auto-detect merge-in-progress and warn.)

10. Terminal output auto-redirect: Should orchestrator auto-redirect long commands to /tmp files + Read-tool output, or educate agents manually in docs? (Recommend: educate manually in GIT.md + MCP.md docs; agent self-discipline preferred over infrastructure overhead.)