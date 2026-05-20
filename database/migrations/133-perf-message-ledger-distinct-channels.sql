-- Perf: Optimize "list channels" query for TUI chat initialization
-- Query: SELECT DISTINCT channel FROM roadmap.message_ledger
--        WHERE channel IS NOT NULL ORDER BY channel LIMIT 50
-- Before: 10.2ms (SeqScan with HashAggregate)
-- This partial index helps PG pre-filter to the 3826 non-NULL rows.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_channel_notnull
ON roadmap.message_ledger (channel)
WHERE channel IS NOT NULL;
