/**
 * CubicDashboard - Shows active cubics, their phases, and agents
 */

import type React from "react";

interface Cubic {
	cubicId: string;
	name?: string;
	phase: string;
	status: string;
	agentCount: number;
}

interface Agent {
	id: string;
	name: string;
	role: string;
	status: string;
}

interface CubicDashboardProps {
	cubics: Cubic[];
	agents: Agent[];
}

const PHASE_ICONS: Record<string, string> = {
	design: "🎨",
	build: "🔨",
	test: "🧪",
	ship: "🚀",
};

const PHASE_COLORS: Record<string, string> = {
	design: "border-purple-500 bg-purple-500/10",
	build: "border-blue-500 bg-blue-500/10",
	test: "border-yellow-500 bg-yellow-500/10",
	ship: "border-green-500 bg-green-500/10",
};

const AGENT_STATUS_COLORS: Record<string, string> = {
	active: "text-green-400",
	idle: "text-gray-400",
	blocked: "text-red-400",
	handoff: "text-yellow-400",
};

export function CubicDashboard({
	cubics,
	agents,
}: CubicDashboardProps): React.ReactElement {
	const phaseOrder = ["design", "build", "test", "ship"];

	return (
		<div className="flex flex-col h-full">
			<div className="px-3 py-2 border-b border-gray-700">
				<span className="text-sm font-semibold text-white">
					🧩 Cubic Dashboard
				</span>
				<span className="text-xs text-gray-500 ml-2">
					{cubics.length} cubics
				</span>
			</div>

			<div className="flex-1 overflow-y-auto p-2">
				{/* Phase pipeline */}
				<div className="grid grid-cols-4 gap-2 mb-4">
					{phaseOrder.map((phase) => {
						const phaseCubics = cubics.filter((c) => c.phase === phase);
						const icon = PHASE_ICONS[phase] || "📦";
						const colorClass =
							PHASE_COLORS[phase] || "border-gray-500 bg-gray-500/10";

						return (
							<div key={phase} className={`rounded border ${colorClass} p-2`}>
								<div className="text-center">
									<span className="text-lg">{icon}</span>
									<div className="text-xs font-medium text-white capitalize">
										{phase}
									</div>
									<div className="text-xs text-gray-400">
										{phaseCubics.length} cubic
										{phaseCubics.length !== 1 ? "s" : ""}
									</div>
								</div>

								{phaseCubics.map((cubic) => (
									<div key={cubic.cubicId} className="mt-2 text-xs">
										<div className="text-gray-300 truncate">
											{cubic.name || cubic.cubicId}
										</div>
										<div className="text-gray-500">
											{cubic.agentCount} agent
											{cubic.agentCount !== 1 ? "s" : ""}
										</div>
									</div>
								))}
							</div>
						);
					})}
				</div>

				{/* Agent roster */}
				<div className="border-t border-gray-700 pt-2">
					<div className="text-xs font-semibold text-gray-400 mb-2">
						Active Agents
					</div>
					<div className="space-y-1">
						{agents.length === 0 ? (
							<div className="text-gray-500 text-sm">No agents connected</div>
						) : (
							agents.map((agent) => (
								<div
									key={agent.id}
									className="flex items-center justify-between px-2 py-1 rounded hover:bg-gray-800/50"
								>
									<div className="flex items-center gap-2">
										<span className="text-sm">🤖</span>
										<span className="text-sm text-white">
											{agent.name || agent.id}
										</span>
										{agent.role && (
											<span className="text-xs px-1 rounded bg-gray-700 text-gray-300">
												{agent.role}
											</span>
										)}
									</div>
									<span
										className={`text-xs ${AGENT_STATUS_COLORS[agent.status] || "text-gray-400"}`}
									>
										{agent.status || "unknown"}
									</span>
								</div>
							))
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

export default CubicDashboard;
