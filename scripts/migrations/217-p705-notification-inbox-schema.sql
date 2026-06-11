-- P705: Correct notification_inbox schema for dashboard Phase 4
--
-- The in-app transport (src/core/notifications/transports/in-app.ts) creates
-- the table with `seen_at` (timestamptz), but P705 Phase 4 components expect
-- `seen` (boolean) for simpler client-side filtering.
--
-- This migration adds the `seen` boolean column (derived from `seen_at` if present,
-- defaulting to false for new rows), and optionally drops `seen_at` once fully migrated.

BEGIN;

-- 1. Add `seen` boolean column if it doesn't exist
ALTER TABLE IF EXISTS roadmap.notification_inbox
	ADD COLUMN IF NOT EXISTS seen boolean NOT NULL DEFAULT false;

-- 2. Populate `seen` from existing `seen_at` values (if the column exists)
-- This handles rows created by in-app transport before this migration
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema='roadmap' AND table_name='notification_inbox' AND column_name='seen_at'
	) THEN
		UPDATE roadmap.notification_inbox
		SET seen = (seen_at IS NOT NULL)
		WHERE seen IS FALSE;
	END IF;
END $$;

-- 3. Optional: If you want to fully migrate away from `seen_at`, drop it after verifying in production
-- For now, we keep it for backward compatibility with the in-app transport
-- ALTER TABLE roadmap.notification_inbox DROP COLUMN IF EXISTS seen_at;

-- 4. Create trigger for real-time updates via pg_notify (if not already present)
-- This allows the dashboard to receive live notification updates
CREATE OR REPLACE FUNCTION roadmap.notify_notification_inbox_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify(
		'notification_inbox_change',
		json_build_object(
			'id', COALESCE(NEW.id, OLD.id),
			'change_type', TG_OP,
			'seen', COALESCE(NEW.seen, OLD.seen)
		)::text
	);
	RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS notification_inbox_change ON roadmap.notification_inbox;
CREATE TRIGGER notification_inbox_change
	AFTER INSERT OR UPDATE ON roadmap.notification_inbox
	FOR EACH ROW
	EXECUTE FUNCTION roadmap.notify_notification_inbox_change();

COMMIT;
