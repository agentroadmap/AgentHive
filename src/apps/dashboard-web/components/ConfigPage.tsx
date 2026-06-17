import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, type ConfigKeyDescriptor } from "../lib/api";

type EditState = { value: string; saving: boolean; error: string | null };

function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "General";
		const bucket = map.get(cat) ?? [];
		bucket.push(key);
		map.set(cat, bucket);
	}
	// Sort categories: General last, rest alphabetical
	const sorted = new Map<string, ConfigKeyDescriptor[]>();
	const cats = [...map.keys()].sort((a, b) => {
		if (a === "General") return 1;
		if (b === "General") return -1;
		return a.localeCompare(b);
	});
	for (const cat of cats) sorted.set(cat, map.get(cat)!);
	return sorted;
}

function inferInputType(key: ConfigKeyDescriptor): "boolean" | "number" | "text" {
	if (key.class === "flag") return "boolean";
	if (typeof key.default_value === "number") return "number";
	return "text";
}

function displayValue(key: ConfigKeyDescriptor): string {
	if (key.masked) return "••••••••";
	if (key.value == null) return "";
	if (typeof key.value === "boolean") return key.value ? "true" : "false";
	return String(key.value);
}

const ConfigPage: React.FC = () => {
	const [keys, setKeys] = useState<ConfigKeyDescriptor[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filterClass, setFilterClass] = useState<string>("");
	const [filterText, setFilterText] = useState<string>("");
	const [refreshing, setRefreshing] = useState(false);
	const [editStates, setEditStates] = useState<Map<string, EditState>>(new Map());
	const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

	const fetchData = useCallback(async (isRefresh = false) => {
		try {
			setError(null);
			if (isRefresh) setRefreshing(true);
			const data = await apiClient.fetchConfigKeys();
			setKeys(data);
		} catch (err) {
			console.error("Failed to fetch config keys:", err);
			setError("Failed to load config keys");
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void fetchData();
	}, [fetchData]);

	const startEdit = useCallback((key: ConfigKeyDescriptor) => {
		if (!key.editable) return;
		setEditStates((prev) => {
			const next = new Map(prev);
			if (!next.has(key.name)) {
				next.set(key.name, {
					value: displayValue(key),
					saving: false,
					error: null,
				});
			}
			return next;
		});
		setTimeout(() => inputRefs.current.get(key.name)?.focus(), 0);
	}, []);

	const cancelEdit = useCallback((keyName: string) => {
		setEditStates((prev) => {
			const next = new Map(prev);
			next.delete(keyName);
			return next;
		});
	}, []);

	const saveEdit = useCallback(
		async (key: ConfigKeyDescriptor) => {
			const state = editStates.get(key.name);
			if (!state) return;

			let parsedValue: unknown = state.value;
			if (inferInputType(key) === "boolean") {
				parsedValue = state.value === "true" || state.value === "1";
			} else if (inferInputType(key) === "number") {
				const n = Number(state.value);
				if (Number.isNaN(n)) {
					setEditStates((prev) => {
						const next = new Map(prev);
						next.set(key.name, { ...state, error: "Must be a number" });
						return next;
					});
					return;
				}
				parsedValue = n;
			}

			setEditStates((prev) => {
				const next = new Map(prev);
				next.set(key.name, { ...state, saving: true, error: null });
				return next;
			});

			// Optimistic update
			const prevValue = key.value;
			setKeys((prev) =>
				prev.map((k) => (k.name === key.name ? { ...k, value: parsedValue } : k)),
			);

			try {
				await apiClient.mutateConfigKey(key.name, parsedValue);
				setEditStates((prev) => {
					const next = new Map(prev);
					next.delete(key.name);
					return next;
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Save failed";
				setKeys((prev) =>
					prev.map((k) => (k.name === key.name ? { ...k, value: prevValue } : k)),
				);
				setEditStates((prev) => {
					const next = new Map(prev);
					next.set(key.name, { ...state, saving: false, error: msg });
					return next;
				});
			}
		},
		[editStates],
	);

	const classes = [...new Set(keys.map((k) => k.class))].sort();

	const filtered = keys.filter((k) => {
		if (filterClass && k.class !== filterClass) return false;
		if (filterText) {
			const q = filterText.toLowerCase();
			return (
				k.name.toLowerCase().includes(q) ||
				(k.description ?? "").toLowerCase().includes(q) ||
				(k.category ?? "").toLowerCase().includes(q)
			);
		}
		return true;
	});

	const grouped = groupByCategory(filtered);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-gray-500">Loading config keys…</div>
			</div>
		);
	}

	if (error) {
		return <div className="p-4 text-red-600 bg-red-50 rounded">{error}</div>;
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-6">
				<h1 className="text-2xl font-bold">Config Keys</h1>
				<div className="flex items-center gap-4 flex-wrap">
					<input
						type="search"
						placeholder="Filter…"
						value={filterText}
						onChange={(e) => setFilterText(e.target.value)}
						className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 text-sm w-40"
					/>
					<div className="flex items-center gap-2">
						<label htmlFor="class-filter" className="text-sm text-gray-600 dark:text-gray-400">
							Class:
						</label>
						<select
							id="class-filter"
							value={filterClass}
							onChange={(e) => setFilterClass(e.target.value)}
							className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{classes.map((c) => (
								<option key={c} value={c}>
									{c}
								</option>
							))}
						</select>
					</div>
					<span className="text-sm text-gray-500 dark:text-gray-400">
						{filtered.length} keys
					</span>
					<button
						type="button"
						onClick={() => void fetchData(true)}
						disabled={refreshing}
						className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
						title="Refresh"
					>
						<svg
							className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
							/>
						</svg>
						Refresh
					</button>
				</div>
			</div>

			{[...grouped.entries()].map(([category, categoryKeys]) => (
				<div key={category} className="mb-8">
					<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
						{category}
					</h2>
					<div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
						<table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
							<thead className="bg-gray-50 dark:bg-gray-800">
								<tr>
									<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-56">
										Key
									</th>
									<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-20">
										Class
									</th>
									<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
										Description
									</th>
									<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-64">
										Value
									</th>
								</tr>
							</thead>
							<tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
								{categoryKeys.map((key) => {
									const editState = editStates.get(key.name);
									const inputType = inferInputType(key);
									return (
										<tr
											key={key.name}
											className="hover:bg-gray-50 dark:hover:bg-gray-800"
										>
											<td className="px-4 py-3 font-mono text-xs text-gray-800 dark:text-gray-200 align-top">
												{key.name}
												{key.required && (
													<span className="ml-1 text-red-500" title="Required">
														*
													</span>
												)}
											</td>
											<td className="px-4 py-3 align-top">
												<ClassBadge cls={key.class} />
											</td>
											<td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 align-top">
												{key.description ?? "—"}
											</td>
											<td className="px-4 py-3 align-top">
												{key.masked ? (
													<span className="font-mono text-xs text-gray-400 dark:text-gray-500">
														••••••••
													</span>
												) : !key.editable ? (
													<span className="font-mono text-xs text-gray-700 dark:text-gray-300">
														{key.value == null ? (
															<span className="text-gray-300 dark:text-gray-600">—</span>
														) : (
															String(key.value)
														)}
													</span>
												) : editState ? (
													<div className="flex flex-col gap-1">
														{inputType === "boolean" ? (
															<select
																value={editState.value}
																onChange={(e) =>
																	setEditStates((prev) => {
																		const next = new Map(prev);
																		next.set(key.name, {
																			...editState,
																			value: e.target.value,
																			error: null,
																		});
																		return next;
																	})
																}
																className="rounded border border-blue-400 dark:border-blue-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 text-xs font-mono"
																disabled={editState.saving}
															>
																<option value="true">true</option>
																<option value="false">false</option>
															</select>
														) : (
															<input
																ref={(el) => {
																	if (el) inputRefs.current.set(key.name, el);
																	else inputRefs.current.delete(key.name);
																}}
																type={inputType === "number" ? "number" : "text"}
																value={editState.value}
																onChange={(e) =>
																	setEditStates((prev) => {
																		const next = new Map(prev);
																		next.set(key.name, {
																			...editState,
																			value: e.target.value,
																			error: null,
																		});
																		return next;
																	})
																}
																onKeyDown={(e) => {
																	if (e.key === "Enter") void saveEdit(key);
																	if (e.key === "Escape") cancelEdit(key.name);
																}}
																className="rounded border border-blue-400 dark:border-blue-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 text-xs font-mono w-full"
																disabled={editState.saving}
															/>
														)}
														<div className="flex items-center gap-2">
															<button
																type="button"
																onClick={() => void saveEdit(key)}
																disabled={editState.saving}
																className="px-2 py-0.5 rounded text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
															>
																{editState.saving ? "Saving…" : "Save"}
															</button>
															<button
																type="button"
																onClick={() => cancelEdit(key.name)}
																disabled={editState.saving}
																className="px-2 py-0.5 rounded text-xs text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
															>
																Cancel
															</button>
															{editState.error && (
																<span className="text-xs text-red-600">
																	{editState.error}
																</span>
															)}
														</div>
													</div>
												) : (
													<button
														type="button"
														onClick={() => startEdit(key)}
														className="font-mono text-xs text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 text-left group"
														title="Click to edit"
													>
														{key.value == null ? (
															<span className="text-gray-300 dark:text-gray-600 group-hover:text-blue-400">
																—
															</span>
														) : (
															<>
																{String(key.value)}
																<span className="ml-1 opacity-0 group-hover:opacity-60 text-gray-400">
																	✎
																</span>
															</>
														)}
													</button>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>
			))}

			{filtered.length === 0 && (
				<div className="text-center py-8 text-gray-500">
					No keys match the current filters.
				</div>
			)}
		</div>
	);
};

const CLASS_COLORS: Record<string, string> = {
	flag: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
	registry: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
	secret: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
	structural: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
	tenant_dsn: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
	diagnostic: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
};

function ClassBadge({ cls }: { cls: string }) {
	const color = CLASS_COLORS[cls] ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400";
	return (
		<span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${color}`}>
			{cls}
		</span>
	);
}

export default ConfigPage;
