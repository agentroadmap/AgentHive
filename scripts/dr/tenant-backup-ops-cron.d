# AgentHive tenant DB ops bundle (P509)
# Append this block to /etc/cron.d/agenthive-reporting on the production host.
# The production host should source the shared env file and run the repo scripts directly.
#
# Variables expected from /etc/agenthive/env:
#   PGHOST, PGPORT, PGUSER, PGDATABASE, BACKUP_ROOT
#   NODE_EXPORTER_TEXTFILE_DIR

# Daily logical backup (03:15 local host time)
15 3 * * * agenthive . /etc/agenthive/env && bash /data/code/AgentHive/scripts/dr/agenthive-tenant-backup.sh agenthive >> /home/xiaomi/.hermes/cron/output/tenant-backup-agenthive-cron.log 2>&1

# Monthly restore validation (1st day, 02:00)
0 2 1 * * agenthive . /etc/agenthive/env && bash /data/code/AgentHive/scripts/dr/agenthive-restore-test.sh agenthive >> /home/xiaomi/.hermes/cron/output/tenant-restore-agenthive-cron.log 2>&1

# Daily retention prune and disk-cap enforcement (05:00)
0 5 * * * agenthive . /etc/agenthive/env && bash /data/code/AgentHive/scripts/dr/agenthive-retention-prune.sh agenthive >> /home/xiaomi/.hermes/cron/output/tenant-retention-agenthive-cron.log 2>&1
