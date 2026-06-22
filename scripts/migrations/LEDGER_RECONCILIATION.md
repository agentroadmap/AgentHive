# Migration Ledger Reconciliation (P4664)

> Canonical ledger = `roadmap.schema_migration` (live writer, written only via `scripts/migrate.ts`).
> Canonical dir = `scripts/migrations/`. `roadmap.migration_history` is RETIRED (locked read-only, migration 317).
> `database/migrations/` is LEGACY — the active runner never applies it.

**Classification vocabulary:** `applied` · `operator-gated` · `rollback` · `superseded` · `skipped` · `never-applied`.

- **applied** — ledgered in `schema_migration`, checksum matches on-disk.
- **operator-gated** — present on disk but intentionally deferred (activation requires an operator step: apply-in-window / seed grants / enable flag).
- **rollback** — inverse script; shares a prefix with its parent by design; never forward-applied.
- **superseded** — re-delivered by a later ledgered migration; retained for history (`.SUPERSEDED.sql`).
- **skipped** — lives in the LEGACY `database/migrations/` dir; never executed by the active runner.
- **never-applied** — on disk in the active dir but not in `schema_migration` (pre-existing ledger gap, to apply via `migrate.ts` or baseline).

## A. Active dir — `scripts/migrations/*.sql` (393 files)

