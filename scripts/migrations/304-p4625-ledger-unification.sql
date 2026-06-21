-- P4625: Select canonical migration ledger + reconcile split-brain
-- Canonical ledger: roadmap.schema_migration (migrate.ts writer)
-- Non-canonical:    roadmap.migration_history (converted to read-archive via trigger)
--
-- AC-1: trigger blocks direct INSERT/UPDATE/DELETE on migration_history
-- AC-3: pending_migration_classification table classifies all 70 snapshot-pending files
-- AC-4: backfills 17 files (applied via migration_history, on-disk, pending in schema_migration)
--       into schema_migration; verification query returns 0 mismatches after this runs.

BEGIN;

-- ── AC-1: Block direct writes to migration_history ────────────────────────────
-- migration_history is now a read-archive; all new tracking goes through schema_migration.

CREATE OR REPLACE FUNCTION roadmap.fn_migration_history_readonly()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'migration_history is read-only (P4625-AC-1). '
    'Use roadmap.schema_migration via migrate.ts for all migration tracking.';
END;
$$;

DROP TRIGGER IF EXISTS trg_migration_history_readonly ON roadmap.migration_history;
CREATE TRIGGER trg_migration_history_readonly
  BEFORE INSERT OR UPDATE OR DELETE ON roadmap.migration_history
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_migration_history_readonly();

-- ── AC-4: Backfill applied files from migration_history into schema_migration ──
-- These 17 files exist on disk AND were applied via migration_history (status=applied)
-- but were never recorded in schema_migration. Checksums are SHA-256 of current file content.
-- ON CONFLICT DO NOTHING: safe re-run if already recorded.

INSERT INTO roadmap.schema_migration (filename, checksum, applied_at, applied_by) VALUES
  ('268-p3325-architecture-rfc-develop-merge-stages.sql', '0719d8230e19020f20877c01e3fa38f1182c589828857b9bfaaa743aa75a2f31', '2026-06-14 22:41:17.437649+00', 'migration_history'),
  ('270-p3566-gate-advance-authorization-integrity.sql',  '597bba691c41c644932621910e48cffdf1e9f6779287b09aad4ae9b701c75eb4', '2026-06-16 06:08:34.674421+00', 'migration_history'),
  ('273-p3840-unified-dispatch-pool.sql',                 'f792a50f727ba8a932423ff8800b28f3f85e9397d45cf2e2d5efd5d8a8a377eb', '2026-06-17 06:03:26.510641+00', 'migration_history'),
  ('283-p2997-stake-layer.sql',                           '07513bbdd6fc92dfbac53e6e75c6de79f6d155b3434a11865944d85ebd516e38', NOW(),                           'migration_history'),
  ('284-p1105-agent-token-key.sql',                       '8c0a75997591df1ed07b1c7ee3d5fc389ea78fb48487f557145bc595778a0ad4', NOW(),                           'migration_history'),
  ('285-p1456-session-credential-kind.sql',               'bfeb9661830184f9ba992ab88460b8db2ebc6334f1a8fe7c0f3dda4b6e221ed2', NOW(),                           'migration_history'),
  ('286-p1028-post-review-schema.sql',                    '6ea5abb19fc3ffd341c2fefad0e9688f260ccd7daaa1c07aa0faeab059ed9960', NOW(),                           'migration_history'),
  ('287-p1391-lease-ttl-structural.sql',                  '13d233d0a1cca60bf1ad1530c5136f3d10b635e662fc563ff4aedfb1fdc58978', NOW(),                           'migration_history'),
  ('294-p3840-remove-auto-gating-roles.sql',              '12c057d9bfde4eb165601d401059c74d0466056a80fa71e58f529fa80920e9e5', NOW(),                           'migration_history'),
  ('295-p3840-deliberate-gate-offers.sql',                '61dd462983f8763286814058aea4c07fce8f698ae4e2c0423860afa82eb7858f', NOW(),                           'migration_history'),
  ('296-p3787-flag-seeds.sql',                            '2f98f3982f7799b4bf2ad7480227dd1bc27077659b4662f011599d3d7fe8178a', '2026-06-17 13:56:43.018378+00', 'migration_history'),
  ('296-p3795-provider-health-gate-flag.sql',             'b7aeb30867373ef292590127c240510b9d0b666f8e01f7185365661266dc36bb', NOW(),                           'migration_history'),
  ('297-p3795-escalation-log-provider-health-gate.sql',   'f46fef5c51aaf3d56ae1b12c2e40d6cce1f389ddc4bc5a585b690b90166fe3bd', '2026-06-17 20:21:24.206631+00', 'migration_history'),
  ('297-p3795-provider-health-gate-flag.sql',             '4cd68bb8d11c47a558685f203131619034519c7e4ef6b91e09a4f214199e96fa', '2026-06-17 20:19:31.163879+00', 'migration_history'),
  ('298-p3566-gate-advance-integrity-audit.sql',          '6878ba18a529d621a9d894de66599052343a71d76c7afef85e92d23a515110ba', '2026-06-18 02:50:26.778948+00', 'migration_history'),
  ('298-p3847-agent-run-briefing-id.sql',                 '6d1a75ad8250771000ac1ba36a77bf99d46c7038c63341ce3c9dea3e2ca732df', '2026-06-18 02:11:56.775687+00', 'migration_history'),
  ('302-p1024-gate-decision-route.sql',                   '360625b794204c83b1164d51cd56f6bc4e30c8720c9d0a67d3f9b10ebf52564a', '2026-06-19 17:46:09.184831+00', 'migration_history')
