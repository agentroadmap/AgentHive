import { useEffect, useState } from "react";

interface AgencyRow {
  id: number;
  display_name: string;
  host_id: string | null;
  status: string;
}

interface ProjectIdentity {
  project_id: number;
  slug: string;
  name: string;
  agent_count: number;
  active_agents: number;
}

interface IdentityResponse {
  agencies: AgencyRow[];
  projects: ProjectIdentity[];
  errors: { project_id: number; slug: string; error: string }[];
  partial: boolean;
}

export default function IdentityView() {
  const [data, setData] = useState<IdentityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/control-plane/identity")
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d as IdentityResponse); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="p-8 text-stone-500">Loading identity…</div>;
  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">Identity</h1>

      {data.partial && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 p-3 text-sm text-amber-800 dark:text-amber-300">
          Partial results — {data.errors.length} project(s) unreachable:{" "}
          {data.errors.map((e) => e.slug).join(", ")}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
          Agencies ({data.agencies.length})
        </h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-stone-700">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
              <tr>
                {["ID", "Name", "Host", "Status"].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-700 bg-white dark:bg-stone-800">
              {data.agencies.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2 tabular-nums text-stone-400">{a.id}</td>
                  <td className="px-4 py-2 font-medium text-stone-800 dark:text-stone-200">{a.display_name}</td>
                  <td className="px-4 py-2 text-stone-500">{a.host_id ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      a.status === "active"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : "bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                    }`}>
                      {a.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
          Agent Registry by Project
        </h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-stone-700">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
              <tr>
                {["Project", "Total Agents", "Active"].map((h) => (
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
                  <td className="px-4 py-2 tabular-nums">{p.agent_count}</td>
                  <td className="px-4 py-2 tabular-nums">{p.active_agents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