| File | Class | In schema_migration | Notes |
|---|---|---|---|
| `002-rfc-workflow-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `003-dependency-columns-fix.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `003-rfc-state-machine.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `003-rfc-workflow.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `004-multi-template-workflow.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `004-workflow-multi-template-support.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `005-trigger-fix.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `006-autonomous-pipeline.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `007-agent-security-roles.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `008-create-agent-users.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `009-roadmap-schema-grants.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `010-fix-proposal-type-config-timestamp.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `011-maturity-sync-trigger.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `012-maturity-redesign.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `013-gate-pipeline-wiring.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `014-token-efficiency-metrics.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `015-cubic-orchestration.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `016-pulse-fleet-observability.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `017-worktree-merge-log.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `018-agent-registry-crypto-identity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `019-rename-proposal-columns.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `020-effective-blocking-view.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `020-fix-gate-pipeline.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `021-documents-messaging-protocol.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `022-schema-grants-agent-users.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `023-gate-decision-log-schema-fix.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `024-p191-daily-efficiency-views.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `025-model-registry-routes.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `026-model-routes-endpoints.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `027-extended-model-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `028-budget-guardrails.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `029-transition-queue-completion-guard.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `030-enqueue-transition-notify-queue-id.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `031-p235-codex-gate-executor-route.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `032-transition-queue-communication-states.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `033-implicit-maturity-gating.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `034-model-pricing-per-million.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `035-v-proposal-activity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `036-v-capable-agents-extended.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `037-hardening-leak-guard-and-lease-ttl.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `037-identity-sequence-realign.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `038-p281-offer-claim-lease.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `038-p281-resource-hierarchy.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `039-p281-claim-renew-reap-functions.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `040-p290-gate-enforcement.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `041-p289-agency-worker-separation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `041-proposal-detail-view.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `042-discord-feed-state-maturity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `043-p309-blocked-dispatch-cleanup.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `044-enriched-workflow-stages.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `045-p209-trust-enforcement.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `046-p409-fn-sync-proposal-maturity-complete-guard.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `047-p457-context-prefix-reconcile.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `048-p460-fn-spawn-workflow-guard.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `049-p409b-maturity-text-assignment-fix.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `050-p482-phase1-project-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `051-p482-phase2-project-id-propagation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `052-p483-phase1-project-repair-queue.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `053-p484-phase1-allowlist-tables.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `054-p476-verdict-vocabulary-widen.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `055-p447-cubic-worktree-canonical-root.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `056-p450-cli-builder-fallback-audit.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `057-p459-cubic-phase-roles.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `058-p459-cubics-unique-constraint.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `058-p472-principal-identity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `058-p495-tenant-saga-bootstrap.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `058-p602-cross-project-dependency.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `059-p604-observability-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `059-p611-gate-decision-auto-advance.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `060-p047-knowledge-embedding.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `060-p159-backfill-agent-public-key.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `060-p604-observability-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `060-p606-efficiency-rollup-tables.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `061-p437-dispatch-idempotency.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `061-p594-agency-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `061-p599-tool-catalog.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `062-p594-agency-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `062-p674-notification-router.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `063-p675-schema-drift-seen.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `064-p188-directive-type.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `064-p689-circuit-breaker-autorecover.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `065-p289-provider-registry-enhancements.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `065-p686-create-liaison-poke-attempt.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `065-p689-route-seed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `066-p436-control-plane-schema-reconcile.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `066-p444-host-provider-route-separation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `066-p704-lease-maturity-triggers.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `067-p438-claim-policy-fail-closed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `067-p676-pg-role-decomposition.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `067-p676-rollback.sql` | rollback | yes | rollback script colocated in active dir; never forward-applied |
| `067-p704-hotfix-3-stage-gates.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `068-p440-dispatch-retry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `068-p704-collapse-noop-maturity-audit.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `069-p704-hotfix-gate-ready-notify.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `070-p598-template-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `070-p741-lease-release-and-notify-suppression.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `070-p741-rollback.sql` | rollback | yes | rollback script colocated in active dir; never forward-applied |
| `071-p441-service-topology-ownership.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `071-p721-rate-limit-classification.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `072-p442-operator-stop-controls.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `073-p444-run-record-separation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `081-p706c0-hotpath-functions.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `081-p706c0-rollback.sql` | rollback | yes | rollback script colocated in active dir; never forward-applied |
| `082-p-proposal-history.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `083-proposal-version-trigger.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `084-p602-cross-project-dependency.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `085-p471-program-phases.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `086-p602-cross-project-dependency.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `087-p758-tenant-db-url.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `088-p760-project-capacity-config.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `089-p761-agency-liveness-states.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `090-p763-spawn-failure-counter.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `091-p764-agency-in-flight-view.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `092-p748-agent-role-profile.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `093-p758-fix-project-columns.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `094-p770-route-token-budget.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `095-p602-cross-project-dependency.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `096-p771-agency-route-policy.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `097-p772-route-decision-log.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `098-p773-route-cooldown.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `099-p753-retire-transition-queue-write-path.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `100-p833-a2a-messaging-foundation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `101-p843-auth-decision-log.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `102-p846-operator-notify-trigger.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `103-p844-pool-identity-gating.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `104-p846-fix-channel-constraint.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `105-p842-budget-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `106-p835-timeout-escalated-at.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `116-p299a-drop-fn-claim-overload.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `117-p299a-restore-max-concurrent-claims.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `118-p753-drop-transition-queue.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `119-p888-a2a-notify-deploy.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `119-p915-tighten-dispatchable-threshold.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `120-p753-drop-orphan-transition-queue-functions.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `120-p907-message-ledger-thread-id.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `120-p933-agent-display-label-view.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `121-p919-display-alias.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `122-p921-agency-session-uniqueness.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `123-p922-host-id-on-liaison-message.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `124-p923-external-routing.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `125-p924-session-metadata.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `126-p923-add-external-proxy-trust-tier.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `127-p914-fn-claim-work-offer-fix-mr-provider.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `127-p928-agent-registry-route-binding.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `128-p934-lease-release-deterministic-mapping.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `129-p934-release-reason-backfill-and-check.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `130-p907-message-ledger-thread-id.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `131-p907-message-ledger-schema-enforcement.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `132-p993-liaison-task-tracker.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `133-p1000-display-id-four-digit-hotfix.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `133-p434-provider-budget-governance.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `133-p994-message-ledger-task-types.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `134-p304-transport-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `134-p499-pgbouncer-config.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `134-p765-offline-alert-tracking.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `134-p995-named-agents-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `135-fix-proposal-display-id.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `135-p304-transport-registry-trigger.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `135-p915-tighten-dispatchable-threshold.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `135-p997-proposal-mapping-artifact.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `136-p1004-agent-usage-snapshot.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `136-p1093-agent-registry-reaper.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `136-p304-notification-dlq.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `136-p765-agency-offline-alert.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `136-p900-escalation-failure-count.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `137-p1005-task-tier-routing.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `137-p1093-registry-backfill.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `137-p933-v-agent-display-label.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `138-p1006-model-capability-profile.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `138-p1093-registry-reaper.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `139-p748-agent-role-profile.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `140-p908-squad-dispatch-provider-signal.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `140-registry-cleanup-ephemeral-workers.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `141-p1017-prune-heartbeat-rows.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `141-p997-proposal-legacy-mapping.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `142-fix-gate3-expiry-and-resolver-ordering.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `142-p1017-user-identity-seed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `143-fix-agency-in-flight-view-for-liaisons.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `143-p1017-message-ack-table.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `144-fix-liaison-sequence-atomicity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `144-p1017-room-acl-trigger.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `145-exclude-complete-from-mature-queue.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `145-p1003-architecture-rfc-workflow.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `146-p194-memory-tables.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `146-p441-service-registry-seed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `146-p516-project-git-fields.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `147-p182-team-governance-bugfix.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `147-p499-pgbouncer-config.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `148-p159-backfill-agent-public-key.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `148-p996-gemini-copilot-named-agents.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `149-fix-gemini-route-agent-cli.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `149-p901-template-alias.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `150-fix-v-agency-in-flight-stale-messages.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `150-p1017-unified-notify-channel.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `151-fn-return-work-offer.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `151-p932-backfill-display-alias.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `151-p932-backfill-worker-display-alias.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `152-fix-copilot-route-models.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `152-p1129-agency-registration.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `153-fix-lifecycle-identity-mismatch.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `153-p1017-ac26-migration-history-backfill.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `154-p1017-ac32-listener-subscription.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `155-p1017-ac26-migration-history-backfill.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `156-p1017-phase-a-archive-heartbeats.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `157-p1103-schema-version.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `158-p1103-message-type-taxonomy.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `159-p1104-presence-state-column.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `160-p1104-fn-pulse-and-view.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `161-p1105-user-seed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `162-p1106-room-membership.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `163-p1106-dead-letter-queue.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `164-p1107-listener-reconcile-fn.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `165-p1104-heartbeat-channel.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `166-p1104-heartbeat-channel-consolidation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `167-p1122-mtt-final-outcome.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `167-p798-model-tier-backfill.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `168-p1103-unified-message-bus-flag.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `168-p1121-pre-cutover-snapshot.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `169-p1093-agent-registry-reaper.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `169-p1103-unify-listen-channel.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `170-p1132-a2a-host-runtime-flags.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `170-p932-worker-alias-backfill.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `171-p1132-v-agency-status-presence-state.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `171-p159-backfill-agent-public-key.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `171-p469-agency-observability.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `172-p1138-drop-a2a-host-pg-reconnect-flag.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `172-p901-lease-maturity-actor.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `173-p159-backfill-agent-public-key.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `173-p707-ac-evidence-columns.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `173-task39-v-agency-status-pg-stat-activity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `174-p181-governance-amendment.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `174-p765-alert-sent-at.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `174-task40-runtime-flag-resolver-alignment.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `175-p1144-orchestrator-flag-seeds.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `175-p1291-proposal-role-pause.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `175-p1411-dispatchable-proposal-view.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `176-fix-agency-status-allow-offline.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `176-p230-team-memory-and-context-cache.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `177-fn-pulse-bridge-provider-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `177-p248-proposal-stage-dwell.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `178-fn-pulse-direct-agency-identity-match.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `178-p182-auto-charter-trigger.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `179-fn-claim-work-offer-coordinator-scope-bypass.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `179-p242-reeval-queue.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `180-p1129-preferred-provider-backfill.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `180-p1393-mature-queue-paused-filter.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `180-p248-proposal-stage-dwell.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `180-state-feed-discussion-events.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `181-p081-sla-contract.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `181-p1406-reaper-stamp-lease-expired.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `181-p404-scratch-space.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `182-p081-sla-contract.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `182-p1408-liaison-message-channel-rename.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `183-p1433-atomic-claim.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `184-p1434-failure-class.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `185-p1436-provider-truth.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `186-p1104-dispatchable-heartbeat-only.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `187-p1447-backfill-agency-from-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `188-p1435-c3-auth-model.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `189-p1440-c8-capability-mismatch-obstacle.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `189-p181-governance-amendment.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `190-p196-cubic-cleanup-audit.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `192-phase1-hot-inflight-cap.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `193-p1131-cluster-alarm.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `194-p468-liaison-message-log.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `195-p2404-coldwake-poke-liveness-guard.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `196-p1099-identity-canonicalization.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `196-p527-cubic-cleanup-reaper.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `197-p1100-rate-limiter.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `198-gate-advance-actor-attribution.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `199-p768-agency-route-policy-seed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `200-p516-per-project-repo-separation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `201-p926-umbrella-closeout-rule.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `202-p659-operator-gate-actions.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `203-p306-status-uppercase-constraint.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `204-gate-advance-note-author-attribution.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `204-p1385-agency-mcp-transport-auth.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `204-p196-cubic-state.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `205-p1003-architecture-rfc-workflow.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `206-p1351-parent-agency.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `207-p1352-agent-personality-validation.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `208-p2323-test-fixture-reaper.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `209-p188-directive-type.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `209-p2323-heartbeat-gated-status.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `211-p1729-convergence-guard.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `212-p674-notification-router.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `212-p778-gate-closure-verdicts.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `213-p720-activity-feed.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `215-p781-hotpath-shrink.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `216-p671-lease-split-verifier.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `217-p705-notification-inbox-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `221_token_capture_ledger.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `222-p1068-role-identity-registry.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `223-p1068-domain-fallback-matching.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `223-p1091-tiered-routing.sql` | never-applied | no | not ledgered; shares prefix 223 (documented historical collision in migration-prefix-exceptions.json) |
| `229-p747-route-token-budget.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `230-p1386-early-exit-predicate.sql` | never-applied | no | not ledgered; shares prefix 230 (documented historical collision in migration-prefix-exceptions.json) |
| `230-p747-control-model-schema.sql` | never-applied | no | not ledgered; shares prefix 230 (documented historical collision in migration-prefix-exceptions.json) |
| `231-p747-hivecentral-schema.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `232-p747-model-routes-extensions.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `233-p1018-ac13-extraction-failure-tracking.sql` | never-applied | no | not ledgered; shares prefix 233 (documented historical collision in migration-prefix-exceptions.json) |
| `233-p3000-agent-cost-quota.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `233-p3781-liaison-selfclaim-flags.sql` | never-applied | no | not ledgered; shares prefix 233 (documented historical collision in migration-prefix-exceptions.json) |
| `234-p1113-role-task-prompts.sql` | never-applied | no | not ledgered; shares prefix 234 (documented historical collision in migration-prefix-exceptions.json) |
| `234-p3508-operator-token-project-scope.sql` | never-applied | no | not ledgered; shares prefix 234 (documented historical collision in migration-prefix-exceptions.json) |
| `235-p1389-lease-metadata.sql` | never-applied | no | not ledgered; shares prefix 235 (documented historical collision in migration-prefix-exceptions.json) |
| `235-p3782-runtime-flag-category.sql` | never-applied | no | not ledgered; shares prefix 235 (documented historical collision in migration-prefix-exceptions.json) |
| `236-p2709-state-monitor-grace-period-flag.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `254-p1859-usage-probe-columns.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `255-p3782-config-category.sql` | never-applied | no | not ledgered; shares prefix 255 (documented historical collision in migration-prefix-exceptions.json) |
| `255-p932-ac8-backfill-display-alias.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `256-p1365-agency-capacity-reconcile.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `257-p1352-active-memory-importance.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `258-p1375-throttle-decision-message-type.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `259-p1356-personality-schema.sql` | never-applied | no | not ledgered; shares prefix 259 (documented historical collision in migration-prefix-exceptions.json) |
| `259-p1376-throttle-until-merged-view.sql` | never-applied | no | not ledgered; shares prefix 259 (documented historical collision in migration-prefix-exceptions.json) |
| `260-p1376-throttle-until-merged-view.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `261-p1367-agency-aliases-hyphen-variant.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `262-p1114-clearance-audit-columns.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `263-p1445-worktree-lease.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `264-p906-gate-advance-drop-bypass.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `265-p1129-preferred-provider-backfill.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `266-p2335-cubic-acquisition-dispatch.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `267-p1699-target-quota-pct-knob.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `268-p3312-route-decision-log-shadow-mode.sql` | never-applied | no | not ledgered; shares prefix 268 (documented historical collision in migration-prefix-exceptions.json) |
| `268-p3325-architecture-rfc-develop-merge-stages.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `269-p3311-premature-maturity-trigger.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `269-p3508-operator-token-scoped-project.sql` | never-applied | no | not ledgered; shares prefix 269 (documented historical collision in migration-prefix-exceptions.json) |
| `270-p3310-difficulty-signal.sql` | never-applied | no | not ledgered; shares prefix 270 (documented historical collision in migration-prefix-exceptions.json) |
| `270-p3566-gate-advance-authorization-integrity.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `271-p3311-reliability-ledger.sql` | never-applied | no | not ledgered; shares prefix 271 (documented historical collision in migration-prefix-exceptions.json) |
| `271-p3782-runtime-flag-category.sql` | never-applied | no | not ledgered; shares prefix 271 (documented historical collision in migration-prefix-exceptions.json) |
| `272-p3312-route-decision-log-shadow-mode.sql` | never-applied | no | not ledgered; shares prefix 272 (documented historical collision in migration-prefix-exceptions.json) |
| `272-p3781-flag-category-remap.sql` | never-applied | no | not ledgered; shares prefix 272 (documented historical collision in migration-prefix-exceptions.json) |
| `273-p3313-feedback-loop.sql` | never-applied | no | not ledgered; shares prefix 273 (documented historical collision in migration-prefix-exceptions.json) |
| `273-p3840-unified-dispatch-pool.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `274-p2496-retract-offers-on-complete.sql` | never-applied | no | not ledgered; shares prefix 274 (documented historical collision in migration-prefix-exceptions.json) |
| `274-p3311-gaps.sql` | never-applied | no | not ledgered; shares prefix 274 (documented historical collision in migration-prefix-exceptions.json) |
| `275-dispatchable-view-exclude-terminal.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `276-p3000-quota-foundation.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `277-p3000-quota-override.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `278-dispatchable-view-exclude-obsolete-maturity.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `279-p828-config-mutation-log.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `280-p2756-workflow-name-drift-fix.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `281-p1366-reap-return-worker-identity.sql` | never-applied | no | not ledgered; shares prefix 281 (documented historical collision in migration-prefix-exceptions.json) |
| `281-p1366-worker-identity-lifecycle.sql` | never-applied | no | not ledgered; shares prefix 281 (documented historical collision in migration-prefix-exceptions.json) |
| `282-p1107-listener-reconcile-fn-fix.sql` | never-applied | no | not ledgered; shares prefix 282 (documented historical collision in migration-prefix-exceptions.json) |
| `282-p1366-reap-return-worker-identity.sql` | never-applied | no | not ledgered; shares prefix 282 (documented historical collision in migration-prefix-exceptions.json) |
| `282-p3508-operator-token-project-scope.sql` | never-applied | no | not ledgered; shares prefix 282 (documented historical collision in migration-prefix-exceptions.json) |
| `283-p2997-stake-layer.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `283-p3535-monotonic-maturity-lifecycle.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `284-p1105-agent-token-key.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `285-p1456-session-credential-kind.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `286-p1028-post-review-schema.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `287-p1391-lease-ttl-structural-rollback.sql` | rollback | no | rollback script colocated in active dir; never forward-applied |
| `287-p1391-lease-ttl-structural.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `288-p3535-monotonic-maturity.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `289-p3566-gate-advance-integrity.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `290-p3535-active-sticky.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `291-p3563-gate-ac-invariant.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `292-p3563-legacy-unverified-audit.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `293-p1391-verdict-authority-rollback.sql` | rollback | no | rollback script colocated in active dir; never forward-applied |
| `293-p1391-verdict-authority.sql` | operator-gated | no | operator-gated: verdict-authority activation deferred (apply in window; seed grants; enable flag) — see MEMORY p1391 |
| `294-p3840-remove-auto-gating-roles.rollback.sql` | rollback | no | rollback script colocated in active dir; never forward-applied |
| `294-p3840-remove-auto-gating-roles.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `295-p3787-flag-seeds.sql` | never-applied | no | not ledgered; shares prefix 295 (documented historical collision in migration-prefix-exceptions.json) |
| `295-p3840-deliberate-gate-offers.rollback.sql` | rollback | no | rollback script colocated in active dir; never forward-applied |
| `295-p3840-deliberate-gate-offers.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `296-p3787-flag-seeds.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `296-p3795-provider-health-gate-flag.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `296-p3840-unified-dispatch-pool.sql` | never-applied | no | not ledgered; shares prefix 296 (documented historical collision in migration-prefix-exceptions.json) |
| `297-p3795-escalation-log-provider-health-gate.sql` | operator-gated | yes | operator-gated: provider-health routing gate, activation deferred (P3795) |
| `297-p3795-provider-health-gate-flag.sql` | operator-gated | yes | operator-gated: provider-health routing gate, activation deferred (P3795) |
| `298-p3566-gate-advance-integrity-audit.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `298-p3847-agent-run-briefing-id.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `299-p3929-drop-nonterminal-gate-bypass.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `300-p3847-spawn-no-progress-flag.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |
| `302-p1024-gate-decision-route.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `303-p4508-tenant-db-url-seed.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `304-p4625-ledger-unification.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `305-p1391-lease-lifecycle-views.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `306-p4668-transition-ledger-ddl.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `307-p4668-ledger-event-fk.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `308-p4668-extend-event-type-check.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `309-p4668-maturity-transitions-check.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `310-p4668-dual-write-shim.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `311-p4668-enforcement.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `312-p4668-break-glass.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `313-p4668-timeline-view.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `314-p4668-fn-idempotency-fix.sql` | applied | yes | ⚠ ledgered but checksum DRIFT vs on-disk |
| `315-p4668-state-reconstruction.sql` | applied | yes | ledgered in schema_migration; checksum matches |
| `316-p3566-gate-advance-authorization.SUPERSEDED.sql` | superseded | no | retained history; re-delivered by a later ledgered migration (see file header) |
| `317-p4664-lock-noncanonical-ledger.sql` | never-applied | no | not in schema_migration (pre-existing ledger gap / hand-applied DB) |

