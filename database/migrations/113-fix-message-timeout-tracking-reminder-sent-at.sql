-- Fix: add reminder_sent_at column to roadmap.message_timeout_tracking
--
-- Migration 101 defined this column in CREATE TABLE IF NOT EXISTS, but the table
-- was already created by an earlier baseline without it. The timeout-cron.ts
-- references mtt.reminder_sent_at in its reminder query and UPDATE, causing
-- recurring TimeoutCron failures.

ALTER TABLE roadmap.message_timeout_tracking
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
