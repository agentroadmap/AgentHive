import { useCallback, useEffect, useState } from "react";

export interface BoardColumn {
	stage_name: string;
	stage_order: number;
	display_label: string;
	is_terminal: boolean;
	maturity_gate: number | null;
	avg_dwell_days?: number | string | null;
}

const FALLBACK_COLUMNS: BoardColumn[] = [
	{
		stage_name: "DRAFT",
		stage_order: 1,
		display_label: "Draft",
		is_terminal: false,
		maturity_gate: null,
	},
	{
		stage_name: "REVIEW",
		stage_order: 2,
		display_label: "Review",
		is_terminal: false,
		maturity_gate: null,
	},
	{
		stage_name: "DEVELOP",
		stage_order: 3,
		display_label: "Develop",
		is_terminal: false,
		maturity_gate: null,
	},
	{
		stage_name: "MERGE",
		stage_order: 4,
		display_label: "Merge",
		is_terminal: false,
		maturity_gate: null,
	},
	{
		stage_name: "COMPLETE",
		stage_order: 5,
		display_label: "Complete",
		is_terminal: true,
		maturity_gate: null,
	},
];

export function useBoardColumns(
	workflowName = "Standard RFC",
	connected = false,
): {
	columns: BoardColumn[];
	isLoading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
} {
	const [columns, setColumns] = useState<BoardColumn[]>(FALLBACK_COLUMNS);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchColumns = useCallback(async () => {
		try {
			setIsLoading(true);
			setError(null);
			const url = new URL("/api/board/columns", window.location.origin);
			url.searchParams.set("workflowName", workflowName);

			const res = await fetch(url.toString());
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: ${res.statusText}`);
			}

			const data = (await res.json()) as BoardColumn[];
			if (Array.isArray(data) && data.length > 0) {
				setColumns(data);
			} else {
				setColumns(FALLBACK_COLUMNS);
			}
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to fetch board columns";
			setError(message);
			console.error("Error fetching board columns:", err);
			setColumns(FALLBACK_COLUMNS);
		} finally {
			setIsLoading(false);
		}
	}, [workflowName]);

	useEffect(() => {
		if (connected) {
			void fetchColumns();
			return;
		}
		void fetchColumns();
	}, [fetchColumns, connected]);

	return { columns, isLoading, error, refresh: fetchColumns };
}
