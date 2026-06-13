/**
 * P1029: provider adapter layer for agent execution.
 *
 * Existing CLI providers (claude/codex/gemini/copilot/hermes/agy) are
 * short-lived subprocesses whose exit is the lifecycle signal. OpenClaw is a
 * persistent WebSocket daemon with per-session queues — it cannot be forked
 * per task. This module introduces a thin adapter seam so both shapes return
 * the SAME {stdout, stderr, exitCode} the spawner already post-processes
 * (token ledger, classifyExit, agent_runs, observability span).
 *
 * Design notes:
 * - `runOpenClawSession` is the self-contained WS session runner used by the
 *   spawner at the runProcess swap point. It depends on nothing in the spawner,
 *   so there is no import cycle.
 * - `AgentAdapter` / `SubprocessAdapter` / `WebSocketAdapter` give the uniform
 *   task-scoped abstraction the proposal specifies; `SubprocessAdapter` takes an
 *   injected runner so it stays dependency-free and a transparent wrapper.
 * - No proposal lifecycle, lease, or orchestrator changes. No per-agency systemd
 *   units (a long-running OpenClaw daemon, if any, is the a2a-host floor's job).
 */

/** Minimal exit shape shared by subprocess and WS execution. */
export interface AdapterRunResult {
	stdout: string;
	stderr: string;
	/** null = killed/timed-out (no clean exit code), matching runProcess. */
	exitCode: number | null;
}

// ── OpenClaw WS gateway protocol (canonical contract; daemon implements server) ──

/** Client → Server. */
export interface SessionStart {
	type: "session_start";
	sessionId: string;
	task: string;
	model?: string;
	env?: Record<string, string>;
}
export interface SessionCancel {
	type: "session_cancel";
	sessionId: string;
}

/** Server → Client. */
export interface StdoutFrame {
	type: "stdout";
	sessionId: string;
	data: string;
}
export interface StderrFrame {
	type: "stderr";
	sessionId: string;
	data: string;
}
export interface SessionEnd {
	type: "session_end";
	sessionId: string;
	exitCode: number;
	status: "success" | "error";
}
export interface ErrorFrame {
	type: "error";
	sessionId: string;
	message: string;
}

type ServerFrame = StdoutFrame | StderrFrame | SessionEnd | ErrorFrame;

/** Browser-style WebSocket surface (global WebSocket / ws both satisfy it). */
interface MinimalWebSocket {
	send(data: string): void;
	close(): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: unknown) => void) | null;
}
type WebSocketCtor = new (url: string) => MinimalWebSocket;

export interface OpenClawSessionOpts {
	gatewayUrl: string;
	sessionId: string;
	task: string;
	model?: string;
	env?: Record<string, string>;
	timeoutMs: number;
	/** Reject the session once stdout+stderr exceeds this (default 10MB). */
	maxOutputBytes?: number;
	/** Injectable for tests; defaults to the global WebSocket. */
	webSocketCtor?: WebSocketCtor;
}

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const OUTPUT_LIMIT_MARKER = "[agent-adapter] output-size-limit-exceeded";

/** Append a line to a buffer, inserting a newline only when non-empty. */
function appendLine(buf: string, line: string): string {
	return buf ? `${buf}\n${line}` : line;
}

/**
 * Run one OpenClaw task over the WS gateway and resolve with the collected
 * streams + exit code. Never rejects — failures map to a non-zero/null exitCode
 * with the reason on stderr, so the spawner's existing post-processing handles
 * them uniformly.
 *
 *   session_end           → exitCode from the frame
 *   error frame           → exitCode 1, message on stderr
 *   timeout               → session_cancel sent, exitCode null
 *   socket error / close-before-end → exitCode null, reason on stderr
 *   output-size exceeded  → session_cancel sent, exitCode 1, marker on stderr
 */
