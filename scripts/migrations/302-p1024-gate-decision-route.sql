-- P1024 AC-5/AC-9: seed notification_route for gate-decision Discord posts.
--
-- handleOperatorAdvance (src/apps/server/index.ts) now enqueues a
-- notification_queue row with kind='gate_decision' after a successful gate
-- advance. Without a matching route the NotificationRouter (P674) has no
-- transport to resolve and the row would fall to no-transport. This seed
-- routes gate decisions to Discord (P923 discord_webhook transport) with a
-- log_only backstop so the event is never lost if Discord is down.
--
-- NOT YET APPLIED to the live DB — committed on branch feat/p1024-feed-e2e for
-- operator review. Apply via the standard migration window, then ledger.

BEGIN;

INSERT INTO roadmap.notification_route (kind, severity_min, transport, target, notes)
VALUES
	('gate_decision', 'INFO', 'discord_webhook', NULL, 'P1024: operator gate advance — feed/Discord parity'),
	('gate_decision', 'INFO', 'log_only',        NULL, 'P1024: backstop — always log gate decisions even if Discord is down')
ON CONFLICT DO NOTHING;

COMMIT;
