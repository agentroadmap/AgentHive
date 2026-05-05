import { useEffect, useState } from "react";

export interface BoardStage {
	id: string;
	label: string;
	order: number;
	isTerminal?: boolean;
}

interface BoardStagesResponse {
	stages: BoardStage[];
	workflow: string;
	error?: string;
}

const FALLBACK_STATUSES: BoardStage[] = [
	{ id: "DRAFT", label: "DRAFT", order: 1, isTerminal: false },
	{ id: "REVIEW", label: "REVIEW", order: 2, isTerminal: false },
	{ id: "DEVELOP", label: "DEVELOP", order: 3, isTerminal: false },
	{ id: "MERGE", label: "MERGE", order: 4, isTerminal: false },
	{ id: "COMPLETE", label: "COMPLETE", order: 5, isTerminal: true },
];

/**
 * Hook to fetch dynamic board stages from the API.
 * Falls back to default STATUSES if fetch fails.
 */
export function useBoardStages(
	workflow: string = "Standard RFC",
): {
	stages: BoardStage[];
	loading: boolean;
	error: string | null;
	workflow: string;
} {
	const [stages, setStages] = useState<BoardStage[]>(FALLBACK_STATUSES);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeWorkflow, setActiveWorkflow] = useState(workflow);

	useEffect(() => {
		const fetchStages = async () => {
			try {
				setLoading(true);
				setError(null);

				const url = new URL("/api/board/stages", window.location.origin);
				url.searchParams.set("workflow", workflow);

				const response = await fetch(url.toString());
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}

				const data = (await response.json()) as BoardStagesResponse;
				setStages(data.stages);
				setActiveWorkflow(data.workflow);

				if (data.error) {
					console.warn("Board stages API warning:", data.error);
				}
			} catch (err) {
				const errorMsg =
					err instanceof Error ? err.message : "Failed to fetch board stages";
				setError(errorMsg);
				console.error("Error fetching board stages:", err);
				setStages(FALLBACK_STATUSES);
			} finally {
				setLoading(false);
			}
		};

		fetchStages();
	}, [workflow]);

	return { stages, loading, error, workflow: activeWorkflow };
}
