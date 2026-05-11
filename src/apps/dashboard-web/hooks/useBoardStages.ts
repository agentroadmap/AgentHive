import { useCallback, useEffect, useRef, useState } from "react";

export interface BoardStage {
	id: string;
	stageName: string;
	label: string;
	displayLabel: string;
	hexColor: string | null;
	order: number;
	isTerminal?: boolean;
}

interface BoardStagesResponse {
	stages: BoardStage[];
	workflow: string;
	error?: string;
}

const FALLBACK_STAGES: BoardStage[] = [
	{ id: "DRAFT", stageName: "DRAFT", label: "Draft", displayLabel: "Draft", hexColor: null, order: 1, isTerminal: false },
	{ id: "REVIEW", stageName: "REVIEW", label: "Review", displayLabel: "Review", hexColor: null, order: 2, isTerminal: false },
	{ id: "DEVELOP", stageName: "DEVELOP", label: "Develop", displayLabel: "Develop", hexColor: null, order: 3, isTerminal: false },
	{ id: "MERGE", stageName: "MERGE", label: "Merge", displayLabel: "Merge", hexColor: null, order: 4, isTerminal: false },
	{ id: "COMPLETE", stageName: "COMPLETE", label: "Complete", displayLabel: "Complete", hexColor: null, order: 5, isTerminal: true },
];

/**
 * Hook to fetch dynamic board stages from the API.
 * Re-fetches when the workflow changes or when a `board_reload` WebSocket
 * event is received (fired after workflow_stage_changed pg_notify).
 * Falls back to FALLBACK_STAGES if the fetch fails.
 */
export function useBoardStages(
	workflow: string = "Standard RFC",
): {
	stages: BoardStage[];
	loading: boolean;
	error: string | null;
	workflow: string;
} {
	const [stages, setStages] = useState<BoardStage[]>(FALLBACK_STAGES);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeWorkflow, setActiveWorkflow] = useState(workflow);
	const workflowRef = useRef(workflow);
	workflowRef.current = workflow;

	const fetchStages = useCallback(async (wf: string) => {
		try {
			setLoading(true);
			setError(null);

			const url = new URL("/api/board/stages", window.location.origin);
			url.searchParams.set("workflow", wf);

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
			setStages(FALLBACK_STAGES);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchStages(workflow);
	}, [workflow, fetchStages]);

	// Listen for board_reload WebSocket events (emitted after workflow_stage_changed).
	useEffect(() => {
		const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
		let ws: WebSocket | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let closed = false;

		const connect = () => {
			if (closed) return;
			try {
				ws = new WebSocket(wsUrl);
				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(event.data as string);
						if (msg?.type === "board_reload") {
							fetchStages(workflowRef.current);
						}
					} catch {
						// ignore malformed frames
					}
				};
				ws.onclose = () => {
					if (!closed) {
						reconnectTimer = setTimeout(connect, 5000);
					}
				};
				ws.onerror = () => {
					ws?.close();
				};
			} catch {
				// WebSocket not available (SSR / test) — skip
			}
		};

		connect();

		return () => {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			ws?.close();
		};
	}, [fetchStages]);

	return { stages, loading, error, workflow: activeWorkflow };
}
