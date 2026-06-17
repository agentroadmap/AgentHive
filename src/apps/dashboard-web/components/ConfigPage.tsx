import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, type ConfigKeyDescriptor, type ConfigMutationResult } from "../lib/api";

const CLASS_BADGE: Record<string, string> = {
	flag: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
	registry: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
	structural: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
	secret: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
	tenant_dsn: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
};

// Known enum values for specific keys
const ENUM_OPTIONS: Record<string, string[]> = {
	AGENTHIVE_COCKPIT_LAYOUT: ["grid", "stacked"],
};

interface KeyMutationState {
	saving: boolean;
	error: string | null;
	flash: boolean;
}

function inferEditType(key: ConfigKeyDescriptor): "masked" | "readonly" | "boolean" | "number" | "enum" | "text" {
	if (key.masked || key.class === "secret") return "masked";
	if (key.class === "structural" || key.class === "tenant_dsn") return "readonly";
	if (!key.editable) return "readonly";
	if (ENUM_OPTIONS[key.name]) return "enum";
	if (typeof key.default_value === "boolean" || key.value === true || key.value === false) return "boolean";
	if (typeof key.default_value === "number") return "number";
	return "text";
}

interface ConfigKeyRowProps {
	keyDef: ConfigKeyDescriptor;
	mutState: KeyMutationState;
	onMutate: (keyName: string, value: unknown) => Promise<void>;
}

const ConfigKeyRow: React.FC<ConfigKeyRowProps> = ({ keyDef, mutState, onMutate }) => {
	const editType = inferEditType(keyDef);
	const [pendingText, setPendingText] = useState<string>(() => {
		if (keyDef.value === null || keyDef.value === undefined) return "";
		return String(keyDef.value);
	});
	const pendingRef = useRef(pendingText);
	pendingRef.current = pendingText;

	const handleBlur = useCallback(() => {
		const val = pendingRef.current;
		if (val === String(keyDef.value ?? "")) return;
		const parsed = editType === "number" ? Number(val) : val;
		onMutate(keyDef.name, parsed);
	}, [keyDef.name, keyDef.value, editType, onMutate]);

	const handleBoolToggle = useCallback(() => {
		onMutate(keyDef.name, !(keyDef.value));
	}, [keyDef.name, keyDef.value, onMutate]);

	const handleSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
		onMutate(keyDef.name, e.target.value);
	}, [keyDef.name, onMutate]);

	let valueCell: React.ReactNode;
	if (editType === "masked") {
		valueCell = <span className="text-gray-400 dark:text-gray-500 italic text-xs">(hidden)</span>;
	} else if (editType === "readonly") {
		valueCell = (
			<span className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
				{keyDef.value !== null && keyDef.value !== undefined ? String(keyDef.value) : "—"}
				<span className="ml-2 text-gray-400 dark:text-gray-500 text-xs italic">
					(deploy config)
				</span>
			</span>
		);
	} else if (editType === "boolean") {
		valueCell = (
			<input
				type="checkbox"
				checked={!!keyDef.value}
				disabled={mutState.saving}
				onChange={handleBoolToggle}
				className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
			/>
		);
	} else if (editType === "enum") {
		valueCell = (
			<select
				value={String(keyDef.value ?? "")}
				disabled={mutState.saving}
				onChange={handleSelectChange}
				className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm px-2 py-1 font-mono"
			>
				{(ENUM_OPTIONS[keyDef.name] ?? []).map((opt) => (
					<option key={opt} value={opt}>{opt}</option>
				))}
			</select>
		);
	} else if (editType === "number") {
		valueCell = (
			<input
				type="number"
				value={pendingText}
				disabled={mutState.saving}
				onChange={(e) => setPendingText(e.target.value)}
				onBlur={handleBlur}
				className="w-28 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm px-2 py-1 font-mono"
			/>
		);
	} else {
		valueCell = (
			<input
				type="text"
				value={pendingText}
				disabled={mutState.saving}
				onChange={(e) => setPendingText(e.target.value)}
				onBlur={handleBlur}
				className="w-48 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm px-2 py-1 font-mono"
			/>
		);
	}

	return (
		<tr
			className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
				mutState.flash ? "bg-green-50 dark:bg-green-900/20" : ""
			}`}
		>
			<td className="py-2 px-3 align-top">
				<span className="font-mono text-xs font-medium text-gray-900 dark:text-gray-100 break-all">
					{keyDef.name}
				</span>
				{keyDef.description && (
					<p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-xs">
						{keyDef.description}
					</p>
				)}
			</td>
			<td className="py-2 px-3 align-top whitespace-nowrap">
				<span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${CLASS_BADGE[keyDef.class] ?? ""}`}>
					{keyDef.class}
				</span>
			</td>
			<td className="py-2 px-3 align-top">
				<div className="flex flex-col gap-1">
					{valueCell}
					{mutState.saving && (
						<span className="text-xs text-blue-500">saving…</span>
					)}
					{mutState.error && (
						<span className="text-xs text-red-600 dark:text-red-400">{mutState.error}</span>
					)}
				</div>
			</td>
			<td className="py-2 px-3 align-top text-xs font-mono text-gray-500 dark:text-gray-400">
				{keyDef.default_value !== null && keyDef.default_value !== undefined
					? String(keyDef.default_value)
					: "—"}
			</td>
		</tr>
	);
};