export function runOpenClawSession(
	opts: OpenClawSessionOpts,
): Promise<AdapterRunResult> {
	const Ctor: WebSocketCtor =
		opts.webSocketCtor ?? (globalThis.WebSocket as unknown as WebSocketCtor);
	const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

	return new Promise<AdapterRunResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let ws: MinimalWebSocket;

		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: AdapterRunResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try {
				ws.close();
			} catch {
				// already closing/closed
			}
			resolve(result);
		};

		const trySend = (frame: SessionStart | SessionCancel) => {
			try {
				ws.send(JSON.stringify(frame));
			} catch {
				// socket gone — handled by onerror/onclose
			}
		};

		const enforceLimit = (): boolean => {
			if (stdout.length + stderr.length > maxBytes) {
				trySend({ type: "session_cancel", sessionId: opts.sessionId });
				stderr = appendLine(stderr, OUTPUT_LIMIT_MARKER);
				finish({ stdout, stderr, exitCode: 1 });
				return true;
			}
			return false;
		};

		try {
			ws = new Ctor(opts.gatewayUrl);
		} catch (err) {
			resolve({
				stdout: "",
				stderr: `[agent-adapter] WS connect failed: ${err instanceof Error ? err.message : String(err)}`,
				exitCode: null,
			});
			return;
		}

		timer = setTimeout(() => {
			trySend({ type: "session_cancel", sessionId: opts.sessionId });
			finish({
				stdout,
				stderr: appendLine(
					stderr,
					`[agent-adapter] session timed out after ${opts.timeoutMs}ms`,
				),
				exitCode: null,
			});
		}, opts.timeoutMs);

		ws.onopen = () => {
			trySend({
				type: "session_start",
				sessionId: opts.sessionId,
				task: opts.task,
				...(opts.model ? { model: opts.model } : {}),
				...(opts.env ? { env: opts.env } : {}),
			});
		};

		ws.onmessage = (ev) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(String(ev.data)) as ServerFrame;
			} catch {
				return; // ignore unparseable frames
			}
			switch (frame.type) {
				case "stdout":
					stdout += frame.data;
					enforceLimit();
					break;
				case "stderr":
					stderr += frame.data;
					enforceLimit();
					break;
				case "session_end":
					finish({ stdout, stderr, exitCode: frame.exitCode });
					break;
				case "error":
					finish({
						stdout,
						stderr: appendLine(stderr, `[openclaw] ${frame.message}`),
						exitCode: 1,
					});
					break;
			}
		};

		ws.onerror = () => {
			finish({
				stdout,
				stderr: appendLine(stderr, "[agent-adapter] WS error"),
				exitCode: null,
			});
		};

		ws.onclose = () => {
			// Close before session_end is a failure (partial result, no clean code).
			finish({
				stdout,
				stderr: appendLine(
					stderr,
					"[agent-adapter] WS closed before session_end",
				),
				exitCode: null,
			});
		};
	});
}

// ── Task-scoped adapter abstraction (AC-1/2/9/10/11) ──

export interface AgentAdapter {
	/** Execute a task, returning the same exit shape the spawner post-processes. */
	run(): Promise<AdapterRunResult>;
	/** Release any held resources (sockets/sessions). */
	dispose(): Promise<void>;
}

/**
 * Transparent wrapper over the existing subprocess path. The runner closure
 * (buildArgsBySpec → runProcess) is injected so this module never imports the
 * spawner — zero behaviour change for CLI providers.
 */
export class SubprocessAdapter implements AgentAdapter {
	constructor(private runner: () => Promise<AdapterRunResult>) {}
	run(): Promise<AdapterRunResult> {
		return this.runner();
	}
	async dispose(): Promise<void> {}
}

/** WS-based adapter for OpenClaw (route.agentCli === 'openclaw'). */
export class WebSocketAdapter implements AgentAdapter {
	constructor(private opts: OpenClawSessionOpts) {}
	run(): Promise<AdapterRunResult> {
		return runOpenClawSession(this.opts);
	}
	async dispose(): Promise<void> {}
}

/**
 * Select the adapter for a route by agent_cli. `openclaw` → WebSocketAdapter;
 * everything else → SubprocessAdapter wrapping the injected subprocess runner.
 */
export function selectAdapter(
	agentCli: string,
	subprocessRunner: () => Promise<AdapterRunResult>,
	openclawOpts?: OpenClawSessionOpts,
): AgentAdapter {
	if (agentCli === "openclaw") {
		if (!openclawOpts) {
			throw new Error(
				"[agent-adapter] openclaw route selected but no OpenClawSessionOpts provided",
			);
		}
		return new WebSocketAdapter(openclawOpts);
	}
	return new SubprocessAdapter(subprocessRunner);
}
