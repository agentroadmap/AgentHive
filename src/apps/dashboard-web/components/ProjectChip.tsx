// P477 AC-2: global project scope chip.
//
// Single dropdown rendered in the top navigation so every page reflects
// the operator's selected project. Backed by useProjectScope(); changing
// the value updates localStorage which fans out to apiClient + WebSocket
// via the project-scope-change event bus.

import type React from "react";
import { useProjectScope } from "../hooks/useProjectScope";

interface ProjectChipProps {
	/**
	 * Optional project_id observed in the latest server response. When
	 * present and different from the chip's current value, a small ⟳
	 * indicator surfaces the drift so the operator knows a refresh is
	 * coming. Hosts that don't track this can omit it.
	 */
	serverEcho?: { project_id: number } | null;
}

const ProjectChip: React.FC<ProjectChipProps> = ({ serverEcho }) => {
	const scope = useProjectScope();

	if (scope.loading) {
		return (
			<span className="text-xs text-gray-400 dark:text-gray-500">
				…
			</span>
		);
	}
	if (scope.projects.length === 0) {
		return null;
	}

	const drift =
		serverEcho &&
		scope.current &&
		serverEcho.project_id !== scope.current.project_id;

	return (
		<label className="inline-flex items-center gap-1.5 text-xs">
			<span className="text-gray-500 dark:text-gray-400 uppercase tracking-wide">
				project
			</span>
			<select
				value={scope.current?.project_id ?? ""}
				onChange={(e) => scope.setProjectId(Number(e.target.value))}
				className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-1.5 py-0.5 text-xs"
				aria-label="Active project"
			>
				{scope.projects.map((p) => (
					<option key={p.project_id} value={p.project_id}>
						{p.name} ({p.slug})
					</option>
				))}
			</select>
			{drift && (
				<span
					className="text-amber-700 dark:text-amber-300"
					title="Server returned a different project than the chip suggests; refresh imminent."
				>
					⟳
				</span>
			)}
		</label>
	);
};

export default ProjectChip;
