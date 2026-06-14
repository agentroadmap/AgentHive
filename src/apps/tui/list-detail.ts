/**
 * P1067 — common LIST/DETAIL scaffolding (pure).
 *
 * Both P1065 (presence board → row list + per-agent detail) and P1066 (config
 * editor → flag list + edit detail) need the same cursor/selection/scroll math.
 * Extracting it here keeps that logic identical and headlessly testable, and it
 * is exactly the per-panel state the registry preserves across switches (AC-15).
 */

/** Serializable per-panel cursor state preserved across switches (AC-15). */
export interface ListState {
	/** Index of the highlighted row. */
	cursor: number;
	/** Topmost visible row (scroll offset). */
	top: number;
	/** Active filter string (opaque to the scaffolding; panels interpret it). */
	filter: string;
}

export function emptyListState(): ListState {
	return { cursor: 0, top: 0, filter: "" };
}

/** Clamp `n` into [0, length-1]; returns 0 for an empty list. */
export function clampCursor(n: number, length: number): number {
	if (length <= 0) return 0;
	if (n < 0) return 0;
	if (n >= length) return length - 1;
	return n;
}

/**
 * Move the cursor by `delta` rows within a list of `length`, recomputing the
 * scroll `top` so the cursor stays inside a viewport of `viewport` rows. Returns
 * a NEW state (pure); callers store it back via registry.saveState (AC-15).
 */
export function moveCursor(
	state: ListState,
	delta: number,
	length: number,
	viewport: number,
): ListState {
	const cursor = clampCursor(state.cursor + delta, length);
	let top = state.top;
	if (cursor < top) {
		top = cursor;
	} else if (viewport > 0 && cursor >= top + viewport) {
		top = cursor - viewport + 1;
	}
	if (top < 0) top = 0;
	const maxTop = Math.max(0, length - viewport);
	if (top > maxTop) top = maxTop;
	return { ...state, cursor, top };
}

/** Jump to the first / last row, fixing scroll for a `viewport`-row window. */
export function jumpTo(
	state: ListState,
	where: "top" | "bottom",
	length: number,
	viewport: number,
): ListState {
	const target = where === "top" ? 0 : length - 1;
	return moveCursor(
		{ ...state, cursor: target === 0 ? 0 : 0, top: 0 },
		target,
		length,
		viewport,
	);
}

/**
 * Compute a two-pane LIST | DETAIL split. `listRatio` is the list pane's share
 * of `totalWidth` (0..1). Returns integer column widths summing to totalWidth.
 */
export function splitListDetail(
	totalWidth: number,
	listRatio = 0.4,
): { listWidth: number; detailWidth: number } {
	const safe = Math.max(0, totalWidth);
	const listWidth = Math.max(0, Math.min(safe, Math.round(safe * listRatio)));
	return { listWidth, detailWidth: safe - listWidth };
}

/**
 * The slice of rows currently visible given `state.top` and `viewport`. Returns
 * indices [top, top+viewport) clamped to length.
 */
export function visibleRange(
	state: ListState,
	length: number,
	viewport: number,
): { start: number; end: number } {
	const start = clampCursor(state.top, length);
	const end = Math.min(length, start + Math.max(0, viewport));
	return { start, end };
}
