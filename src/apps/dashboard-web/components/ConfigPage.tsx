import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type ConfigKeyDescriptor } from "../lib/api";
import { getStoredOperatorToken } from "../lib/operator-token-storage";

// Group keys by class for display sections
const CLASS_ORDER: ConfigKeyDescriptor["class"][] = [
	"registry",
	"flag",
	"structural",
	"secret",
	"tenant_dsn",
];

const CLASS_LABELS: Record<ConfigKeyDescriptor["class"], string> = {
	registry: "Runtime Registry",
	flag: "Feature Flags",
	structural: "Structural (Env / Deploy)",
	secret: "Secrets",
	tenant_dsn: "Tenant DSNs",
};

function groupByClass(
	keys: ConfigKeyDescriptor[],
): Record<string, ConfigKeyDescriptor[]> {
	const groups: Record<string, ConfigKeyDescriptor[]> = {};
	for (const key of keys) {
		const g = key.class ?? "registry";
		if (!groups[g]) groups[g] = [];
		groups[g].push(key);
	}
	return groups;
}

function ValueCell({
	descriptor,
	onSaved,
}: {
	descriptor: ConfigKeyDescriptor;
	onSaved: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(String(descriptor.value ?? ""));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const token = getStoredOperatorToken();

	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			await apiClient.mutateConfigKey(descriptor.name, draft);
			setSaved(true);
			setEditing(false);
			setTimeout(() => setSaved(false), 2000);
			onSaved();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setSaving(false);
		}
	}, [descriptor.name, draft, onSaved]);

	if (descriptor.masked) {
		return (
			<span className="text-gray-400 dark:text-gray-500 italic text-sm">
				(hidden)
			</span>
		);
	}

	if (!descriptor.editable) {
		return (
			<span className="font-mono text-xs text-gray-600 dark:text-gray-300 break-all">
				{descriptor.value != null ? String(descriptor.value) : (
					<span className="text-gray-400 italic">
						{descriptor.default_value != null
							? `default: ${String(descriptor.default_value)}`
							: "—"}
					</span>
				)}
			</span>
		);
	}

	if (editing) {
		return (
			<span className="flex items-center gap-2 flex-wrap">
				{descriptor.class === "flag" ? (
					<select
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
					>
						<option value="true">true</option>
						<option value="false">false</option>
					</select>
				) : (
					<input
						type="text"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs font-mono bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-64"
						onKeyDown={(e) => {
							if (e.key === "Enter") handleSave();
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
					/>
				)}
				<button
					type="button"
					onClick={handleSave}
					disabled={saving}
					className="text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50"
				>
					{saving ? "Saving…" : "Save"}
				</button>
				<button
					type="button"
					onClick={() => { setEditing(false); setError(null); }}
					className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				{error && (
					<span className="text-red-500 text-xs">{error}</span>
				)}
			</span>
		);
	}

	return (
		<span className="flex items-center gap-2 group">
			<span className="font-mono text-xs text-gray-600 dark:text-gray-300 break-all">
				{descriptor.value != null ? String(descriptor.value) : (
					<span className="text-gray-400 italic">
						{descriptor.default_value != null
							? `default: ${String(descriptor.default_value)}`
							: "—"}
					</span>
				)}
			</span>
			{saved ? (
				<span className="text-green-500 text-xs">✓</span>
			) : (
				token && (
					<button
						type="button"
						onClick={() => {
							setDraft(String(descriptor.value ?? descriptor.default_value ?? ""));
							setEditing(true);
						}}
						className="text-xs text-indigo-500 hover:text-indigo-700 opacity-0 group-hover:opacity-100 transition-opacity"
					>
						Edit
					</button>
				)
			)}
		</span>
	);
}

function ClassSection({
	cls,
	keys,
	onSaved,
}: {
	cls: ConfigKeyDescriptor["class"];
	keys: ConfigKeyDescriptor[];
	onSaved: () => void;
}) {
	const [collapsed, setCollapsed] = useState(cls === "secret" || cls === "tenant_dsn");

	return (
		<div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
			>
				<span className="font-semibold text-sm text-gray-700 dark:text-gray-200">
					{CLASS_LABELS[cls] ?? cls}
					<span className="ml-2 text-xs font-normal text-gray-400">
						({keys.length})
					</span>
				</span>
				<span className="text-gray-400 text-xs">{collapsed ? "▶" : "▼"}</span>
			</button>
			{!collapsed && (
				<div className="divide-y divide-gray-100 dark:divide-gray-700/50">
					{cls === "structural" && (
						<div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-300">
							Set via env / deploy config — not editable at runtime.
						</div>
					)}
					{keys.map((key) => (
						<div
							key={key.name}
							className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4"
						>
							<div className="sm:w-64 shrink-0">
								<div className="font-mono text-xs font-medium text-gray-800 dark:text-gray-100">
									{key.name}
									{key.required && (
										<span className="ml-1 text-red-400" title="required">*</span>
									)}
								</div>
								{key.description && (
									<div className="text-xs text-gray-400 mt-0.5 leading-snug">
										{key.description}
									</div>
								)}
							</div>
							<div className="flex-1 min-w-0">
								<ValueCell descriptor={key} onSaved={onSaved} />
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default function ConfigPage() {
	const [keys, setKeys] = useState<ConfigKeyDescriptor[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await apiClient.fetchConfigKeys();
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

	const filtered = search.trim()
		? keys.filter(
				(k) =>
					k.name.toLowerCase().includes(search.toLowerCase()) ||
					(k.description ?? "").toLowerCase().includes(search.toLowerCase()),
			)
		: keys;

	const groups = groupByClass(filtered);

	return (
		<div className="p-4 sm:p-6 max-w-5xl mx-auto">
			<div className="flex items-center justify-between mb-6">
				<div>
					<h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
						Config
					</h1>
					<p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
						Runtime configuration registry. Editable keys require an operator token.
					</p>
				</div>
				<button
					type="button"
					onClick={load}
					disabled={loading}
					className="text-sm px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
				>
					{loading ? "Loading…" : "Refresh"}
				</button>
			</div>

			<div className="mb-4">
				<input
					type="search"
					placeholder="Filter keys…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="w-full sm:w-80 border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
				/>
			</div>

			{error && (
				<div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
					{error}
				</div>
			)}

			{!loading && !error && filtered.length === 0 && (
				<div className="text-sm text-gray-400 text-center py-12">
					{search ? "No keys match the filter." : "No config keys found."}
				</div>
			)}

			{CLASS_ORDER.filter((cls) => groups[cls]?.length > 0).map((cls) => (
				<ClassSection
					key={cls}
					cls={cls}
					keys={groups[cls]}
					onSaved={load}
				/>
			))}

			{/* Render any classes not in CLASS_ORDER (future-proofing) */}
			{Object.keys(groups)
				.filter((cls) => !CLASS_ORDER.includes(cls as ConfigKeyDescriptor["class"]))
				.map((cls) => (
					<ClassSection
						key={cls}
						cls={cls as ConfigKeyDescriptor["class"]}
						keys={groups[cls]}
						onSaved={load}
					/>
				))}
		</div>
	);
}