## B. Rollback dir — `scripts/migrations/rollback/*.sql` (13 files)

| File | Class | Notes |
|---|---|---|
| `299-p3929-rollback.sql` | rollback | inverse of parent; never forward-applied |
| `305-p1391-lease-lifecycle-views.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `306-p4668-transition-ledger-ddl.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `307-p4668-ledger-event-fk.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `308-p4668-extend-event-type-check.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `309-p4668-maturity-transitions-check.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `310-p4668-dual-write-shim.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `311-p4668-enforcement.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `312-p4668-break-glass.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `313-p4668-timeline-view.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `314-p4668-fn-idempotency-fix.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `315-p4668-state-reconstruction.rollback.sql` | rollback | inverse of parent; never forward-applied |
| `317-p4664-lock-noncanonical-ledger.rollback.sql` | rollback | inverse of parent; never forward-applied |

## C. Legacy dir — `database/migrations/*.sql` (123 files) — all SKIPPED

The active runner (`scripts/migrate.ts`) only reads `scripts/migrations/`. Every file below is **skipped** (never executed). Do not add new files here (CI guard fails the PR).

| File | Class | In migration_history | Notes |
|---|---|---|---|
| `039-model-routes-credential-control.sql` | skipped | no | legacy path |
| `040-model-routes-defaults-ratings.sql` | skipped | no | legacy path |
| `041-p224-transition-queue.sql` | skipped | no | legacy path |
| `042-p524-migration-history.sql` | skipped | no | legacy path |
| `043-p523-feature-flags.sql` | skipped | no | legacy path |
| `044-p525-error-catalog.sql` | skipped | no | legacy path |
| `045-p209-trust-enforcement.sql` | skipped | no | legacy path |
| `046-p464-liaison-spec.sql` | skipped | no | legacy path |
| `047-p468-liaison-messaging.sql` | skipped | no | legacy path |
| `048-p467-stuck-detection.sql` | skipped | no | legacy path |
| `049-p466-spawn-briefing.sql` | skipped | no | legacy path |
| `050-p463-heartbeat-notify.sql` | skipped | no | legacy path |
| `051-p251-poke-pong-liveness.sql` | skipped | no | legacy path |
| `052-provider-health-log.sql` | skipped | no | legacy path |
| `053-p439-concurrency-ceilings.sql` | skipped | no | legacy path |
| `053-p597-workforce-from-roadmap-workforce.sql` | skipped | no | legacy path |
| `053-p787-control-runtime-service.sql` | skipped | no | legacy path |
| `054-p774-workflow-vocab-unification.sql` | skipped | no | legacy path |
| `055-hivecentral-from-roadmap.sql` | skipped | no | legacy path |
| `055-p748-agent-role-profile.sql` | skipped | no | legacy path |
| `056-p767-project-route-policy.sql` | skipped | no | legacy path |
| `056-workforce-from-roadmap-workforce.sql` | skipped | no | legacy path |
| `057-p468-liaison-messaging.sql` | skipped | no | legacy path |
| `057-p768-agency-route-policy-seed.sql` | skipped | no | legacy path |
| `058-team-governance-p182.sql` | skipped | no | legacy path |
| `058-unified-config-spawn-control.sql` | skipped | no | legacy path |
| `059-p787-control-runtime-service.sql` | skipped | no | legacy path |
| `060-program-phases-p471.sql` | skipped | yes | legacy path |
| `063-p068-federation-schema.sql` | skipped | no | legacy path |
| `068-p440-dispatch-retry-terminal.sql` | skipped | no | legacy path |
| `071-p441-service-topology-ownership.sql` | skipped | no | legacy path |
| `096-a2a-message-notify.sql` | skipped | no | legacy path |
| `097-liaison-routes-through-a2a.sql` | skipped | no | legacy path |
| `098-fallback-playbook.sql` | skipped | no | legacy path |
| `099-lease-renewal.sql` | skipped | no | legacy path |
| `100-runaway-detection.sql` | skipped | yes | legacy path |
| `101-p833-a2a-message-envelope.sql` | skipped | no | legacy path |
| `102-p834-agent-secret.sql` | skipped | no | legacy path |
| `103-p836-cross-host-delivery.sql` | skipped | no | legacy path |
| `104-liaison-message-ledger-id.sql` | skipped | no | legacy path |
| `106-p781-function-rewrites.sql` | skipped | no | legacy path |
| `107-p843-principal-identity.sql` | skipped | no | legacy path |
| `108-p843-auth-decision-log.sql` | skipped | no | legacy path |
| `109-p844-pool-gating.sql` | skipped | no | legacy path |
| `110-p842-budget-enforcement.sql` | skipped | no | legacy path |
| `111-p484-agent-budget-ledger-project-id.sql` | skipped | no | legacy path |
| `112-p484-update-agent-budget-ledger-view.sql` | skipped | no | legacy path |
| `113-fix-message-timeout-tracking-reminder-sent-at.sql` | skipped | no | legacy path |
| `114-p748-seed-enhancer-role.sql` | skipped | no | legacy path |
| `115-p855-fix-fn-claim-work-offer-ambiguous-proposal-id.sql` | skipped | no | legacy path |
| `116-p856-allow-protocol-ping-pong-message-types.sql` | skipped | no | legacy path |
| `117-p772-route-decision-log.sql` | skipped | yes | legacy path |
| `118-p837-restore-liaison-message-type.sql` | skipped | no | legacy path |
| `119-p660-workflow-completed-at-backfill.sql` | skipped | no | legacy path |
| `120-p230-layered-memory.sql` | skipped | no | legacy path |
| `120-p404-scratch-space.sql` | skipped | no | legacy path |
| `120-p509-tenant-backup.sql` | skipped | no | legacy path |
| `120-p516-project-git-fields.sql` | skipped | no | legacy path |
| `121-p798-subscription-model-phase1.sql` | skipped | no | legacy path |
| `122-p997-proposal-migration-map.sql` | skipped | yes | legacy path |
| `122-p998-proposal-migration-map-seed.sql` | skipped | yes | legacy path |
| `123-p248-proposal-stage-dwell.sql` | skipped | no | legacy path |
| `123-p798-tier-backfill-o3-o4mini.sql` | skipped | no | legacy path |
| `123-p900-escalation-failure-count.sql` | skipped | no | legacy path |
| `123-p915-tighten-dispatchable-threshold.sql` | skipped | no | legacy path |
| `124-p765-offline-alert-tracking.sql` | skipped | no | legacy path |
| `125-p798-backfill-openai-tier.sql` | skipped | no | legacy path |
| `125-p908-squad-dispatch-provider-signal.sql` | skipped | no | legacy path |
| `126-p1106-dlq-target-host.sql` | skipped | no | legacy path |
| `126-p915-tighten-dispatchable-threshold.sql` | skipped | no | legacy path |
| `127-p1094-d4-gate-reviewer-role.sql` | skipped | yes | legacy path |
| `128-p798-backfill-o3-o4mini-tier.sql` | skipped | no | legacy path |
| `128-p995-doc-projection-views.sql` | skipped | yes | legacy path |
| `129-p182-backfill-standing-squad-charters.sql` | skipped | yes | legacy path |
| `129-p465-agency-capacity-config.sql` | skipped | no | legacy path |
| `129-p932-worker-alias-backfill.sql` | skipped | no | legacy path |
| `129-p933-v-agent-display-label.sql` | skipped | no | legacy path |
| `130-p765-liveness-alerting.sql` | skipped | no | legacy path |
| `131-p182-charter-backfill-and-default-norms.sql` | skipped | no | legacy path |
| `131-p248-board-columns-dwell.sql` | skipped | no | legacy path |
| `131-perf-message-ledger-headlines.sql` | skipped | no | legacy path |
| `132-p230-layered-memory-system.sql` | skipped | yes | legacy path |
| `132-p465-agency-capacity-config.sql` | skipped | no | legacy path |
| `132-perf-message-ledger-channel.sql` | skipped | no | legacy path |
| `133-p465-provider-capacity-defaults.sql` | skipped | no | legacy path |
| `133-perf-message-ledger-distinct-channels.sql` | skipped | no | legacy path |
| `135-p1105-user-message-type.sql` | skipped | no | legacy path |
| `135-p1105-user-principal-seed.sql` | skipped | no | legacy path |
| `137-p1144-runtime-flag-schema.sql` | skipped | yes | legacy path |
| `139-p1365-agency-capacity-tracking.sql` | skipped | yes | legacy path |
| `139-p404-agent-scratch-dirs.sql` | skipped | no | legacy path |
| `140-p081-sla-contract.sql` | skipped | no | legacy path |
| `140-p1386-architect-early-exit-predicate.sql` | skipped | no | legacy path |
| `141-p1104-presence-state-machine.sql` | skipped | no | legacy path |
| `141-p181-governance-amendment.sql` | skipped | yes | legacy path |
| `142-p230-layered-memory.sql` | skipped | no | legacy path |
| `142-p248-workflow-stages-is-active.sql` | skipped | no | legacy path |
| `143-p248-proposal-stage-dwell.sql` | skipped | no | legacy path |
| `144-p404-scratch-fn-fix.sql` | skipped | yes | legacy path |
| `145-p248-dwell-insert-seed.sql` | skipped | no | legacy path |
| `146-p433-dispatch-hardening.sql` | skipped | no | legacy path |
| `147-p1131-cluster-alarm.sql` | skipped | no | legacy path |
| `147-p304-transport-registry.sql` | skipped | no | legacy path |
| `148-p304-transport-registry-trigger.sql` | skipped | no | legacy path |
| `149-p304-notification-dlq.sql` | skipped | no | legacy path |
| `150-p435-control-feed.sql` | skipped | no | legacy path |
| `153-p469-agency-observability-views.sql` | skipped | no | legacy path |
| `220-p509-backup-disk-cap.sql` | skipped | no | legacy path |
| `250-p1124-merge-gate-e2e-validator.sql` | skipped | no | legacy path |
| `251-p1370-v-liaison-context.sql` | skipped | no | legacy path |
| `252-p1365-agency-capacity-columns.sql` | skipped | no | legacy path |
| `253-p-derived-maturity-live-lease.sql` | skipped | no | legacy path |
| `254-p1438-c6-a2a-verbs.sql` | skipped | no | legacy path |
| `254-p3310-difficulty-assessor.sql` | skipped | no | legacy path |
| `254-p3782-runtime-flag-category.sql` | skipped | no | legacy path |
| `256-p1456-credential-kind-delegated.sql` | skipped | no | legacy path |
| `256-p3326-gate-transition-drift-audit.sql` | skipped | no | legacy path |
| `257-p3782-runtime-flag-category.sql` | skipped | yes | legacy path |
| `258-p3787-flag-seeds.sql` | skipped | yes | legacy path |
| `269-p3313-route-decision-log-adaptive-columns.sql` | skipped | no | legacy path |
| `270-p3313-reliability-floor-config.sql` | skipped | no | legacy path |
| `271-p3313-route-class-override.sql` | skipped | no | legacy path |
| `272-p3326-fn-reconcile-proposal-type.sql` | skipped | no | legacy path |

