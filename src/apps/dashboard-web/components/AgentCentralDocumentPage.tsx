import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, type AgcDocNode, type AgcDocPayload } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";
import MermaidMarkdown from "./MermaidMarkdown";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Natural-sort comparator for display ids like AGC-PR.2 vs AGC-PR.10. */
function compareDisplayId(a: string, b: string): number {
	const segs = (s: string) => s.split(/([0-9]+)/).filter((x) => x !== "");
	const sa = segs(a);
	const sb = segs(b);
	const n = Math.max(sa.length, sb.length);
	for (let i = 0; i < n; i++) {
		const x = sa[i] ?? "";
		const y = sb[i] ?? "";
		const nx = Number(x);
		const ny = Number(y);
		if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
			if (nx !== ny) return nx - ny;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

interface TreeNode extends AgcDocNode {
	depth: number;
	children: TreeNode[];
}

function buildTree(nodes: AgcDocNode[]): TreeNode[] {
	const byId = new Map<number, TreeNode>();
	for (const n of nodes) byId.set(n.id, { ...n, depth: 0, children: [] });
	const roots: TreeNode[] = [];
	for (const n of byId.values()) {
		if (n.parent_id != null && byId.has(n.parent_id)) {
			byId.get(n.parent_id)?.children.push(n);
		} else {
			roots.push(n);
		}
	}
	const sortRec = (list: TreeNode[], depth: number) => {
		list.sort((a, b) => compareDisplayId(a.display_id, b.display_id));
		for (const c of list) {
			c.depth = depth;
			sortRec(c.children, depth + 1);
		}
	};
	sortRec(roots, 0);
	return roots;
}

function flatten(roots: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	const walk = (n: TreeNode) => {
		out.push(n);
		for (const c of n.children) walk(c);
	};
	for (const r of roots) walk(r);
	return out;
}

const typeBadge = (t: string) => {
	switch (t) {
		case "product":
			return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300";
		case "architecture":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
		case "theory":
			return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
		case "feature":
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
	}
};

const maturityBadge = (m: string) => {
	switch (m) {
		case "mature":
			return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
		case "active":
			return "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300";
		case "obsolete":
			return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
		default:
			return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400";
	}
};

const acBadge = (s: string) => {
	switch (s) {
		case "pass":
			return "text-green-600 dark:text-green-400";
		case "fail":
			return "text-red-600 dark:text-red-400";
		case "blocked":
			return "text-amber-600 dark:text-amber-400";
		case "waived":
			return "text-gray-400 dark:text-gray-500";
		default:
			return "text-gray-400 dark:text-gray-500";
	}
};

const headingSize = (depth: number) => {
	if (depth <= 0) return "text-3xl";
	if (depth === 1) return "text-2xl";
	if (depth === 2) return "text-xl";
	if (depth === 3) return "text-lg";
	return "text-base";
};

function Section({ title, body }: { title: string; body: string }) {
	return (
		<div className="mt-3">
			<div className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
				{title}
			</div>
			<div className="prose prose-sm dark:prose-invert max-w-none">
				<MermaidMarkdown source={body} />
			</div>
		</div>
	);
}

// ── component ────────────────────────────────────────────────────────────────

const AgentCentralDocumentPage: React.FC = () => {
	const [payload, setPayload] = useState<AgcDocPayload | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [tocOpen, setTocOpen] = useState(true);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			setLoading(true);
			const data = await apiClient.fetchAgentCentralDocument();
			setPayload(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load document");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const roots = useMemo(
		() => (payload ? buildTree(payload.nodes) : []),
		[payload],
	);
	const ordered = useMemo(() => flatten(roots), [roots]);

	const q = filter.trim().toLowerCase();
	const matchedIds = useMemo(() => {
		if (!q) return null;
		const set = new Set<number>();
		// match against title / display_id / summary; keep ancestors visible too
		const byId = new Map(ordered.map((n) => [n.id, n]));
		for (const n of ordered) {
			const hay =
				`${n.display_id} ${n.title} ${n.summary ?? ""} ${n.tags.join(" ")}`.toLowerCase();
			if (hay.includes(q)) {
				let cur: TreeNode | undefined = n;
				while (cur) {
					set.add(cur.id);
					cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
				}
			}
		}
		return set;
	}, [q, ordered]);

	const visible = useMemo(
		() => (matchedIds ? ordered.filter((n) => matchedIds.has(n.id)) : ordered),
		[ordered, matchedIds],
	);

	const scrollTo = (displayId: string) => {
		const el = document.getElementById(`agc-${displayId}`);
		if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading AgentCentral document…
				</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8 max-w-2xl mx-auto">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<p className="text-red-600 dark:text-red-400 font-medium">
						Could not load the AgentCentral document
					</p>
					<p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
					<p className="text-gray-500 dark:text-gray-400 text-xs mt-3">
						The page reads the <code>agentHive3</code> tenant database. If the
						server cannot reach it, set <code>AGENTHIVE3_DSN</code> in the server
						environment.
					</p>
					<button
						type="button"
						onClick={fetchData}
						className="mt-4 px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50"
					>
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0">
			{/* ── Table of contents ── */}
			{tocOpen && (
				<aside className="hidden lg:flex flex-col w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 overflow-y-auto bg-gray-50 dark:bg-gray-900/40">
					<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
						<div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
							Contents
						</div>
					</div>
					<nav className="py-2">
						{visible.map((n) => (
							<button
								type="button"
								key={n.id}
								onClick={() => scrollTo(n.display_id)}
								className="block w-full text-left text-sm py-1 pr-3 truncate text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
								style={{ paddingLeft: `${0.75 + n.depth * 0.85}rem` }}
								title={`${n.display_id} ${n.title}`}
							>
								<span className="font-mono text-[11px] text-gray-400 dark:text-gray-500 mr-1">
									{n.display_id}
								</span>
								{n.title}
							</button>
						))}
					</nav>
				</aside>
			)}

			{/* ── Document body ── */}
			<div className="flex-1 min-w-0 overflow-y-auto">
				<div className="max-w-4xl mx-auto px-4 sm:px-8 py-6">
					{/* header */}
					<div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
						<div>
							<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
								AgentCentral — Product Document
							</h1>
							<p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
								{payload?.total} proposals · tenant{" "}
								<span className="font-mono">{payload?.tenant}</span> · generated{" "}
								{payload
									? new Date(payload.generated_at).toLocaleString()
									: ""}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<input
								type="text"
								placeholder="Filter sections…"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								className="rounded border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm bg-white dark:bg-gray-800 w-48"
							/>
							<button
								type="button"
								onClick={() => setTocOpen((v) => !v)}
								className="hidden lg:inline-flex px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
							>
								{tocOpen ? "Hide TOC" : "Show TOC"}
							</button>
							<button
								type="button"
								onClick={fetchData}
								className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
							>
								Refresh
							</button>
						</div>
					</div>

					{visible.length === 0 && (
						<div className="text-center py-12 text-gray-500 dark:text-gray-400">
							No sections match “{filter}”.
						</div>
					)}

					{/* sections */}
					{visible.map((n) => (
						<section
							key={n.id}
							id={`agc-${n.display_id}`}
							className="scroll-mt-4 mb-8"
						>
							<div
								className="border-l-2 border-gray-200 dark:border-gray-800 pl-4"
								style={{ marginLeft: `${Math.min(n.depth, 4) * 0.5}rem` }}
							>
								<div className="flex flex-wrap items-baseline gap-2">
									<span className="font-mono text-xs text-gray-400 dark:text-gray-500">
										{n.display_id}
									</span>
									<h2
										className={`font-semibold text-gray-900 dark:text-gray-100 ${headingSize(n.depth)}`}
									>
										{n.title}
									</h2>
								</div>

								<div className="flex flex-wrap items-center gap-1.5 mt-2">
									<span
										className={`px-2 py-0.5 rounded text-[11px] font-medium ${typeBadge(n.type)}`}
									>
										{n.type}
									</span>
									<span className="px-2 py-0.5 rounded text-[11px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
										{n.status}
									</span>
									<span
										className={`px-2 py-0.5 rounded text-[11px] font-medium ${maturityBadge(n.maturity)}`}
									>
										{n.maturity}
									</span>
									{n.tags.map((t) => (
										<span
											key={t}
											className="px-2 py-0.5 rounded text-[11px] bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300"
										>
											{t}
										</span>
									))}
								</div>

								{n.summary && (
									<p className="mt-3 text-gray-700 dark:text-gray-300">
										{n.summary}
									</p>
								)}

								{n.motivation && (
									<Section title="Motivation" body={n.motivation} />
								)}
								{n.design && <Section title="Design" body={n.design} />}
								{n.drawbacks && (
									<Section title="Drawbacks & risks" body={n.drawbacks} />
								)}
								{n.alternatives && (
									<Section title="Alternatives" body={n.alternatives} />
								)}

								{n.acceptance_criteria.length > 0 && (
									<div className="mt-3">
										<div className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
											Acceptance criteria
										</div>
										<ul className="space-y-1">
											{n.acceptance_criteria.map((ac) => (
												<li
													key={ac.item_number}
													className="text-sm text-gray-700 dark:text-gray-300 flex gap-2"
												>
													<span className="font-mono text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
														AC-{ac.item_number}
													</span>
													<span className="flex-1">{ac.criterion_text}</span>
													<span
														className={`text-[11px] font-medium flex-shrink-0 ${acBadge(ac.status)}`}
													>
														{ac.status}
													</span>
												</li>
											))}
										</ul>
									</div>
								)}

								{(n.deps_in.length > 0 || n.deps_out.length > 0) && (
									<div className="mt-3 flex flex-col gap-1">
										{n.deps_in.length > 0 && (
											<div className="text-xs text-gray-500 dark:text-gray-400">
												<span className="uppercase tracking-wide font-semibold">
													Depends on / relates:
												</span>{" "}
												{n.deps_in.map((e) => (
													<button
														type="button"
														key={`${e.display_id}-${e.edge_type}`}
														onClick={() => scrollTo(e.display_id)}
														className="inline-block mr-1 mb-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 font-mono text-[11px]"
														title={`${e.edge_type}: ${e.title}`}
													>
														{e.display_id}
													</button>
												))}
											</div>
										)}
										{n.deps_out.length > 0 && (
											<div className="text-xs text-gray-500 dark:text-gray-400">
												<span className="uppercase tracking-wide font-semibold">
													Blocks / enables:
												</span>{" "}
												{n.deps_out.map((e) => (
													<button
														type="button"
														key={`${e.display_id}-${e.edge_type}`}
														onClick={() => scrollTo(e.display_id)}
														className="inline-block mr-1 mb-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 font-mono text-[11px]"
														title={`${e.edge_type}: ${e.title}`}
													>
														{e.display_id}
													</button>
												))}
											</div>
										)}
									</div>
								)}
							</div>
						</section>
					))}
				</div>
			</div>
		</div>
	);
};

export default AgentCentralDocumentPage;
