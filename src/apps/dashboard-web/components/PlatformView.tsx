import { useEffect, useState } from "react";

interface RouteRow {
  model_name: string;
  route_provider: string;
  is_enabled: boolean;
  priority: number;
  tier: string | null;
}

interface ProjectPlatform {
  project_id: number;
  slug: string;
  name: string;
  migration_count: number;
}

interface PlatformResponse {
  routes: RouteRow[];
  projects: ProjectPlatform[];
  errors: { project_id: number; slug: string; error: string }[];
  partial: boolean;
}

export default function PlatformView() {
  const [data, setData] = useState<PlatformResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/control-plane/platform")
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d as PlatformResponse); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="p-8 text-stone-500">Loading platform…</div>;
  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return null;

  const enabledRoutes = data.routes.filter((r) => r.is_enabled).length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">Platform</h1>

      {data.partial && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 p-3 text-sm text-amber-800 dark:text-amber-300">
          Partial results — {data.errors.length} project(s) unreachable:{" "}
          {data.errors.map((e) => e.slug).join(", ")}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
          Model Routes ({enabledRoutes}/{data.routes.length} enabled)
        </h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-stone-700">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
              <tr>
                {["Model", "Provider", "Tier", "Priority", "Enabled"].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-700 bg-white dark:bg-stone-800">
              {data.routes.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered list
                <tr key={i}>
                  <td className="px-4 py-2 font-medium text-stone-800 dark:text-stone-200">{r.model_name}</td>
                  <td className="px-4 py-2 text-stone-500">{r.route_provider}</td>
                  <td className="px-4 py-2 text-stone-500">{r.tier ?? "—"}</td>
                  <td className="px-4 py-2 tabular-nums text-stone-500">{r.priority}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      r.is_enabled
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    }`}>
                      {r.is_enabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.projects.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
            Migration Status
          </h2>
          <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-stone-700">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
                <tr>
                  {["Project", "Applied Migrations"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-700 bg-white dark:bg-stone-800">
                {data.projects.map((p) => (
                  <tr key={p.project_id}>
                    <td className="px-4 py-2 font-medium text-stone-800 dark:text-stone-200">
                      {p.name} <span className="text-stone-400 text-xs">({p.slug})</span>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{p.migration_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