## D. Ledger-only / orphan rows

### schema_migration rows with no matching active-dir file

| Filename (ledgered) | Notes |
|---|---|
| `139-p900-escalation-failure-count.sql` | ledgered but file absent on disk (renamed/removed) |
| `060-program-phases-p471.sql` | ledgered but file absent on disk (renamed/removed) |
| `117-p772-route-decision-log.sql` | ledgered but file absent on disk (renamed/removed) |
| `122-p997-proposal-migration-map.sql` | ledgered but file absent on disk (renamed/removed) |
| `127-p1094-d4-gate-reviewer-role.sql` | ledgered but file absent on disk (renamed/removed) |
| `122-p998-proposal-migration-map-seed.sql` | ledgered but file absent on disk (renamed/removed) |
| `128-p995-doc-projection-views.sql` | ledgered but file absent on disk (renamed/removed) |
| `059-p188-directive-proposal-type.sql` | ledgered but file absent on disk (renamed/removed) |
| `129-p182-backfill-standing-squad-charters.sql` | ledgered but file absent on disk (renamed/removed) |
| `136-p1131-cluster-alarm.sql` | ledgered but file absent on disk (renamed/removed) |
| `137-p1144-runtime-flag-schema.sql` | ledgered but file absent on disk (renamed/removed) |
| `138-p1144-orchestrator-flag-seeds.sql` | ledgered but file absent on disk (renamed/removed) |
| `139-p1365-agency-capacity-tracking.sql` | ledgered but file absent on disk (renamed/removed) |
| `141-p181-governance-amendment.sql` | ledgered but file absent on disk (renamed/removed) |
| `132-p230-layered-memory-system.sql` | ledgered but file absent on disk (renamed/removed) |
| `144-p404-scratch-fn-fix.sql` | ledgered but file absent on disk (renamed/removed) |
| `257-p3782-runtime-flag-category.sql` | ledgered but file absent on disk (renamed/removed) |
| `258-p3787-flag-seeds.sql` | ledgered but file absent on disk (renamed/removed) |
| `293-p3787-flag-seeds.sql` | ledgered but file absent on disk (renamed/removed) |
| `100-runaway-detection.sql` | ledgered but file absent on disk (renamed/removed) |
| `310-p1391-lease-preflight.sql` | ledgered but file absent on disk (renamed/removed) |

