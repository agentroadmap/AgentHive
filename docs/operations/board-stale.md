> **Type:** reference  
> **MCP-tracked:** P1123  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P1123

# Board Stale Troubleshooting

The web board can stop refreshing if a long-running process accidentally ends the shared Postgres pool. P1123 guards long-running services by calling `setPoolLifecycleMode("long-running")` at startup, which ignores stray `pool.end()` calls and logs a warning.

## Symptoms

- The web board loads but stops reflecting proposal updates.
- Service logs mention `Cannot use a pool after calling end`.
- The watchdog emits `event_type='pool_poisoned'` on `control_feed` and `agent_lifecycle_events`; state-feed may forward it as an operator alert.

## Checks

```bash
journalctl -u agenthive-board.service -n 200 --no-pager | rg "pool.end|pool_poisoned|Cannot use a pool"
journalctl -u agenthive-state-feed.service -n 200 --no-pager | rg "pool_poisoned|Discord"
psql "$DATABASE_URL" -c "SELECT 1"
psql "$DATABASE_URL" -c "LISTEN control_feed"
```

To verify board push updates, open `http://localhost:6420`, then mutate a proposal timestamp:

```bash
psql "$DATABASE_URL" -c "UPDATE roadmap_proposal.proposal SET modified_at=now() WHERE display_id='P1018'"
```

The board should refresh without restarting the service. If it does not, restart `agenthive-board.service` and inspect the warning immediately before the refresh stopped.