ON CONFLICT (filename) DO NOTHING;

-- ── AC-3: Classification table for pending migration snapshot ─────────────────
-- Captures the classification of all 70 files pending at P4625 snapshot.
-- Verification: SELECT count(*) FROM roadmap.pending_migration_classification WHERE classification IS NULL → 0

CREATE TABLE IF NOT EXISTS roadmap.pending_migration_classification (
  filename       TEXT        PRIMARY KEY,
  classification TEXT        NOT NULL CHECK (classification IN (
    'applied',         -- was in migration_history; backfilled into schema_migration above
    'operator-gated',  -- valid migration; requires operator sign-off before applying
    'rollback',        -- rollback/reversal script; not applied in forward direction
    'superseded',      -- prefix slot taken by a different applied migration; do not apply
    'skipped'          -- intentionally skipped (e.g. odd naming, absorbed by later work)
  )),
  reason         TEXT,
  classified_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO roadmap.pending_migration_classification (filename, classification, reason) VALUES
  -- Applied via migration_history; backfilled into schema_migration by this migration
  ('268-p3325-architecture-rfc-develop-merge-stages.sql', 'applied',        'Applied 2026-06-14 via migration_history; backfilled into schema_migration by P4625'),
  ('270-p3566-gate-advance-authorization-integrity.sql',  'applied',        'Applied 2026-06-16 via migration_history; backfilled into schema_migration by P4625'),
  ('273-p3840-unified-dispatch-pool.sql',                 'applied',        'Applied 2026-06-17 via migration_history; backfilled into schema_migration by P4625'),
  ('283-p2997-stake-layer.sql',                           'applied',        'Applied via migration_history (stake layer P2997); backfilled by P4625'),
  ('284-p1105-agent-token-key.sql',                       'applied',        'Applied via migration_history (agent token key P1105); backfilled by P4625'),
  ('285-p1456-session-credential-kind.sql',               'applied',        'Applied via migration_history (session credential kind P1456); backfilled by P4625'),
  ('286-p1028-post-review-schema.sql',                    'applied',        'Applied via migration_history (post-review schema P1028); backfilled by P4625'),
  ('287-p1391-lease-ttl-structural.sql',                  'applied',        'Applied via migration_history (lease TTL structural P1391); backfilled by P4625'),
  ('294-p3840-remove-auto-gating-roles.sql',              'applied',        'Applied via migration_history (remove auto-gating roles P3840); backfilled by P4625'),
  ('295-p3840-deliberate-gate-offers.sql',                'applied',        'Applied via migration_history (deliberate gate offers P3840); backfilled by P4625'),
  ('296-p3787-flag-seeds.sql',                            'applied',        'Applied 2026-06-17 via migration_history (flag seeds P3787); backfilled by P4625'),
  ('296-p3795-provider-health-gate-flag.sql',             'applied',        'Applied via migration_history (provider health gate flag P3795); backfilled by P4625'),
  ('297-p3795-escalation-log-provider-health-gate.sql',   'applied',        'Applied 2026-06-17 via migration_history (escalation log P3795); backfilled by P4625'),
  ('297-p3795-provider-health-gate-flag.sql',             'applied',        'Applied 2026-06-17 via migration_history (provider health gate flag v2 P3795); backfilled by P4625'),
  ('298-p3566-gate-advance-integrity-audit.sql',          'applied',        'Applied 2026-06-18 via migration_history (gate advance integrity audit P3566); backfilled by P4625'),
  ('298-p3847-agent-run-briefing-id.sql',                 'applied',        'Applied 2026-06-18 via migration_history (agent run briefing id P3847); backfilled by P4625'),
  ('302-p1024-gate-decision-route.sql',                   'applied',        'Applied 2026-06-19 via migration_history (gate decision route P1024); backfilled by P4625'),

  -- Rollback scripts: reversal-only, not applied in forward direction
  ('287-p1391-lease-ttl-structural-rollback.sql',         'rollback',       'Rollback script for 287-p1391-lease-ttl-structural.sql'),
  ('293-p1391-verdict-authority-rollback.sql',            'rollback',       'Rollback script for 293-p1391-verdict-authority.sql'),
  ('294-p3840-remove-auto-gating-roles.rollback.sql',     'rollback',       'Rollback script for 294-p3840-remove-auto-gating-roles.sql'),
  ('295-p3840-deliberate-gate-offers.rollback.sql',       'rollback',       'Rollback script for 295-p3840-deliberate-gate-offers.sql'),

  -- Superseded: numeric prefix occupied by a different applied migration; do not apply
  ('196-p527-cubic-cleanup-reaper.sql',                   'superseded',     'Prefix 196 occupied by applied 196-p1099-identity-canonicalization.sql (migration_history)'),
  ('223-p1091-tiered-routing.sql',                        'superseded',     'Prefix 223 occupied by applied 223-p1068-domain-fallback-matching.sql (migration_history)'),
  ('233-p1018-ac13-extraction-failure-tracking.sql',      'superseded',     'Prefix 233 occupied by applied 233-p3000-agent-cost-quota.sql (migration_history); prefix collision'),
  ('233-p3781-liaison-selfclaim-flags.sql',               'superseded',     'Prefix 233 occupied by applied 233-p3000-agent-cost-quota.sql (migration_history); prefix collision'),
  ('254-p3566-gate-advance-authorization.sql',            'superseded',     'Prefix 254 occupied by applied 254-p1859-usage-probe-columns.sql; DO NOT re-run (would revert P3929/mig299 gate-trigger fix per P4387 analysis)'),
  ('255-p3782-config-category.sql',                       'superseded',     'Prefix 255 occupied by applied 255-p932-ac8-backfill-display-alias.sql (migration_history)'),
  ('269-p3508-operator-token-scoped-project.sql',         'superseded',     'Prefix 269 occupied by applied 269-p3311-premature-maturity-trigger.sql (migration_history)'),

  -- Skipped: non-standard naming (underscore separator); content absorbed into later budget work
  ('221_token_capture_ledger.sql',                        'skipped',        'Non-standard naming (underscore, no proposal prefix). Token capture schema absorbed by P1018 agent_budget_ledger columns applied via later migrations.'),

  -- Operator-gated: valid pending migrations requiring explicit operator sign-off before apply
  ('229-p747-route-token-budget.sql',                     'operator-gated', 'Pending P747 route token budget schema; operator must sequence and apply'),
  ('230-p1386-early-exit-predicate.sql',                  'operator-gated', 'Pending P1386 early-exit predicate; operator must sequence and apply'),
  ('230-p747-control-model-schema.sql',                   'operator-gated', 'Pending P747 control model schema; shares prefix 230 with 230-p1386; operator must resolve prefix and apply'),
  ('231-p747-hivecentral-schema.sql',                     'operator-gated', 'Pending P747 hivecentral schema; operator must sequence and apply'),
  ('232-p747-model-routes-extensions.sql',                'operator-gated', 'Pending P747 model routes extensions; operator must sequence and apply'),
  ('234-p1113-role-task-prompts.sql',                     'operator-gated', 'Pending P1113 role/task prompts schema; operator must sequence and apply'),
  ('234-p3508-operator-token-project-scope.sql',          'operator-gated', 'Pending P3508 operator token project scope; shares prefix 234 with 234-p1113; operator must resolve and apply'),
  ('235-p1389-lease-metadata.sql',                        'operator-gated', 'Pending P1389 lease metadata; operator must sequence and apply'),
  ('235-p3782-runtime-flag-category.sql',                 'operator-gated', 'Pending P3782 runtime flag category; shares prefix 235; operator must resolve and apply'),
  ('236-p2709-state-monitor-grace-period-flag.sql',       'operator-gated', 'Pending P2709 state monitor grace-period flag; operator must apply'),
  ('259-p1356-personality-schema.sql',                    'operator-gated', 'Pending P1356 personality schema; operator must sequence and apply'),
  ('259-p1376-throttle-until-merged-view.sql',            'operator-gated', 'Pending P1376 throttle-until-merged view; shares prefix 259; operator must resolve and apply'),
  ('260-p1376-throttle-until-merged-view.sql',            'operator-gated', 'Pending P1376 throttle-until-merged view (duplicate at prefix 260); operator must resolve prefix collision and apply'),
  ('261-p1367-agency-aliases-hyphen-variant.sql',         'operator-gated', 'Pending P1367 agency aliases hyphen variant; operator must apply'),
  ('262-p1114-clearance-audit-columns.sql',               'operator-gated', 'Pending P1114 clearance audit columns; operator must apply'),
  ('263-p1445-worktree-lease.sql',                        'operator-gated', 'Pending P1445 worktree lease schema; operator must apply'),
  ('264-p906-gate-advance-drop-bypass.sql',               'operator-gated', 'Pending P906 gate-advance drop-bypass; operator must apply'),
  ('265-p1129-preferred-provider-backfill.sql',           'operator-gated', 'Pending P1129 preferred provider backfill; operator must apply'),
  ('266-p2335-cubic-acquisition-dispatch.sql',            'operator-gated', 'Pending P2335 cubic acquisition dispatch; operator must apply'),
  ('267-p1699-target-quota-pct-knob.sql',                 'operator-gated', 'Pending P1699 target quota pct knob; operator must apply'),
  ('268-p3312-route-decision-log-shadow-mode.sql',        'operator-gated', 'Pending P3312 route decision log shadow mode; shares prefix 268 with applied 268-p3325; operator must resolve and apply'),
  ('270-p3310-difficulty-signal.sql',                     'operator-gated', 'Pending P3310 difficulty signal; shares prefix 270 with applied 270-p3566; operator must resolve and apply'),
  ('271-p3311-reliability-ledger.sql',                    'operator-gated', 'Pending P3311 reliability ledger; operator must apply'),
  ('271-p3782-runtime-flag-category.sql',                 'operator-gated', 'Pending P3782 runtime flag category; shares prefix 271; operator must resolve and apply'),
  ('272-p3312-route-decision-log-shadow-mode.sql',        'operator-gated', 'Pending P3312 route decision log shadow mode (at prefix 272); operator must apply'),
  ('272-p3781-flag-category-remap.sql',                   'operator-gated', 'Pending P3781 flag category remap; shares prefix 272; operator must resolve and apply'),
  ('273-p3313-feedback-loop.sql',                         'operator-gated', 'Pending P3313 feedback loop; shares prefix 273 with applied 273-p3840; operator must resolve and apply'),
  ('274-p2496-retract-offers-on-complete.sql',            'operator-gated', 'Pending P2496 retract offers on complete; operator must apply'),
  ('274-p3311-gaps.sql',                                  'operator-gated', 'Pending P3311 gaps; shares prefix 274; operator must resolve and apply'),
  ('279-p828-config-mutation-log.sql',                    'operator-gated', 'Pending P828 config mutation log; operator must apply'),
  ('281-p1366-reap-return-worker-identity.sql',           'operator-gated', 'Pending P1366 reap return worker identity (prefix 281); operator must apply'),
  ('281-p1366-worker-identity-lifecycle.sql',             'operator-gated', 'Pending P1366 worker identity lifecycle; shares prefix 281; operator must resolve and apply'),
  ('282-p1107-listener-reconcile-fn-fix.sql',             'operator-gated', 'Pending P1107 listener reconcile fn fix; operator must apply'),
  ('282-p1366-reap-return-worker-identity.sql',           'operator-gated', 'Pending P1366 reap return worker identity (prefix 282); shares prefix with 282-p1107 and 282-p3508; operator must resolve and apply'),
  ('282-p3508-operator-token-project-scope.sql',          'operator-gated', 'Pending P3508 operator token project scope; shares prefix 282; operator must resolve and apply'),
  ('293-p1391-verdict-authority.sql',                     'operator-gated', 'Pending P1391 verdict authority; shares prefix 293 with rollback; operator must apply (flag-gated dormant feature)'),
  ('295-p3787-flag-seeds.sql',                            'operator-gated', 'Pending P3787 flag seeds (prefix 295); shares prefix with applied 295-p3840; operator must resolve and apply'),
  ('296-p3840-unified-dispatch-pool.sql',                 'operator-gated', 'Pending P3840 unified dispatch pool; shares prefix 296 with applied 296-p3787/296-p3795; operator must resolve and apply'),
  ('299-p3929-drop-nonterminal-gate-bypass.sql',          'operator-gated', 'Pending P3929 drop non-terminal gate bypass; operator must apply'),
  ('300-p3847-spawn-no-progress-flag.sql',                'operator-gated', 'Pending P3847 spawn no-progress flag; operator must apply'),
  ('301-p1391-review-round-and-stale-views.sql',          'operator-gated', 'Pending P1391 review round and stale views; operator must apply')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