### migration_history rows (61) — RETIRED non-canonical ledger

| Filename | Status | Notes |
|---|---|---|
| `060-program-phases-p471.sql` | applied | informational only; table is locked read-only |
| `117-p772-route-decision-log.sql` | applied | informational only; table is locked read-only |
| `121-p919-display-alias.sql` | applied | informational only; table is locked read-only |
| `122-p997-proposal-migration-map.sql` | applied | informational only; table is locked read-only |
| `119-p888-a2a-notify-deploy.sql` | applied | informational only; table is locked read-only |
| `120-p907-message-ledger-thread-id.sql` | applied | informational only; table is locked read-only |
| `132-p993-liaison-task-tracker.sql` | applied | informational only; table is locked read-only |
| `127-p1094-d4-gate-reviewer-role.sql` | applied | informational only; table is locked read-only |
| `122-p998-proposal-migration-map-seed.sql` | applied | informational only; table is locked read-only |
| `128-p995-doc-projection-views.sql` | applied | informational only; table is locked read-only |
| `169-p1093-agent-registry-reaper.sql` | applied | informational only; table is locked read-only |
| `170-p1132-a2a-host-runtime-flags.sql` | applied | informational only; table is locked read-only |
| `171-p1132-v-agency-status-presence-state.sql` | applied | informational only; table is locked read-only |
| `172-p1138-drop-a2a-host-pg-reconnect-flag.sql` | applied | informational only; table is locked read-only |
| `168-p1103-unified-message-bus-flag.sql` | applied | informational only; table is locked read-only |
| `169-p1103-unify-listen-channel.sql` | applied | informational only; table is locked read-only |
| `173-task39-v-agency-status-pg-stat-activity.sql` | applied | informational only; table is locked read-only |
| `174-task40-runtime-flag-resolver-alignment.sql` | applied | informational only; table is locked read-only |
| `059-p188-directive-proposal-type.sql` | applied | informational only; table is locked read-only |
| `129-p182-backfill-standing-squad-charters.sql` | applied | informational only; table is locked read-only |
| `159-p1104-presence-state-column.sql` | applied | informational only; table is locked read-only |
| `160-p1104-fn-pulse-and-view.sql` | applied | informational only; table is locked read-only |
| `165-p1104-heartbeat-channel.sql` | applied | informational only; table is locked read-only |
| `166-p1104-heartbeat-channel-consolidation.sql` | applied | informational only; table is locked read-only |
| `136-p1131-cluster-alarm.sql` | applied | informational only; table is locked read-only |
| `137-p1144-runtime-flag-schema.sql` | applied | informational only; table is locked read-only |
| `138-p1144-orchestrator-flag-seeds.sql` | applied | informational only; table is locked read-only |
| `139-p1365-agency-capacity-tracking.sql` | applied | informational only; table is locked read-only |
| `181-p404-scratch-space.sql` | applied | informational only; table is locked read-only |
| `183-p1433-atomic-claim.sql` | applied | informational only; table is locked read-only |
| `184-p1434-failure-class.sql` | applied | informational only; table is locked read-only |
| `185-p1436-provider-truth.sql` | applied | informational only; table is locked read-only |
| `186-p1104-dispatchable-heartbeat-only.sql` | applied | informational only; table is locked read-only |
| `187-p1447-backfill-agency-from-registry.sql` | applied | informational only; table is locked read-only |
| `141-p181-governance-amendment.sql` | applied | informational only; table is locked read-only |
| `189-p181-governance-amendment.sql` | applied | informational only; table is locked read-only |
| `132-p230-layered-memory-system.sql` | applied | informational only; table is locked read-only |
| `144-p404-scratch-fn-fix.sql` | applied | informational only; table is locked read-only |
| `196-p1099-identity-canonicalization.sql` | applied | informational only; table is locked read-only |
| `268-p3325-architecture-rfc-develop-merge-stages.sql` | applied | informational only; table is locked read-only |
| `283-p2997-stake-layer.sql` | applied | informational only; table is locked read-only |
| `284-p1105-agent-token-key.sql` | applied | informational only; table is locked read-only |
| `285-p1456-session-credential-kind.sql` | applied | informational only; table is locked read-only |
| `286-p1028-post-review-schema.sql` | applied | informational only; table is locked read-only |
| `287-p1391-lease-ttl-structural.sql` | applied | informational only; table is locked read-only |
| `270-p3566-gate-advance-authorization-integrity.sql` | applied | informational only; table is locked read-only |
| `294-p3840-remove-auto-gating-roles.sql` | applied | informational only; table is locked read-only |
| `273-p3840-unified-dispatch-pool.sql` | applied | informational only; table is locked read-only |
| `257-p3782-runtime-flag-category.sql` | applied | informational only; table is locked read-only |
| `258-p3787-flag-seeds.sql` | applied | informational only; table is locked read-only |
| `293-p3787-flag-seeds.sql` | applied | informational only; table is locked read-only |
| `295-p3840-deliberate-gate-offers.sql` | applied | informational only; table is locked read-only |
| `296-p3787-flag-seeds.sql` | applied | informational only; table is locked read-only |
| `296-p3795-provider-health-gate-flag.sql` | applied | informational only; table is locked read-only |
| `297-p3795-provider-health-gate-flag.sql` | applied | informational only; table is locked read-only |
| `297-p3795-escalation-log-provider-health-gate.sql` | applied | informational only; table is locked read-only |
| `298-p3847-agent-run-briefing-id.sql` | applied | informational only; table is locked read-only |
| `298-p3566-gate-advance-integrity-audit.sql` | applied | informational only; table is locked read-only |
| `100-runaway-detection.sql` | applied | informational only; table is locked read-only |
| `302-p1024-gate-decision-route.sql` | applied | informational only; table is locked read-only |
| `303-p4508-tenant-db-url-seed.sql` | applied | informational only; table is locked read-only |

## E. Summary counts

| Class | Count |
|---|---|
| applied | 336 |
| never-applied | 46 |
| operator-gated | 3 |
| rollback | 20 |
| skipped | 123 |
| superseded | 1 |

### The 254 collision (the bug this prevents)

`254-p1859-usage-probe-columns.sql` was ledgered; `254-p3566-gate-advance-authorization.sql` shared prefix 254, was **never** ledgered, so its objects (`fn_has_unresolved_blocking`, `fn_actor_is_independent`) were only ad-hoc applied. P4664 renumbered it to `316-p3566-gate-advance-authorization.SUPERSEDED.sql` (its functionality was re-delivered by the ledgered 270/289/298-p3566 chain) and removed `254` from `migration-prefix-exceptions.json`. `npm run migrate:check` now blocks any future same-prefix/different-checksum collision.
