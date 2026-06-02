import { useCallback, useEffect, useRef, useState } from "react";

export interface BoardColumn {
	stage_name: string;
	stage_order: number;
	display_label: string;
	is_terminal: boolean;
	maturity_gate: number | null;
}

const FALLBACK_COLUMNS: BoardColumn[] = [
	{ stage_name: "DRAFT",    stage_order: 1, display_label: "Draft",    is_terminal: false, maturity_gate: null },
	{ stage_name: "REVIEW",   stage_order: 2, display_label: "Review",   is_terminal: false, maturity_gate: null },
	{ stage_name: "DEVELOP",  stage_order: 3, display_label: "Develop",  is_terminal: false, maturity_gate: null },
	{ stage_name: "MERGE",    stage_order: 4, display_label: "Merge",    is_terminal: false, maturity_gate: null },
	{ stage_name: "COMPLETE", stage_order: 5, display_label: "Complete", is_terminal: true,  maturity_gate: null },
];

/**
 * Fetches workflow columns from /api/board/columns.
 * Refreshes on mount, workflowName change, and board_reload WebSocket events.
 * Falls back to FALLBACK_COLUMNS on error.
 */
export function useBoardColumns(workflowName: string = "Standard RFC"): {
	columns: BoardColumn[];
	loading: boolean;
	error: string | null;
} {
	const [columns, setColumns]   = useState<BoardColumn[]>(FALLBACK_COLUMNS);
	const [loading, setLoading]   = useState(true);
	const [error, setError]       = useState<string | null>(null);
	const workflowRef             = useRef(workflowName);
	workflowRef.current           = workflowName;

	const fetchColumns = useCallback(async (wf: string) => {
		try {
			setLoading(true);
			setError(null);

			const url = new URL("/api/board/columns", window.location.origin);
			url.searchParams.set("workflowName", wf);

			const response = await fetch(url.toString());
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const data = (await response.json()) as BoardColumn[];
			setColumns(Array.isArray(data) && data.length > 0 ? data : FALLBACK_COLUMNS);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to fetch board columns";
			setError(msg);
			setColumns(FALLBACK_COLUMNS);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchColumns(workflowName);
	}, [workflowName, fetchColumns]);

	// Reuse the existing board_reload WebSocket signal — no second connection.
	useEffect(() => {
		const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl      = `${wsProtocol}//${window.location.host}/ws`;
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
							fetchColumns(workflowRef.current);
						}
					} catch {
						// ignore malformed frames
					}
				};
				ws.onclose = () => {
					if (!closed) reconnectTimer = setTimeout(connect, 5000);
				};
				ws.onerror = () => { ws?.close(); };
			} catch {
				// WebSocket unavailable (SSR/test) — skip
			}
		};

		connect();

		return () => {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			ws?.close();
		};
	}, [fetchColumns]);

	return { columns, loading, error };
}
