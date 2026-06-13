import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import { WebSocketServer } from "ws";
import {
	type AdapterRunResult,
	type OpenClawSessionOpts,
	runOpenClawSession,
	SubprocessAdapter,
	selectAdapter,
	WebSocketAdapter,
} from "./agent-adapter.ts";

/**
 * P1029 adapter tests. The WS paths run against a REAL `ws` server bound to an
 * ephemeral port; the adapter connects with Node's global WebSocket. Each test
 * closes its server in afterEach so no port leaks.
 */

let servers: WebSocketServer[] = [];
afterEach(async () => {
	await Promise.all(
		servers.map((s) => new Promise<void>((res) => s.close(() => res()))),
	);
	servers = [];
});

/**
 * Start a mock OpenClaw gateway. `handler` receives the parsed session_start
 * frame and a `send(frame)` to push server→client frames. Returns ws:// URL.
 */
function startGateway(
	handler: (
		start: { task: string; sessionId: string; model?: string },
		send: (frame: unknown) => void,
		raw: import("ws").WebSocket,
	) => void,
): Promise<string> {
	const wss = new WebSocketServer({ port: 0 });
	servers.push(wss);
	wss.on("connection", (socket) => {
		socket.on("message", (buf) => {
			const msg = JSON.parse(buf.toString());
			if (msg.type === "session_start") {
				handler(msg, (frame) => socket.send(JSON.stringify(frame)), socket);
			}
		});
	});
	return new Promise((resolve) => {
		wss.on("listening", () => {
			const addr = wss.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve(`ws://127.0.0.1:${port}`);
		});
	});
}

function baseOpts(
	gatewayUrl: string,
	over: Partial<OpenClawSessionOpts> = {},
): OpenClawSessionOpts {
	return {
		gatewayUrl,
		sessionId: "s1",
		task: "do the thing",
		timeoutMs: 2000,
		...over,
	};
}

describe("runOpenClawSession (P1029 AC-3/AC-11/AC-14/AC-16)", () => {
	test("happy path: stdout frames accumulate, session_end carries exitCode 0", async () => {
		const url = await startGateway((start, send) => {
			assert.equal(start.task, "do the thing");
			send({ type: "stdout", sessionId: start.sessionId, data: "hello " });
			send({ type: "stdout", sessionId: start.sessionId, data: "world" });
			send({
				type: "session_end",
				sessionId: start.sessionId,
				exitCode: 0,
				status: "success",
			});
		});
		const r = await runOpenClawSession(baseOpts(url));
		assert.equal(r.stdout, "hello world");
		assert.equal(r.exitCode, 0);
	});

	test("non-zero session_end maps to failed exitCode + stderr preserved", async () => {
		const url = await startGateway((start, send) => {
			send({ type: "stderr", sessionId: start.sessionId, data: "boom" });
			send({
				type: "session_end",
				sessionId: start.sessionId,
				exitCode: 7,
				status: "error",
			});
		});
		const r = await runOpenClawSession(baseOpts(url));
		assert.equal(r.exitCode, 7);
		assert.equal(r.stderr, "boom");
	});

	test("error frame → exitCode 1 with message on stderr", async () => {
		const url = await startGateway((start, send) => {
			send({
				type: "error",
				sessionId: start.sessionId,
				message: "model unavailable",
			});
		});
		const r = await runOpenClawSession(baseOpts(url));
		assert.equal(r.exitCode, 1);
		assert.match(r.stderr, /\[openclaw\] model unavailable/);
	});

	test("timeout → session_cancel sent, exitCode null", async () => {
		let cancelled = false;
		const url = await startGateway((_start, _send, socket) => {
			// Never send session_end; capture the cancel.
			socket.on("message", (buf) => {
				const m = JSON.parse(buf.toString());
				if (m.type === "session_cancel") cancelled = true;
			});
		});
		const r = await runOpenClawSession(baseOpts(url, { timeoutMs: 150 }));
		assert.equal(r.exitCode, null);
		assert.match(r.stderr, /timed out/);
		// give the cancel frame a tick to arrive
		await new Promise((res) => setTimeout(res, 50));
		assert.equal(cancelled, true, "session_cancel must be sent on timeout");
	});

	test("AC-16: output over the limit → session_cancel + exitCode 1 + marker", async () => {
		const url = await startGateway((start, send) => {
			// 3 chunks of 5 bytes; limit 10 → exceeded on the 3rd.
			send({ type: "stdout", sessionId: start.sessionId, data: "aaaaa" });
			send({ type: "stdout", sessionId: start.sessionId, data: "bbbbb" });
			send({ type: "stdout", sessionId: start.sessionId, data: "ccccc" });
			send({
				type: "session_end",
				sessionId: start.sessionId,
				exitCode: 0,
				status: "success",
			});
		});
		const r = await runOpenClawSession(baseOpts(url, { maxOutputBytes: 10 }));
		assert.equal(r.exitCode, 1);
		assert.match(r.stderr, /output-size-limit-exceeded/);
	});

	test("connect failure to a dead port → exitCode null, never throws", async () => {
		// Port 1 is privileged/closed; connection fails fast.
		const r = await runOpenClawSession(
			baseOpts("ws://127.0.0.1:1", { timeoutMs: 1000 }),
		);
		assert.equal(r.exitCode, null);
		assert.ok(r.stderr.length > 0);
	});
});

describe("adapter selection (P1029 AC-1/AC-2/AC-4/AC-12)", () => {
	test("selectAdapter routes openclaw → WebSocketAdapter, others → SubprocessAdapter", () => {
		const runner = async (): Promise<AdapterRunResult> => ({
			stdout: "sub",
			stderr: "",
			exitCode: 0,
		});
		const opts = baseOpts("ws://127.0.0.1:0");
		assert.ok(
			selectAdapter("openclaw", runner, opts) instanceof WebSocketAdapter,
		);
		assert.ok(
			selectAdapter("claude", runner, opts) instanceof SubprocessAdapter,
		);
		assert.ok(selectAdapter("codex", runner) instanceof SubprocessAdapter);
	});

	test("SubprocessAdapter is a transparent wrapper of its runner (AC-10)", async () => {
		const expected: AdapterRunResult = {
			stdout: "out",
			stderr: "err",
			exitCode: 0,
		};
		const adapter = new SubprocessAdapter(async () => expected);
		assert.deepEqual(await adapter.run(), expected);
		await adapter.dispose(); // no throw
	});

	test("selectAdapter throws if openclaw chosen without session opts", () => {
		const runner = async (): Promise<AdapterRunResult> => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		});
		assert.throws(
			() => selectAdapter("openclaw", runner),
			/no OpenClawSessionOpts/,
		);
	});
});
