import { useEffect, useState } from "react";

interface ProjectEfficiency {
  project_id: number;
  slug: string;
  name: string;
  total_cost_usd: number;
  total_runs: number;
  runs_last_24h: number;
  avg_duration_ms: number | null;
}

interface EfficiencyResponse {
  data: ProjectEfficiency[];
  errors: { project_id: number; slug: string; error: string }[];
  partial: boolean;
}

export default function EfficiencyView() {
  const [data, setData] = useState<EfficiencyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/control-plane/efficiency")
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d as EfficiencyResponse); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="p-8 text-stone-500">Loading efficiency…</div>;
  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return null;

  const grandTotal = data.data.reduce((s, p) => s + p.total_cost_usd, 0);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">Efficiency</h1>
        <span className="text-lg font-semibold tabular-nums text-stone-700 dark:text-stone-300">
          Grand total: ${grandTotal.toFixed(4)}
        </span>
      </div>

      {data.partial && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 p-3 text-sm text-amber-800 dark:text-amber-300">
          Partial results — {data.errors.length} project(s) unreachable:{" "}
          {data.errors.map((e) => e.slug).join(", ")}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-stone-700">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
            <tr>
              {["Project", "Total Cost", "Total Runs", "Runs (24h)", "Avg Duration"].map((h) => (
                <th key={h} className="px-4 py-2 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-700 bg-white dark:bg-stone-800">
            {data.data.map((p) => (
              <tr key={p.project_id}>
                <td className="px-4 py-2 font-medium text-stone-800 dark:text-stone-200">
                  {p.name} <span className="text-stone-400 text-xs">({p.slug})</span>
                </td>
                <td className="px-4 py-2 tabular-nums">${p.total_cost_usd.toFixed(4)}</td>
                <td className="px-4 py-2 tabular-nums">{p.total_runs.toLocaleString()}</td>
                <td className="px-4 py-2 tabular-nums">{p.runs_last_24h.toLocaleString()}</td>
                <td className="px-4 py-2 tabular-nums text-stone-500">
                  {p.avg_duration_ms != null ? `${Math.round(p.avg_duration_ms).toLocaleString()}ms` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
