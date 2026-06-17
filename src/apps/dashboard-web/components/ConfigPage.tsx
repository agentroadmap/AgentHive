import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type ConfigKeyDescriptor } from "../lib/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_ORDER = [
	"orchestration",
	"a2a",
	"agency",
	"feature_flag",
	"model_routing",
	"budget",
	"billing",
	"security",
	"ui",
	"system",
	"uncategorized",
];

function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "uncategorized";
		if (!map.has(cat)) map.set(cat, []);
		map.get(cat)!.push(key);
	}
	return map;
}

function inferInputType(key: ConfigKeyDescriptor): "boolean" | "number" | "string" {
	const def = key.default_value;
	if (typeof def === "boolean") return "boolean";
	if (typeof def === "number") return "number";
	if (typeof key.value === "boolean") return "boolean";
	if (typeof key.value === "number") return "number";
	const name = key.name.toLowerCase();
	if (
		name.endsWith("_enabled") ||
		name.startsWith("enable_") ||
		name.startsWith("use_") ||
		name.startsWith("pause_") ||
		name.endsWith("_guard")
	)
		return "boolean";
	if (name.endsWith("_ms") || name.endsWith("_limit") || name.endsWith("_cap") || name.endsWith("_max"))
		return "number";
	return "string";
}

function displayValue(key: ConfigKeyDescriptor): string {
	if (key.masked) return "••••••";
	if (key.value === null || key.value === undefined) return key.default_value != null ? String(key.default_value) : "(not set)";
	return typeof key.value === "object" ? JSON.stringify(key.value) : String(key.value);
}

// ── Row component ─────────────────────────────────────────────────────────────

interface ConfigRowProps {
	keyDesc: ConfigKeyDescriptor;
	onSave: (keyName: string, value: unknown) => Promise<void>;
}

