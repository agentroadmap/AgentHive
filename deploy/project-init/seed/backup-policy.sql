-- Idempotent seed: default backup policy for this project tenant.
-- Runs after 000-schema.sql registers the project in core.project.
INSERT INTO core.tenant_backup_policy (project_id, schedule_cron, retention_days, target_uri_prefix, backup_kind)
SELECT id, '0 3 * * *', 30, 'file:///var/backups/agenthive', 'full'
FROM core.project
WHERE schema_name = :'schema_name'
ON CONFLICT DO NOTHING;
