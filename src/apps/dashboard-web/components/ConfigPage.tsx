/**
 * P3785 — Web config interface
 *
 * Displays all AllConfigKeys entries grouped by category.
 * - flag / registry keys: editable inline
 * - structural keys: read-only
 * - secret / tenant_dsn keys: value masked, no edit control
 * Mutations route through PUT /api/config/keys/:keyName (operator-gated).
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type ConfigKeyDescriptor } from "../lib/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "boolean") return String(v);
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "general";
		if (!map.has(cat)) map.set(cat, []);
		map.get(cat)!.push(key);
	}
	return map;
}

// ── EditControl ───────────────────────────────────────────────────────────────

interface EditControlProps {
	descriptor: ConfigKeyDescriptor;
	onSave: (keyName: string, value: unknown) => Promise<void>;
}

function EditControl({ descriptor, onSave }: EditControlProps) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(formatValue(descriptor.value));
	const [saving, setSaving] = useState(false);
	const [flash, setFlash] = useState<"success" | "error" | null>(null);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const currentVal = formatValue(descriptor.value);

	async function handleSave() {
		setSaving(true);
		setErrorMsg(null);
		try {
			let parsed: unknown = draft;
			// Coerce to boolean for flag-type booleans
			if (draft === "true") parsed = true;
			else if (draft === "false") parsed = false;
			await onSave(descriptor.name, parsed);
			setFlash("success");
			setEditing(false);
		} catch (err) {
			setErrorMsg((err as Error).message ?? "Mutation failed");
			setFlash("error");
		} finally {
			setSaving(false);
			setTimeout(() => setFlash(null), 2000);
		}
	}

	function handleCancel() {
		setDraft(currentVal);
		setEditing(false);
		setErrorMsg(null);
	}

	const inputClass =
		"bg-gray-700 border border-gray-500 rounded px-2 py-0.5 text-sm text-white w-48 focus:outline-none focus:border-blue-400";

	const isBoolLike = currentVal === "true" || currentVal === "false" || draft === "true" || draft === "false";

	if (!editing) {
		return (
			<span className="flex items-center gap-2">
				<span
					className={`font-mono text-sm px-1 rounded transition-colors ${
						flash === "success"
							? "bg-green-700 text-white"
							: flash === "error"
								? "bg-red-700 text-white"
								: "text-gray-200"
					}`}
				>
					{currentVal || <span className="text-gray-500 italic">—</span>}
				</span>
				<button
					onClick={() => {
						setDraft(currentVal);
						setEditing(true);
					}}
					className="text-xs text-blue-400 hover:text-blue-300 underline"
				>
					edit
				</button>
			</span>
		);
	}

	return (
		<span className="flex flex-col gap-1">
			<span className="flex items-center gap-2">
				{isBoolLike ? (
					<select
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						className={inputClass}
					>
						<option value="true">true</option>
						<option value="false">false</option>
					</select>
				) : (
					<input
						type="text"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						className={inputClass}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleSave();
							if (e.key === "Escape") handleCancel();
						}}
						autoFocus
					/>
				)}
				<button
					onClick={handleSave}
					disabled={saving}
					className="text-xs text-green-400 hover:text-green-300 disabled:opacity-50"
				>
					{saving ? "saving…" : "save"}
				</button>
				<button onClick={handleCancel} className="text-xs text-gray-400 hover:text-gray-300">
					cancel
				</button>
			</span>
			{errorMsg && <span className="text-xs text-red-400">{errorMsg}</span>}
		</span>
	);
}

// ── ConfigRow ─────────────────────────────────────────────────────────────────

interface ConfigRowProps {
	descriptor: ConfigKeyDescriptor;
	onSave: (keyName: string, value: unknown) => Promise<void>;
}

export function ConfigRow({ descriptor, onSave }: ConfigRowProps) {
	const classBadgeColor: Record<string, string> = {
		flag: "bg-blue-800 text-blue-200",
		registry: "bg-purple-800 text-purple-200",
		structural: "bg-gray-700 text-gray-300",
		secret: "bg-red-900 text-red-300",
		tenant_dsn: "bg-yellow-900 text-yellow-300",
	};

	return (
		<tr className="border-b border-gray-700 hover:bg-gray-750">
			<td className="py-2 pr-4 font-mono text-xs text-gray-200 whitespace-nowrap">{descriptor.name}</td>
			<td className="py-2 pr-4">
				<span
					className={`text-xs px-1.5 py-0.5 rounded font-mono ${classBadgeColor[descriptor.class] ?? "bg-gray-700 text-gray-300"}`}
				>
					{descriptor.class}
				</span>
			</td>
			<td className="py-2 pr-4 text-xs text-gray-400 max-w-xs">{descriptor.description ?? ""}</td>
			<td className="py-2">
				{descriptor.masked ? (
					<span className="font-mono text-xs text-gray-500 italic">(hidden)</span>
				) : descriptor.editable ? (
					<EditControl descriptor={descriptor} onSave={onSave} />
				) : (
					<span className="flex flex-col gap-0.5">
						<span className="font-mono text-sm text-gray-300">
							{formatValue(descriptor.value) || <span className="text-gray-600 italic">—</span>}
						</span>
						{(descriptor.class === "structural" || descriptor.class === "tenant_dsn") && (
							<span className="text-xs text-gray-500 italic">set via env / deploy config · requires restart</span>
						)}
					</span>
				)}
			</td>
		</tr>
	);
}

// ── CategorySection ───────────────────────────────────────────────────────────

interface CategorySectionProps {
	category: string;
	keys: ConfigKeyDescriptor[];
	onSave: (keyName: string, value: unknown) => Promise<void>;
}

export function CategorySection({ category, keys, onSave }: CategorySectionProps) {
	const [open, setOpen] = useState(true);

	return (
		<section className="mb-6">
			<button
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-2 w-full text-left mb-2 group"
			>
				<span className="text-gray-400 text-xs">{open ? "▾" : "▸"}</span>
				<h2 className="text-sm font-semibold uppercase tracking-wider text-gray-300 group-hover:text-white">
					{category}
				</h2>
				<span className="text-xs text-gray-500">({keys.length})</span>
			</button>
			{open && (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs text-gray-500 border-b border-gray-700">
								<th className="pb-1 pr-4 font-normal">key</th>
								<th className="pb-1 pr-4 font-normal">class</th>
								<th className="pb-1 pr-4 font-normal">description</th>
								<th className="pb-1 font-normal">value</th>
							</tr>
						</thead>
						<tbody>
							{keys.map((k) => (
								<ConfigRow key={k.name} descriptor={k} onSave={onSave} />
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

// ── ConfigPage ────────────────────────────────────────────────────────────────

export default function ConfigPage() {
	const [keys, setKeys] = useState<ConfigKeyDescriptor[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filterCategory, setFilterCategory] = useState<string>("");

	const load = useCallback(async () => {
		try {
			const data = await apiClient.fetchConfigKeys();
			setKeys(data);
			setError(null);
		} catch (err) {
			setError((err as Error).message ?? "Failed to load config keys");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
		const id = setInterval(load, 30_000);
		return () => clearInterval(id);
	}, [load]);

	const handleSave = useCallback(
		async (keyName: string, value: unknown) => {
			await apiClient.mutateConfigKey(keyName, value);
			// Refresh to pick up the newly persisted value
			await load();
		},
		[load],
	);

	const filtered = filterCategory
		? keys.filter((k) => (k.category ?? "general") === filterCategory)
		: keys;
	const grouped = groupByCategory(filtered);
	const categories = Array.from(grouped.keys()).sort();
	const allCategories = Array.from(new Set(keys.map((k) => k.category ?? "general"))).sort();

	return (
		<div className="p-6 text-white">
			<div className="flex items-center justify-between mb-6">
				<div>
					<h1 className="text-xl font-bold">Runtime Config</h1>
					<p className="text-sm text-gray-400 mt-1">
						All AllConfigKeys entries. Editable keys (flag/registry) are operator-gated.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<select
						value={filterCategory}
						onChange={(e) => setFilterCategory(e.target.value)}
						className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-400"
					>
						<option value="">All categories</option>
						{allCategories.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
					<button
						onClick={load}
						className="text-sm text-gray-400 hover:text-white border border-gray-600 rounded px-3 py-1.5"
					>
						Refresh
					</button>
				</div>
			</div>

			{loading && <p className="text-gray-400 text-sm">Loading config keys…</p>}
			{error && (
				<div className="bg-red-900/40 border border-red-700 rounded p-3 mb-4 text-sm text-red-300">
					{error}
				</div>
			)}

			{!loading && !error && keys.length === 0 && (
				<p className="text-gray-500 text-sm">No config keys found.</p>
			)}

			{categories.map((cat) => (
				<CategorySection
					key={cat}
					category={cat}
					keys={grouped.get(cat)!}
					onSave={handleSave}
				/>
			))}
		</div>
	);
}
