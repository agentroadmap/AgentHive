import { useEffect, useState } from "react";
import { Link } from "wouter";

interface PortfolioCard {
  title: string;
  value: string | number;
  sub?: string;
  status?: "ok" | "warn" | "error";
  href?: string;
}

interface ActiveProject {
  project_id: number;
  slug: string;
  name: string;
}

interface AgencyRow {
  id: number;
  display_name: string;
  status: string;
}

interface BudgetLedgerRow {
  total_cost_usd: number | null;
}

interface EventRow {
  id: number;
  event_type?: string;
  created_at: string;
  payload?: unknown;
}

function usePortfolioData() {
  const [activeProjects, setActiveProjects] = useState<number | null>(null);
  const [fleetData, setFleetData] = useState<{
    agencies: AgencyRow[];
    errors: unknown[];
  } | null>(null);
  const [recentActivity, setRecentActivity] = useState<EventRow[]>([]);
  const [budgetStatus, setBudgetStatus] = useState<string>("N/A");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const [projectsRes, fleetRes] = await Promise.allSettled([
          fetch("/api/projects").then((r) => r.json()),
          fetch("/api/control-plane/fleet").then((r) => r.json()),
        ]);

        if (!alive) return;

        if (projectsRes.status === "fulfilled") {
          const data = projectsRes.value as ActiveProject[] | { projects?: ActiveProject[] };
          const list = Array.isArray(data) ? data : (data as { projects?: ActiveProject[] }).projects ?? [];
          setActiveProjects(list.length);
        }

        if (fleetRes.status === "fulfilled") {
          setFleetData(fleetRes.value);
        }

        // Try to get budget info from efficiency endpoint
        const effRes = await fetch("/api/control-plane/efficiency").catch(() => null);
        if (alive && effRes?.ok) {
          const eff = (await effRes.json()) as { data?: { total_cost_usd: number }[] };
          const total = (eff.data ?? []).reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
          setBudgetStatus(`$${total.toFixed(2)}`);
        }

        // Try to get recent activity from pulse
        const pulseRes = await fetch("/api/pulse").catch(() => null);
        if (alive && pulseRes?.ok) {
          const pulse = (await pulseRes.json()) as { events?: EventRow[] } | EventRow[];
          const events = Array.isArray(pulse) ? pulse : (pulse as { events?: EventRow[] }).events ?? [];
          setRecentActivity(events.slice(0, 10));
        }
      } finally {
        if (alive) setLoading(false);
      }
    }

    void load();
    return () => { alive = false; };
  }, []);

  return { activeProjects, fleetData, recentActivity, budgetStatus, loading };
}

function Card({ title, value, sub, status, href }: PortfolioCard) {
  const statusColor =
    status === "error"
      ? "border-red-400 dark:border-red-600"
      : status === "warn"
        ? "border-amber-400 dark:border-amber-600"
        : "border-stone-200 dark:border-stone-700";

  const inner = (
    <div
      className={`rounded-xl border ${statusColor} bg-white dark:bg-stone-800 p-5 flex flex-col gap-1 shadow-sm hover:shadow-md transition-shadow`}
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {title}
      </div>
      <div className="text-3xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">
        {value}
      </div>
      {sub && (
        <div className="text-sm text-stone-500 dark:text-stone-400">{sub}</div>
      )}
    </div>
  );

  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default function PortfolioHome() {
  const { activeProjects, fleetData, recentActivity, budgetStatus, loading } =
    usePortfolioData();

  const agencyTotal = fleetData?.agencies?.length ?? 0;
  const agencyDegraded = fleetData?.agencies?.filter(
    (a) => a.status !== "active" && a.status !== "healthy",
  ).length ?? 0;

  const fleetSub =
    agencyDegraded > 0 ? `${agencyDegraded} degraded` : "all healthy";
  const fleetStatus: "ok" | "warn" | "error" =
    agencyDegraded > 0 ? "warn" : "ok";

  const cards: PortfolioCard[] = [
    {
      title: "Active Projects",
      value: loading ? "…" : (activeProjects ?? 0),
      sub: "registered in roadmap.project",
      href: "/",
    },
    {
      title: "Fleet Health",
      value: loading ? "…" : `${agencyTotal} agencies`,
      sub: loading ? "" : fleetSub,
      status: loading ? "ok" : fleetStatus,
      href: "/agencies",
    },
    {
      title: "Budget Status",
      value: loading ? "…" : budgetStatus,
      sub: "total agent spend (all projects)",
      href: "/statistics",
    },
    {
      title: "Recent Activity",
      value: loading ? "…" : recentActivity.length,
      sub: "events in pulse log",
      href: "/activity",
    },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">
          Control Plane
        </h1>
        <p className="text-stone-500 dark:text-stone-400 mt-1 text-sm">
          Cross-project operator portal
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <Card key={c.title} {...c} />
        ))}
      </div>

      {recentActivity.length > 0 && (
        <div className="rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
            Recent Activity
          </div>
          <ul className="divide-y divide-stone-100 dark:divide-stone-700">
            {recentActivity.map((ev, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: events have no stable id in pulse
              <li key={i} className="py-2 text-sm text-stone-700 dark:text-stone-300 flex gap-2">
                <span className="text-stone-400 dark:text-stone-500 text-xs tabular-nums shrink-0">
                  {new Date(ev.created_at).toLocaleTimeString()}
                </span>
                <span>{(ev as Record<string, unknown>).event_type as string ?? "event"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
