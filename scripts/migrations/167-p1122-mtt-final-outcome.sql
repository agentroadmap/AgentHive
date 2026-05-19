-- P1122: Add final_outcome column to message_timeout_tracking for DLQ terminal state tracking
-- Idempotent migration with ADD COLUMN IF NOT EXISTS pattern

DO $$
BEGIN
    -- Add final_outcome column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name = 'message_timeout_tracking'
          AND column_name = 'final_outcome'
    ) THEN
        ALTER TABLE roadmap.message_timeout_tracking
        ADD COLUMN final_outcome TEXT
            CHECK (final_outcome IN ('resolved', 'dead_lettered', 'expired', 'escalated_only'));

        RAISE NOTICE 'Added final_outcome column to message_timeout_tracking';
    ELSE
        RAISE NOTICE 'final_outcome column already exists on message_timeout_tracking';
    END IF;
END $$;
