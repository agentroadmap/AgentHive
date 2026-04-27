# AgentHive DR — weekly backup restore-test (P591 AC13)
# Append this block to /etc/cron.d/agenthive-reporting on the production host.
# Pattern matches existing cron jobs: source .hermes/.env, export vars, run script.

# Weekly backup restore-test (Sunday 02:00 UTC — quiet window)
0 2 * * 0 xiaomi . /home/xiaomi/.hermes/.env && export PGPASSWORD PG_USER PG_DATABASE S3_BUCKET S3_PREFIX LIVE_PG_HOST LIVE_PG_PORT && bash /data/code/AgentHive/scripts/dr/backup-restore-test.sh >> /home/xiaomi/.hermes/cron/output/backup-restore-test-cron.log 2>&1
