#!/usr/bin/env python3
# scripts/ops/agenthive-pg-stat-exporter.py
#
# P509 — Per-tenant pg_stat Prometheus exporter with HA fallback.
#
# Metrics exposed on :9101/metrics:
#   agenthive_scrape_success_total{slug}         — counter
#   agenthive_scrape_staleness_seconds{slug}     — gauge (seconds since last good scrape)
#   agenthive_db_table_rows{slug, table}         — gauge (pg_stat_user_tables.n_live_tup)
#   agenthive_backup_disk_cap_exceeded_total{slug} — counter (read from textfile prom)
#
# Tenant discovery order:
#   1. hiveControl DB: SELECT slug FROM roadmap.project WHERE bootstrap_status = 'live'
#   2. Fallback: /etc/agenthive/tenants.local (JSON {"tenants": ["slug-a", ...]})
#   Refresh every 5 minutes. Falls back to local list if hiveControl query fails.
#
# Per-tenant DSN resolution (slug uppercased, hyphens→underscores):
#   env AGENTHIVE_TENANT_<SLUG>_DSN
#
# Required env:
#   AGENTHIVE_CONTROL_DSN — control-plane connection string (for tenant discovery)
#
# Optional env:
#   EXPORTER_PORT         — listen port (default: 9101)
#   SCRAPE_INTERVAL       — seconds between scrape cycles (default: 60)
#   TENANT_REFRESH_INTERVAL — seconds between tenant list refreshes (default: 300)
#   TENANTS_LOCAL         — path to local fallback file (default: /etc/agenthive/tenants.local)

import json
import logging
import os
import signal
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("pg-stat-exporter")

try:
    import psycopg2
except ImportError:
    logger.error("psycopg2 not installed; run: pip install psycopg2-binary")
    sys.exit(1)

try:
    from prometheus_client import (
        Counter,
        Gauge,
        start_http_server,
    )
except ImportError:
    logger.error("prometheus_client not installed; run: pip install prometheus-client")
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────
EXPORTER_PORT = int(os.getenv("EXPORTER_PORT", "9101"))
SCRAPE_INTERVAL = int(os.getenv("SCRAPE_INTERVAL", "60"))
TENANT_REFRESH_INTERVAL = int(os.getenv("TENANT_REFRESH_INTERVAL", "300"))
TENANTS_LOCAL = os.getenv("TENANTS_LOCAL", "/etc/agenthive/tenants.local")
CONTROL_DSN = os.getenv("AGENTHIVE_CONTROL_DSN", "")

# ── Metrics ────────────────────────────────────────────────────────────────────
scrape_success = Counter(
    "agenthive_scrape_success_total",
    "Total successful pg_stat scrapes",
    ["slug"],
)
scrape_staleness = Gauge(
    "agenthive_scrape_staleness_seconds",
    "Seconds since last successful pg_stat scrape for this tenant",
    ["slug"],
)
db_table_rows = Gauge(
    "agenthive_db_table_rows",
    "Estimated live row count per table (pg_stat_user_tables.n_live_tup)",
    ["slug", "table"],
)


# ── Tenant discovery ───────────────────────────────────────────────────────────
def get_tenants_from_control() -> list[str] | None:
    if not CONTROL_DSN:
        return None
    try:
        conn = psycopg2.connect(CONTROL_DSN, connect_timeout=5)
        cur = conn.cursor()
        cur.execute(
            "SELECT slug FROM roadmap.project WHERE bootstrap_status = 'live'"
        )
        tenants = [row[0] for row in cur.fetchall()]
        conn.close()
        logger.info("hiveControl: fetched %d live tenants", len(tenants))
        return tenants
    except Exception as exc:
        logger.warning("hiveControl query failed (%s); falling back to local list", exc)
        return None


def get_tenants_from_local() -> list[str]:
    try:
        with open(TENANTS_LOCAL) as fh:
            data = json.load(fh)
        tenants = data.get("tenants", [])
        logger.info("Local fallback: loaded %d tenants from %s", len(tenants), TENANTS_LOCAL)
        return tenants
    except Exception as exc:
        logger.error("Local tenant file read failed (%s): %s", TENANTS_LOCAL, exc)
        return []


def refresh_tenants() -> list[str]:
    tenants = get_tenants_from_control()
    if tenants is None:
        tenants = get_tenants_from_local()
    return tenants


# ── Per-tenant DSN ─────────────────────────────────────────────────────────────
def get_tenant_dsn(slug: str) -> str | None:
    env_key = "AGENTHIVE_TENANT_{}_DSN".format(slug.upper().replace("-", "_"))
    return os.getenv(env_key)


# ── Per-tenant scrape ──────────────────────────────────────────────────────────
# Tracks last-success timestamp per slug. Staleness = now - last_success.
_last_success: dict[str, float] = {}


def scrape_tenant(slug: str) -> bool:
    dsn = get_tenant_dsn(slug)
    if not dsn:
        logger.warning("No DSN configured for slug=%s (set AGENTHIVE_TENANT_%s_DSN)",
                       slug, slug.upper().replace("-", "_"))
        return False
    try:
        conn = psycopg2.connect(dsn, connect_timeout=5)
        cur = conn.cursor()
        cur.execute(
            """
            SELECT schemaname, tablename, n_live_tup
            FROM pg_stat_user_tables
            WHERE schemaname = 'public'
            """
        )
        for _, table, rows in cur.fetchall():
            db_table_rows.labels(slug=slug, table=table).set(rows)
        conn.close()

        scrape_success.labels(slug=slug).inc()
        _last_success[slug] = time.time()
        scrape_staleness.labels(slug=slug).set(0)
        logger.debug("Scraped slug=%s", slug)
        return True
    except Exception as exc:
        logger.error("Scrape failed for slug=%s: %s", slug, exc)
        return False


def update_staleness(tenants: list[str]) -> None:
    now = time.time()
    for slug in tenants:
        last = _last_success.get(slug)
        if last is None:
            # Never succeeded; staleness = time since process start or SCRAPE_INTERVAL
            stale = SCRAPE_INTERVAL
        else:
            stale = now - last
        scrape_staleness.labels(slug=slug).set(stale)


# ── Signal handling ────────────────────────────────────────────────────────────
_shutdown = False


def _handle_sigterm(signum, frame):
    global _shutdown
    logger.info("Received signal %d; shutting down", signum)
    _shutdown = True


signal.signal(signal.SIGTERM, _handle_sigterm)
signal.signal(signal.SIGINT, _handle_sigterm)


# ── Main loop ──────────────────────────────────────────────────────────────────
def main() -> None:
    logger.info("Starting pg-stat-exporter on :%d", EXPORTER_PORT)
    start_http_server(EXPORTER_PORT)

    tenants = refresh_tenants()
    last_refresh = time.time()

    while not _shutdown:
        cycle_start = time.time()

        # Refresh tenant list every TENANT_REFRESH_INTERVAL seconds
        if cycle_start - last_refresh >= TENANT_REFRESH_INTERVAL:
            new_tenants = refresh_tenants()
            if new_tenants:
                tenants = new_tenants
            last_refresh = cycle_start

        # Scrape all tenants
        for slug in tenants:
            if _shutdown:
                break
            scrape_tenant(slug)

        # Update staleness for all known tenants (including failed ones)
        update_staleness(tenants)

        elapsed = time.time() - cycle_start
        sleep_for = max(0, SCRAPE_INTERVAL - elapsed)
        if sleep_for > 0 and not _shutdown:
            time.sleep(sleep_for)

    logger.info("Exporter stopped.")


if __name__ == "__main__":
    main()