const ConfigRow: React.FC<ConfigRowProps> = ({ keyDesc, onSave }) => {
	const inputType = inferInputType(keyDesc);
	const isEditable = keyDesc.editable && !keyDesc.masked;

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<string>("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const startEdit = () => {
		const current = keyDesc.value ?? keyDesc.default_value;
		setDraft(current != null ? String(current) : "");
		setError(null);
		setEditing(true);
	};

	const cancelEdit = () => {
		setEditing(false);
		setError(null);
	};

	const commitSave = async () => {
		setSaving(true);
		setError(null);
		try {
			let parsed: unknown = draft;
			if (inputType === "boolean") parsed = draft === "true" || draft === "1";
			else if (inputType === "number") {
				const n = Number(draft);
				if (!Number.isFinite(n)) throw new Error("Invalid number");
				parsed = n;
			}
			await onSave(keyDesc.name, parsed);
			setEditing(false);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setSaving(false);
		}
	};

	const classBadge = (cls: string) => {
		const map: Record<string, string> = {
			flag: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
			registry: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
			structural: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
			secret: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
			tenant_dsn: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
		};
		return map[cls] ?? "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400";
	};

	return (
		<div className="flex flex-col sm:flex-row sm:items-start gap-2 py-3 border-b border-stone-100 dark:border-stone-800 last:border-0">
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 flex-wrap">
					<span className="font-mono text-sm font-medium text-stone-800 dark:text-stone-200 break-all">
						{keyDesc.name}
					</span>
					<span
						className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${classBadge(keyDesc.class)}`}
					>
						{keyDesc.class}
					</span>
					{keyDesc.required && (
						<span className="shrink-0 px-1.5 py-0.5 rounded text-xs font-medium bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
							required
						</span>
					)}
				</div>
				{keyDesc.description && (
					<p className="mt-0.5 text-xs text-stone-500 dark:text-stone-500 leading-snug">
						{keyDesc.description}
					</p>
				)}
			</div>

			<div className="flex items-center gap-2 sm:min-w-[200px]">
				{editing ? (
					<>
						{inputType === "boolean" ? (
							<select
								className="flex-1 px-2 py-1 text-sm border border-stone-300 dark:border-stone-600 rounded bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								disabled={saving}
							>
								<option value="true">true</option>
								<option value="false">false</option>
							</select>
						) : (
							<input
								type={inputType === "number" ? "number" : "text"}
								className="flex-1 px-2 py-1 text-sm border border-stone-300 dark:border-stone-600 rounded bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								disabled={saving}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitSave();
									if (e.key === "Escape") cancelEdit();
								}}
								autoFocus
							/>
						)}
						<button
							type="button"
							onClick={commitSave}
							disabled={saving}
							className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
						>
							{saving ? "…" : "Save"}
						</button>
						<button
							type="button"
							onClick={cancelEdit}
							disabled={saving}
							className="px-2 py-1 text-xs rounded bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-300 dark:hover:bg-stone-600 disabled:opacity-50"
						>
							Cancel
						</button>
					</>
				) : (
					<>
						<span
							className={`flex-1 font-mono text-sm break-all ${
								keyDesc.masked
									? "text-stone-400 dark:text-stone-600"
									: "text-stone-700 dark:text-stone-300"
							}`}
						>
							{displayValue(keyDesc)}
						</span>
						{isEditable && (
							<button
								type="button"
								onClick={startEdit}
								className="shrink-0 px-2 py-1 text-xs rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
							>
								Edit
							</button>
						)}
					</>
				)}
			</div>

			{error && (
				<p className="w-full text-xs text-red-600 dark:text-red-400 mt-1">{error}</p>
			)}
		</div>
	);
};

// ── Category section ──────────────────────────────────────────────────────────

interface CategorySectionProps {
	category: string;
	keys: ConfigKeyDescriptor[];
	onSave: (keyName: string, value: unknown) => Promise<void>;
}

const CategorySection: React.FC<CategorySectionProps> = ({ category, keys, onSave }) => {
	const [collapsed, setCollapsed] = useState(false);

	return (
		<div className="mb-4 rounded-lg border border-stone-200 dark:border-stone-700 overflow-hidden">
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				className="w-full flex items-center justify-between px-4 py-2.5 bg-stone-50 dark:bg-stone-800/60 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
			>
				<div className="flex items-center gap-2">
					<span className="font-semibold text-sm text-stone-700 dark:text-stone-300 capitalize">
						{category.replace(/_/g, " ")}
					</span>
					<span className="text-xs text-stone-400 dark:text-stone-500">{keys.length}</span>
				</div>
				<span className="text-stone-400 dark:text-stone-500 text-xs">{collapsed ? "▶" : "▼"}</span>
			</button>
			{!collapsed && (
				<div className="px-4 bg-white dark:bg-stone-900">
					{keys.map((k) => (
						<ConfigRow key={k.name} keyDesc={k} onSave={onSave} />
					))}
				</div>
			)}
		</div>
	);
};

// ── Page ──────────────────────────────────────────────────────────────────────

const ConfigPage: React.FC = () => {
	const [keys, setKeys] = useState<ConfigKeyDescriptor[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [classFilter, setClassFilter] = useState<string>("all");
	const [saveToasts, setSaveToasts] = useState<{ id: number; msg: string; ok: boolean }[]>([]);
	const toastId = useState(0);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const { keys: data } = await apiClient.fetchConfigKeys();
			setKeys(data);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const toast = (msg: string, ok: boolean) => {
		const id = ++toastId[0];
		setSaveToasts((t) => [...t, { id, msg, ok }]);
		setTimeout(() => setSaveToasts((t) => t.filter((x) => x.id !== id)), 3000);
	};

	const handleSave = useCallback(
		async (keyName: string, value: unknown) => {
			await apiClient.mutateConfigKey(keyName, value);
			setKeys((prev) =>
				prev.map((k) => (k.name === keyName ? { ...k, value } : k)),
			);
			toast(`${keyName} updated`, true);
		},
		[],
	);

	const displayKeys = keys.filter((k) => {
		if (classFilter !== "all" && k.class !== classFilter) return false;
		if (search.trim()) {
			const q = search.toLowerCase();
			return (
				k.name.toLowerCase().includes(q) ||
				(k.description ?? "").toLowerCase().includes(q) ||
				k.category.toLowerCase().includes(q)
			);
		}
		return true;
	});

	const grouped = groupByCategory(displayKeys);
	const sortedCategories = CATEGORY_ORDER.filter((c) => grouped.has(c)).concat(
		[...grouped.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
	);

	return (
		<div className="h-full flex flex-col min-h-0">
			{/* Header */}
			<div className="shrink-0 px-4 sm:px-6 py-4 border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
				<div className="flex flex-col sm:flex-row sm:items-center gap-3">
					<div className="flex-1">
						<h1 className="text-lg font-semibold text-stone-800 dark:text-stone-100">
							Config Registry
						</h1>
						<p className="text-xs text-stone-500 dark:text-stone-500 mt-0.5">
							{keys.length} keys · editable flag keys write to{" "}
							<code className="font-mono">core.runtime_flag</code>
						</p>
					</div>
					<button
						type="button"
						onClick={load}
						disabled={loading}
						className="shrink-0 px-3 py-1.5 text-sm rounded bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-50"
					>
						{loading ? "Loading…" : "Refresh"}
					</button>
				</div>

				{/* Filters */}
				<div className="mt-3 flex flex-col sm:flex-row gap-2">
					<input
						type="search"
						placeholder="Search keys…"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="flex-1 px-3 py-1.5 text-sm border border-stone-200 dark:border-stone-700 rounded bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
					/>
					<select
						value={classFilter}
						onChange={(e) => setClassFilter(e.target.value)}
						className="px-3 py-1.5 text-sm border border-stone-200 dark:border-stone-700 rounded bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
					>
						<option value="all">All classes</option>
						<option value="flag">flag</option>
						<option value="structural">structural</option>
						<option value="registry">registry</option>
						<option value="secret">secret</option>
					</select>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4">
				{error && (
					<div className="mb-4 px-4 py-3 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
						{error}
					</div>
				)}

				{loading && keys.length === 0 && (
					<div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
						Loading config keys…
					</div>
				)}

				{!loading && displayKeys.length === 0 && (
					<div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
						No keys match your filter.
					</div>
				)}

				{sortedCategories.map((cat) => (
					<CategorySection
						key={cat}
						category={cat}
						keys={grouped.get(cat)!}
						onSave={handleSave}
					/>
				))}
			</div>

			{/* Toast layer */}
			<div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 pointer-events-none">
				{saveToasts.map((t) => (
					<div
						key={t.id}
						className={`px-4 py-2 rounded-md shadow text-sm font-medium ${
							t.ok
								? "bg-green-600 text-white"
								: "bg-red-600 text-white"
						}`}
					>
						{t.msg}
					</div>
				))}
			</div>
		</div>
	);
};

export default ConfigPage;
