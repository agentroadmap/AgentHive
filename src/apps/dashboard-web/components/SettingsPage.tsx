import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { RoadmapConfig } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

const SettingsPage: React.FC = () => {
	const [config, setConfig] = useState<RoadmapConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchConfig();
			setConfig(data);
		} catch (err) {
			console.error("Failed to fetch config:", err);
			setError("Failed to load settings");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const handleSave = async () => {
		if (!config) return;
		setSaving(true);
		setSuccess(null);
		try {
			await apiClient.updateConfig(config);
			setSuccess("Settings saved successfully");
			setTimeout(() => setSuccess(null), 3000);
		} catch (err) {
			console.error("Failed to save config:", err);
			setError("Failed to save settings");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading settings...
				</p>
			</div>
		);
	}

	if (error && !config) {
		return (
			<div className="p-8 text-center">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<p className="text-red-600 dark:text-red-400 font-medium">Error</p>
					<p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
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

	if (!config) return null;

	return (
		<div className="space-y-6 max-w-2xl">
			<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
				Settings
			</h1>

			{error && (
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
					<p className="text-red-600 dark:text-red-400">{error}</p>
				</div>
			)}

			{success && (
				<div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
					<p className="text-green-600 dark:text-green-400">{success}</p>
				</div>
			)}

			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 space-y-6">
				<div>
					<label
						htmlFor="project-name"
						className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
					>
						Project Name
					</label>
					<input
						id="project-name"
						type="text"
						value={config.projectName || ""}
						onChange={(e) =>
							setConfig({ ...config, projectName: e.target.value })
						}
						className="w-full rounded border px-3 py-2 text-sm bg-white dark:bg-gray-700"
					/>
				</div>

				<div>
					<label
						htmlFor="default-assignee"
						className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
					>
						Default Assignee
					</label>
					<input
						id="default-assignee"
						type="text"
						value={config.defaultAssignee || ""}
						onChange={(e) =>
							setConfig({ ...config, defaultAssignee: e.target.value })
						}
						className="w-full rounded border px-3 py-2 text-sm bg-white dark:bg-gray-700"
					/>
				</div>

				<div>
					<label
						htmlFor="default-port"
						className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
					>
						Default Port
					</label>
					<input
						id="default-port"
						type="number"
						value={config.defaultPort || 3000}
						onChange={(e) =>
							setConfig({
								...config,
								defaultPort: Number.parseInt(e.target.value, 10),
							})
						}
						className="w-full rounded border px-3 py-2 text-sm bg-white dark:bg-gray-700"
					/>
				</div>

				<div className="flex items-center gap-2">
					<input
						id="auto-commit"
						type="checkbox"
						checked={config.autoCommit || false}
						onChange={(e) =>
							setConfig({ ...config, autoCommit: e.target.checked })
						}
						className="rounded"
					/>
					<label
						htmlFor="auto-commit"
						className="text-sm text-gray-700 dark:text-gray-300"
					>
						Auto-commit changes
					</label>
				</div>

				<div className="flex items-center gap-2">
					<input
						id="auto-open-browser"
						type="checkbox"
						checked={config.autoOpenBrowser || false}
						onChange={(e) =>
							setConfig({ ...config, autoOpenBrowser: e.target.checked })
						}
						className="rounded"
					/>
					<label
						htmlFor="auto-open-browser"
						className="text-sm text-gray-700 dark:text-gray-300"
					>
						Auto-open browser on start
					</label>
				</div>

				<div>
					<label
						htmlFor="statuses"
						className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
					>
						Statuses (comma-separated)
					</label>
					<input
						id="statuses"
						type="text"
						value={(config.statuses || []).join(", ")}
						onChange={(e) =>
							setConfig({
								...config,
								statuses: e.target.value
									.split(",")
									.map((s) => s.trim())
									.filter(Boolean),
							})
						}
						className="w-full rounded border px-3 py-2 text-sm bg-white dark:bg-gray-700"
					/>
				</div>

				<div>
					<label
						htmlFor="labels"
						className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
					>
						Labels (comma-separated)
					</label>
					<input
						id="labels"
						type="text"
						value={(config.labels || []).join(", ")}
						onChange={(e) =>
							setConfig({
								...config,
								labels: e.target.value
									.split(",")
									.map((s) => s.trim())
									.filter(Boolean),
							})
						}
						className="w-full rounded border px-3 py-2 text-sm bg-white dark:bg-gray-700"
					/>
				</div>

				<div className="pt-4">
					<button
						type="button"
						onClick={handleSave}
						disabled={saving}
						className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
					>
						{saving ? "Saving..." : "Save Settings"}
					</button>
				</div>
			</div>
		</div>
	);
};

export default SettingsPage;
