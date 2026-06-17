/**
 * P3785 — Config browse + inline edit page
 *
 * Renders all AllConfigKeys grouped by category with type-aware inline edit
 * controls for editable (flag/registry) keys. All mutations go through
 * PUT /api/config/:keyName (operator-gated, P828 audit path for flags).
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type ConfigKeyDescriptor, type ConfigMutationResult } from "../lib/api";

// ── Type inference ─────────────────────────────────────────────────────────────

const ENUM_KEYS: Record<string, string[]> = {
	AGENTHIVE_COCKPIT_LAYOUT: ["grid", "stacked"],
};

type EditControl = "masked" | "readonly" | "checkbox" | "number" | "select" | "text";

export function inferEditControl(key: ConfigKeyDescriptor): EditControl {
	if (key.masked || key.class === "secret") return "masked";
	if (!key.editable || key.class === "structural" || key.class === "tenant_dsn") return "readonly";
	if (ENUM_KEYS[key.name]) return "select";
	if (typeof key.default_value === "boolean") return "checkbox";
	if (typeof key.default_value === "number") return "number";
	return "text";
}

// ── Category grouping ─────────────────────────────────────────────────────────

export function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const bucket = key.category ?? "General";
		if (!map.has(bucket)) map.set(bucket, []);
		map.get(bucket)!.push(key);
	}
	return map;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLASS_BADGE: Record<string, string> = {
	flag: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
	registry: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
	structural: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
	secret: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
	tenant_dsn: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
};

function ClassBadge({ cls }: { cls: string }) {
	return (
		<span className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono font-medium ${CLASS_BADGE[cls] ?? "bg-gray-100 text-gray-600"}`}>
			{cls}
		</span>
	);
}

function displayValue(key: ConfigKeyDescriptor): string {
	if (key.masked) return "(hidden)";
	if (key.value === null || key.value === undefined) return "—";
	return String(key.value);
}

// ── Per-key mutation state ────────────────────────────────────────────────────

interface MutationState {
	saving: boolean;
	error: string | null;
	savedValue: unknown;
}

// ── ConfigKeyRow ──────────────────────────────────────────────────────────────

interface ConfigKeyRowProps {
	keyDesc: ConfigKeyDescriptor;
	mutState: MutationState;
	onMutate: (keyName: string, value: unknown) => void;
}

function ConfigKeyRow({ keyDesc, mutState, onMutate }: ConfigKeyRowProps) {
	const control = inferEditControl(keyDesc);
	const [localValue, setLocalValue] = useState<string>(() => {
		if (control === "masked" || control === "readonly") return displayValue(keyDesc);
		if (typeof keyDesc.value === "boolean") return String(keyDesc.value);
		return keyDesc.value !== null && keyDesc.value !== undefined ? String(keyDesc.value) : "";
	});

	// Sync from server value after save
	useEffect(() => {
		if (!mutState.saving && mutState.error === null && mutState.savedValue !== undefined) {
			setLocalValue(String(mutState.savedValue));
		}
	}, [mutState]);

	const handleBlur = () => {
		const currentDisplayed = displayValue(keyDesc);
		if (localValue === currentDisplayed) return;
		const parsed: unknown = localValue === "" ? "" : localValue;
		onMutate(keyDesc.name, parsed);
	};

	const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onMutate(keyDesc.name, e.target.checked);
	};

	const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onMutate(keyDesc.name, e.target.value);
	};

	const valueCell = (() => {
		switch (control) {
			case "masked":
				return <span className="text-gray-400 italic text-xs">(hidden)</span>;
			case "readonly":
				return (
					<span className="font-mono text-xs text-gray-700 dark:text-gray-300">
						{displayValue(keyDesc)}
						{(keyDesc.class === "structural" || keyDesc.class === "tenant_dsn") && (
							<span className="ml-2 text-gray-400 text-xs">env/deploy</span>
						)}
					</span>
				);
			case "checkbox":
				return (
					<input
						type="checkbox"
						checked={localValue === "true"}
						disabled={mutState.saving}
						onChange={handleCheckboxChange}
						className="h-4 w-4 rounded border-gray-300 text-blue-600 disabled:opacity-50"
						aria-label={`Toggle ${keyDesc.name}`}
					/>
				);
			case "number":
				return (
					<input
						type="number"
						value={localValue}
						disabled={mutState.saving}
						onChange={(e) => setLocalValue(e.target.value)}
						onBlur={handleBlur}
						className="w-24 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-mono disabled:opacity-50"
						aria-label={`Edit ${keyDesc.name}`}
					/>
				);
			case "select":
				return (
					<select
						value={localValue}
						disabled={mutState.saving}
						onChange={handleSelectChange}
						className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-mono disabled:opacity-50"
						aria-label={`Select ${keyDesc.name}`}
					>
						{(ENUM_KEYS[keyDesc.name] ?? []).map((opt) => (
							<option key={opt} value={opt}>{opt}</option>
						))}
					</select>
				);
			case "text":
			default:
				return (
					<input
						type="text"
						value={localValue}
						disabled={mutState.saving}
						onChange={(e) => setLocalValue(e.target.value)}
						onBlur={handleBlur}
						className="w-48 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-mono disabled:opacity-50"
						aria-label={`Edit ${keyDesc.name}`}
					/>
				);
		}
	})();

	return (
		<>
			<tr className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
				<td className="px-3 py-2 align-top w-0 whitespace-nowrap">
					<span className="font-mono text-xs text-gray-900 dark:text-gray-100">{keyDesc.name}</span>
					{keyDesc.description && (
						<div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-xs truncate" title={keyDesc.description}>
							{keyDesc.description}
						</div>
					)}
				</td>
				<td className="px-3 py-2 align-top w-0 whitespace-nowrap">
					<ClassBadge cls={keyDesc.class} />
				</td>
				<td className="px-3 py-2 align-top w-0 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
					{keyDesc.scope ?? "global"}
				</td>
				<td className="px-3 py-2 align-top">
					{valueCell}
					{mutState.saving && (
						<span className="ml-2 text-xs text-gray-400 animate-pulse">saving…</span>
					)}
					{mutState.error && (
						<div className="text-xs text-red-600 dark:text-red-400 mt-0.5">{mutState.error}</div>
					)}
				</td>
				<td className="px-3 py-2 align-top w-0 whitespace-nowrap font-mono text-xs text-gray-400 dark:text-gray-500">
					{keyDesc.default_value !== null && keyDesc.default_value !== undefined
						? String(keyDesc.default_value)
						: "—"}
				</td>
			</tr>
		</>
	);
}

// ── ConfigCategorySection ─────────────────────────────────────────────────────

interface CategorySectionProps {
	category: string;
	keys: ConfigKeyDescriptor[];
	mutStates: Map<string, MutationState>;
	onMutate: (keyName: string, value: unknown) => void;
}

function ConfigCategorySection({ category, keys, mutStates, onMutate }: CategorySectionProps) {
	const [collapsed, setCollapsed] = useState(false);

	return (
		<section className="mb-4">
			<button
				type="button"
				className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-t border border-gray-200 dark:border-gray-700 text-left hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
				onClick={() => setCollapsed((v) => !v)}
				aria-expanded={!collapsed}
			>
				<span className="font-semibold text-sm text-gray-800 dark:text-gray-200 capitalize">{category}</span>
				<span className="text-xs text-gray-500 dark:text-gray-400">({keys.length})</span>
				<span className="ml-auto text-gray-400 text-xs">{collapsed ? "▶" : "▼"}</span>
			</button>
			{!collapsed && (
				<div className="overflow-x-auto border border-t-0 border-gray-200 dark:border-gray-700 rounded-b">
					<table className="min-w-full text-sm">
						<thead>
							<tr className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
								<th className="px-3 py-1.5 text-left font-medium">Key</th>
								<th className="px-3 py-1.5 text-left font-medium">Class</th>
								<th className="px-3 py-1.5 text-left font-medium">Scope</th>
								<th className="px-3 py-1.5 text-left font-medium">Value</th>
								<th className="px-3 py-1.5 text-left font-medium">Default</th>
							</tr>
						</thead>
						<tbody>
							{keys.map((key) => (
								<ConfigKeyRow
									key={key.name}
									keyDesc={key}
									mutState={mutStates.get(key.name) ?? { saving: false, error: null, savedValue: undefined }}
									onMutate={onMutate}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

// ── ConfigPage ────────────────────────────────────────────────────────────────

const ConfigPage: React.FC = () => {
	const [keys, setKeys] = useState<ConfigKeyDescriptor[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [mutStates, setMutStates] = useState<Map<string, MutationState>>(new Map());

	const load = useCallback(async () => {
		try {
			setError(null);
			const fetched = await apiClient.fetchConfigKeys();
			setKeys(fetched);
		} catch (err) {
			console.error("Failed to fetch config keys:", err);
			setError("Failed to load config keys");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const handleMutate = useCallback(async (keyName: string, value: unknown) => {
		setMutStates((prev) => {
			const next = new Map(prev);
			next.set(keyName, { saving: true, error: null, savedValue: undefined });
			return next;
		});

		try {
			const result: ConfigMutationResult = await apiClient.mutateConfigKey(keyName, value);
			setKeys((prev) =>
				prev.map((k) => (k.name === keyName ? { ...k, value: result.new_value } : k)),
			);
			setMutStates((prev) => {
				const next = new Map(prev);
				next.set(keyName, { saving: false, error: null, savedValue: result.new_value });
				return next;
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Save failed";
			setMutStates((prev) => {
				const next = new Map(prev);
				next.set(keyName, { saving: false, error: msg, savedValue: undefined });
				return next;
			});
		}
	}, []);

	const grouped = groupByCategory(keys);

	return (
		<div className="p-4 sm:p-6 max-w-6xl mx-auto">
			<div className="flex items-center justify-between mb-4">
				<div>
					<h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Config</h1>
					<p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
						Runtime flags and registry keys. Edits are operator-audited.
					</p>
				</div>
				<button
					type="button"
					onClick={() => void load()}
					disabled={loading}
					className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
				>
					{loading ? "Loading…" : "Refresh"}
				</button>
			</div>

			{error && (
				<div className="mb-4 px-4 py-3 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
					{error}
				</div>
			)}

			{loading && !keys.length && (
				<div className="text-center py-12 text-gray-400 text-sm">Loading config keys…</div>
			)}

			{!loading && !keys.length && !error && (
				<div className="text-center py-12 text-gray-400 text-sm">No config keys found.</div>
			)}

			{Array.from(grouped.entries()).map(([category, catKeys]) => (
				<ConfigCategorySection
					key={category}
					category={category}
					keys={catKeys}
					mutStates={mutStates}
					onMutate={handleMutate}
				/>
			))}
		</div>
	);
};

export default ConfigPage;
