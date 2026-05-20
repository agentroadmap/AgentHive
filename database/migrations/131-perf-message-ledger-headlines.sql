-- Perf: Optimize TUI headlines/system feed query
-- Query: SELECT ... FROM roadmap.message_ledger
--        WHERE from_agent LIKE 'system:%' OR message_type IN ('notify','liaison','task_status','task_complete','task_error')
--        ORDER BY created_at DESC LIMIT 50
-- Before: 9ms (SeqScan 9451 rows, filters to 148)
-- Strategy: Add partial index on message_type for common system notifications + add created_at DESC
-- This covers the message_type IN clause and allows index-driven ORDER BY.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_type_created
ON roadmap.message_ledger (message_type, created_at DESC)
WHERE message_type IN ('notify','liaison','task_status','task_complete','task_error');

-- Also add a partial index for from_agent LIKE 'system:%' (36 rows)
-- Using btree with text_pattern_ops for prefix matching
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_from_agent_system
ON roadmap.message_ledger (from_agent text_pattern_ops, created_at DESC)
WHERE from_agent LIKE 'system:%';