interface CategorySectionProps {
	category: string;
	keys: ConfigKeyDescriptor[];
	mutStates: Map<string, KeyMutationState>;
	onMutate: (keyName: string, value: unknown) => Promise<void>;
}

const CategorySection: React.FC<CategorySectionProps> = ({ category, keys, mutStates, onMutate }) => {
	const [collapsed, setCollapsed] = useState(false);

	return (
		<div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
			<button
				type="button"
				onClick={() => setCollapsed((v) => !v)}
				className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800/70 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
			>
				<span className="font-semibold text-sm text-gray-800 dark:text-gray-200 capitalize">
					{category.replace(/_/g, " ")}
				</span>
				<div className="flex items-center gap-2">
					<span className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full">
						{keys.length}
					</span>
					<svg
						className={`w-4 h-4 text-gray-500 transition-transform ${collapsed ? "" : "rotate-90"}`}
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						aria-hidden="true"
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
					</svg>
				</div>
			</button>
			{!collapsed && (
				<div className="overflow-x-auto">
					<table className="min-w-full text-sm">
						<thead>
							<tr className="bg-gray-50/50 dark:bg-gray-800/30 text-xs text-gray-500 dark:text-gray-400">
								<th className="px-3 py-2 text-left font-medium w-1/3">Key / Description</th>
								<th className="px-3 py-2 text-left font-medium w-20">Class</th>
								<th className="px-3 py-2 text-left font-medium">Current Value</th>
								<th className="px-3 py-2 text-left font-medium w-32">Default</th>
							</tr>
						</thead>
						<tbody>
							{keys.map((key) => (
								<ConfigKeyRow
									key={key.name}
									keyDef={key}
									mutState={mutStates.get(key.name) ?? { saving: false, error: null, flash: false }}
									onMutate={onMutate}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
};

export default function ConfigPage() {
	const [keys, setKeys] = useState<ConfigKeyDescriptor[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [mutStates, setMutStates] = useState<Map<string, KeyMutationState>>(new Map());

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		apiClient
			.fetchConfigKeys()
			.then((ks) => {
				if (!cancelled) {
					setKeys(ks);
					setLoading(false);
				}
			})
			.catch((err: Error) => {
				if (!cancelled) {
					setLoadError(err.message ?? "Failed to load config keys");
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleMutate = useCallback(async (keyName: string, value: unknown) => {
		setMutStates((prev) => {
			const next = new Map(prev);
			next.set(keyName, { saving: true, error: null, flash: false });
			return next;
		});
		const savedValue = keys.find((k) => k.name === keyName)?.value;
		try {
			const result: ConfigMutationResult = await apiClient.mutateConfigKey(keyName, value);
			setKeys((prev) =>
				prev.map((k) => (k.name === keyName ? { ...k, value: result.new_value } : k)),
			);
			setMutStates((prev) => {
				const next = new Map(prev);
				next.set(keyName, { saving: false, error: null, flash: true });
				return next;
			});
			setTimeout(() => {
				setMutStates((prev) => {
					const next = new Map(prev);
					const cur = next.get(keyName);
					if (cur) next.set(keyName, { ...cur, flash: false });
					return next;
				});
			}, 1500);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Mutation failed";
			// Revert optimistic update
			setKeys((prev) =>
				prev.map((k) => (k.name === keyName ? { ...k, value: savedValue } : k)),
			);
			setMutStates((prev) => {
				const next = new Map(prev);
				next.set(keyName, { saving: false, error: msg, flash: false });
				return next;
			});
		}
	}, [keys]);

	// Group keys by category
	const grouped = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "general";
		if (!grouped.has(cat)) grouped.set(cat, []);
		grouped.get(cat)!.push(key);
	}
	const sortedCategories = [...grouped.keys()].sort();

	return (
		<div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
			<div className="mb-6">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Config</h1>
				<p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
					Runtime configuration registry. Flag and registry keys are editable inline;
					structural and secret keys are read-only.
				</p>
			</div>

			{loading && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">Loading config keys…</div>
			)}

			{loadError && (
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400 text-sm">
					{loadError}
				</div>
			)}

			{!loading && !loadError && keys.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No config keys found. Ensure operator token is set.
				</div>
			)}

			{!loading && sortedCategories.map((cat) => (
				<CategorySection
					key={cat}
					category={cat}
					keys={grouped.get(cat)!}
					mutStates={mutStates}
					onMutate={handleMutate}
				/>
			))}
		</div>
	);
}
