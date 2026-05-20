-- Perf: Optimize TUI chat query by channel
-- Query: SELECT ... FROM roadmap.message_ledger
--        WHERE channel = $1 ORDER BY created_at DESC LIMIT 100
-- Before: 9ms (SeqScan 9451 rows, filters by channel)
-- This index is used by cockpit, chat, and headlines views that filter by channel.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_channel_created
ON roadmap.message_ledger (channel, created_at DESC)
WHERE channel IS NOT NULL;
