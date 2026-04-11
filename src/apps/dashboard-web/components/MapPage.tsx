import type React from "react";
import { useEffect, useMemo, useState } from "react";
import LoadingSpinner from "./LoadingSpinner";

interface MapNode {
	id: string;
	title: string;
	status: string;
	type?: string;
	dependencies: string[];
}

const statusColor = (status: string) => {
	switch (status?.toLowerCase()) {
		case "complete":
			return "#10B981";
		case "develop":
			return "#3B82F6";
		case "review":
			return "#F59E0B";
		case "merge":
			return "#8B5CF6";
		case "draft":
			return "#9CA3AF";
		default:
			return "#6B7280";
	}
};

const MapPage: React.FC = () => {
	const [nodes, setNodes] = useState<MapNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedNode, setSelectedNode] = useState<string | null>(null);

	useEffect(() => {
		const fetchData = async () => {
			try {
				setError(null);
				const response = await fetch("/api/proposals?crossBranch=true");
				if (!response.ok) throw new Error("Failed to fetch proposals");
				const proposals: Array<{
					id: string;
					title: string;
					status: string;
					proposalType?: string;
					dependencies?: string[];
				}> = await response.json();
				const mapNodes: MapNode[] = proposals.map((p) => ({
					id: p.id,
					title: p.title,
					status: p.status,
					type: p.proposalType,
					dependencies: p.dependencies || [],
				}));
				setNodes(mapNodes);
			} catch (err) {
				console.error("Failed to fetch map data:", err);
				setError("Failed to load dependency map");
			} finally {
				setLoading(false);
			}
		};
		fetchData();
	}, []);

	const adjacencyList = useMemo(() => {
		const adj = new Map<string, string[]>();
		for (const node of nodes) {
			adj.set(node.id, []);
		}
		for (const node of nodes) {
			for (const dep of node.dependencies) {
				const list = adj.get(dep) || [];
				list.push(node.id);
				adj.set(dep, list);
			}
		}
		return adj;
	}, [nodes]);

	const selectedNodeData = useMemo(
		() => nodes.find((n) => n.id === selectedNode),
		[nodes, selectedNode],
	);

	const dependents = useMemo(
		() => (selectedNode ? adjacencyList.get(selectedNode) || [] : []),
		[adjacencyList, selectedNode],
	);

	const dependencies = useMemo(
		() => selectedNodeData?.dependencies || [],
		[selectedNodeData],
	);

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading dependency map...
				</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8 text-center">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<p className="text-red-600 dark:text-red-400 font-medium">Error</p>
					<p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Dependency Map ({nodes.length} proposals)
				</h1>
				<div className="flex items-center gap-4 text-xs">
					{[
						{ label: "Draft", color: "#9CA3AF" },
						{ label: "Review", color: "#F59E0B" },
						{ label: "Develop", color: "#3B82F6" },
						{ label: "Merge", color: "#8B5CF6" },
						{ label: "Complete", color: "#10B981" },
					].map(({ label, color }) => (
						<div key={label} className="flex items-center gap-1">
							<div
								className="w-3 h-3 rounded-full"
								style={{ backgroundColor: color }}
							/>
							<span className="text-gray-600 dark:text-gray-400">{label}</span>
						</div>
					))}
				</div>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Node List */}
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 max-h-[600px] overflow-y-auto">
					<h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
						Proposals
					</h2>
					<div className="space-y-1">
						{nodes.map((node) => (
							<button
								type="button"
								key={node.id}
								onClick={() =>
									setSelectedNode(selectedNode === node.id ? null : node.id)
								}
								className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
									selectedNode === node.id
										? "bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700"
										: "hover:bg-gray-50 dark:hover:bg-gray-700"
								}`}
							>
								<div className="flex items-center gap-2">
									<div
										className="w-2 h-2 rounded-full flex-shrink-0"
										style={{ backgroundColor: statusColor(node.status) }}
									/>
									<span className="font-mono text-xs text-gray-500 dark:text-gray-400">
										{node.id}
									</span>
								</div>
								<div className="text-gray-700 dark:text-gray-300 truncate mt-0.5 ml-4">
									{node.title}
								</div>
							</button>
						))}
					</div>
				</div>

				{/* Detail Panel */}
				<div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
					{selectedNodeData ? (
						<div className="space-y-6">
							<div>
								<div className="flex items-center gap-2 mb-2">
									<div
										className="w-3 h-3 rounded-full"
										style={{
											backgroundColor: statusColor(selectedNodeData.status),
										}}
									/>
									<span className="font-mono text-sm text-gray-500 dark:text-gray-400">
										{selectedNodeData.id}
									</span>
								</div>
								<h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
									{selectedNodeData.title}
								</h2>
								<div className="flex items-center gap-2 mt-2">
									<span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs">
										{selectedNodeData.status}
									</span>
									{selectedNodeData.type && (
										<span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs">
											{selectedNodeData.type}
										</span>
									)}
								</div>
							</div>

							<div className="grid grid-cols-2 gap-6">
								<div>
									<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
										Depends On ({dependencies.length})
									</h3>
									{dependencies.length === 0 ? (
										<p className="text-sm text-gray-500 dark:text-gray-400">
											No dependencies
										</p>
									) : (
										<div className="space-y-1">
											{dependencies.map((depId) => {
												const depNode = nodes.find((n) => n.id === depId);
												return (
													<button
														type="button"
														key={depId}
														onClick={() => setSelectedNode(depId)}
														className="w-full text-left px-2 py-1 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
													>
														{depNode && (
															<div
																className="w-2 h-2 rounded-full"
																style={{
																	backgroundColor: statusColor(depNode.status),
																}}
															/>
														)}
														<span className="font-mono text-xs">{depId}</span>
														{depNode && (
															<span className="text-gray-500 dark:text-gray-400 truncate">
																— {depNode.title}
															</span>
														)}
													</button>
												);
											})}
										</div>
									)}
								</div>

								<div>
									<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
										Blocking ({dependents.length})
									</h3>
									{dependents.length === 0 ? (
										<p className="text-sm text-gray-500 dark:text-gray-400">
											Not blocking anything
										</p>
									) : (
										<div className="space-y-1">
											{dependents.map((depId) => {
												const depNode = nodes.find((n) => n.id === depId);
												return (
													<button
														type="button"
														key={depId}
														onClick={() => setSelectedNode(depId)}
														className="w-full text-left px-2 py-1 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
													>
														{depNode && (
															<div
																className="w-2 h-2 rounded-full"
																style={{
																	backgroundColor: statusColor(depNode.status),
																}}
															/>
														)}
														<span className="font-mono text-xs">{depId}</span>
														{depNode && (
															<span className="text-gray-500 dark:text-gray-400 truncate">
																— {depNode.title}
															</span>
														)}
													</button>
												);
											})}
										</div>
									)}
								</div>
							</div>
						</div>
					) : (
						<div className="text-center py-16 text-gray-500 dark:text-gray-400">
							Select a proposal from the list to view its dependencies
						</div>
					)}
				</div>
			</div>

			{nodes.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No proposals to display
				</div>
			)}
		</div>
	);
};

export default MapPage;
