import type React from "react";
import { useCallback, useEffect, useState } from "react";

interface AgentRow {
	agent_id: string;
	agent_identity: string;
	role: string | null;
	status: string | null;
	last_active_at: string | null;
}

interface TenantIdentity {
	project_id: number;
	slug: string;
	name: string;
	agents: AgentRow[];
}

interface IdentityError {
	project_id: number;
	slug: string;
	name: string;
	error: string;
}

interface IdentityData {
	agencies: { agency_id: string; display_name: string | null; status: string }[];
	data: TenantIdentity[];
	errors: IdentityError[];
	partial: boolean;
}

function timeAgo(value?: string | null): string {
	if (!value) return "—";
	const diffMs = Date.now() - new Date(value).getTime();
	const minutes = Math.floor(diffMs / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

const IdentityView: React.FC = () => {
	const [data, setData] = useState<IdentityData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const res = await fetch("/api/control-plane/identity");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setData(await res.json());
			setError(null);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchData();
		const t = setInterval(() => void fetchData(), 30000);
		return () => clearInterval(t);
	}, [fetchData]);

	if (loading) {
		return (
			<div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400">
				Loading identity data…
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
				Failed to load identity data: {error}
			</div>
		);
	}

	return (
		<div className="space-y-6 px-4 py-6 md:px-6">
			<div className="border-b border-gray-200 pb-4 dark:border-gray-800">
				<h1 className="text-2xl font-semibold text-gray-950 dark:text-gray-50">
					Identity
				</h1>
				<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
					Registered agencies and per-project agent registries.
				</p>
				{data?.partial && (
					<div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
						Partial result — some tenants unavailable ({data.errors.length} errors)
					</div>
				)}
			</div>

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
					Agencies ({data?.agencies.length ?? 0})
				</h2>
				<div className="divide-y divide-gray-200 border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
					{data?.agencies.length === 0 && (
						<div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
							No agencies.
						</div>
					)}
					{data?.agencies.map((agency) => (
						<div
							key={agency.agency_id}
							className="flex items-center justify-between gap-4 px-4 py-3"
						>
							<div>
								<div className="text-sm font-medium text-gray-950 dark:text-gray-50">
									{agency.display_name ?? agency.agency_id}
								</div>
								<div className="text-xs text-gray-500 dark:text-gray-400">
									{agency.agency_id}
								</div>
							</div>
							<span
								className={`text-xs font-medium px-2 py-0.5 rounded-full ${
									agency.status === "active"
										? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
										: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
								}`}
							>
								{agency.status}
							</span>
						</div>
					))}
				</div>
			</section>

			{data?.data.map((tenant) => (
				<section key={tenant.project_id}>
					<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
						{tenant.name} — {tenant.agents.length} agents
					</h2>
					<div className="divide-y divide-gray-200 border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
						{tenant.agents.length === 0 && (
							<div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
								No agents registered.
							</div>
						)}
						{tenant.agents.map((agent) => (
							<div
								key={agent.agent_id}
								className="flex items-start justify-between gap-4 px-4 py-3"
							>
								<div>
									<div className="text-sm font-medium text-gray-950 dark:text-gray-50">
										{agent.agent_identity}
									</div>
									<div className="text-xs text-gray-500 dark:text-gray-400">
										{agent.role ?? "—"} · {agent.agent_id}
									</div>
								</div>
								<div className="text-right text-xs text-gray-500 dark:text-gray-400">
									<div>{agent.status ?? "—"}</div>
									<div>{timeAgo(agent.last_active_at)}</div>
								</div>
							</div>
						))}
					</div>
				</section>
			))}

			{data?.errors.map((e) => (
				<div
					key={e.project_id}
					className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-900 dark:bg-red-950/20"
				>
					<span className="font-medium text-red-700 dark:text-red-400">
						{e.name} ({e.slug}):
					</span>{" "}
					<span className="text-red-600 dark:text-red-400">{e.error}</span>
				</div>
			))}
		</div>
	);
};

export default IdentityView;
