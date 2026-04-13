import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type ListenerClient,
	type NotificationMessage,
	PipelineCron,
	type PipelineCronDeps,
} from "../../src/core/pipeline/pipeline-cron.ts";

type QueryFn = NonNullable<PipelineCronDeps["queryFn"]>;
type QueryResultLike = Awaited<ReturnType<QueryFn>>;
type ConnectListener = NonNullable<PipelineCronDeps["connectListener"]>;
type SetIntervalFn = NonNullable<PipelineCronDeps["setIntervalFn"]>;
type ClearIntervalFn = NonNullable<PipelineCronDeps["clearIntervalFn"]>;

type SqlCall = {
	text: string;
	params?: unknown[];
};

type TransitionRow = {
	id: number | string;
	proposal_id: number | string;
	from_stage: string;
	to_stage: string;
	triggered_by: string;
	attempt_count: number;
	max_attempts: number;
	metadata: Record<string, unknown> | null;
};

type ListenerHarness = {
	client: ListenerClient;
	queries: string[];
	emit: (channel: string, payload?: string) => void;
	releaseCalled: () => boolean;
};

function createTransition(
	overrides: Partial<TransitionRow> = {},
): TransitionRow {
	return {
		id: "1",
		proposal_id: "42",
		from_stage: "Draft",
		to_stage: "Review",
		triggered_by: "builder",
		attempt_count: 1,
		max_attempts: 3,
		metadata: null,
		...overrides,
	};
}

function createListener(): ListenerHarness {
	const queries: string[] = [];
	let notificationHandler: ((message: NotificationMessage) => void) | undefined;
	let errorHandler: ((error: Error) => void) | undefined;
	let released = false;

	const client: ListenerClient = {
		async query(text: string): Promise<void> {
			queries.push(text);
		},
		on(
			event: "notification" | "error",
			handler:
				| ((message: NotificationMessage) => void)
				| ((error: Error) => void),
		) {
			if (event === "notification") {
				notificationHandler = handler as (message: NotificationMessage) => void;
				return;
			}
			errorHandler = handler as (error: Error) => void;
		},
		removeListener(
			event: "notification" | "error",
			handler:
				| ((message: NotificationMessage) => void)
				| ((error: Error) => void),
		) {
			if (event === "notification" && notificationHandler === handler) {
				notificationHandler = undefined;
			}
			if (event === "error" && errorHandler === handler) {
				errorHandler = undefined;
			}
		},
		release() {
			released = true;
		},
	};

	return {
		client,
		queries,
		emit(channel: string, payload?: string) {
			notificationHandler?.({ channel, payload });
		},
		releaseCalled(): boolean {
			return released;
		},
	};
}

function createLogger(): NonNullable<PipelineCronDeps["logger"]> {
	return {
		log: () => {},
		warn: () => {},
		error: () => {},
	};
}

function createQueryFn(
	claimResponses: TransitionRow[][],
	sqlCalls: SqlCall[] = [],
): QueryFn {
	return (async (text: string, params?: unknown[]) => {
		sqlCalls.push({ text, params });
		if (text.includes("FROM roadmap.transition_queue tq")) {
			return {
				rows: claimResponses.shift() ?? [],
			} as unknown as QueryResultLike;
		}
		return { rows: [], rowCount: 1 } as unknown as QueryResultLike;
	}) as QueryFn;
}

function createIntervalFns(
	onSchedule?: (callback: () => void, delay: number) => void,
) {
	const timers: ReturnType<typeof setInterval>[] = [];

	const setIntervalFn = ((callback: () => void, delay = 0) => {
		onSchedule?.(callback, delay);
		const timer = setInterval(() => {}, 60_000);
		timers.push(timer);
		return timer;
	}) as unknown as SetIntervalFn;

	const clearIntervalFn: ClearIntervalFn = (timer) => {
		clearInterval(timer);
	};

	return {
		setIntervalFn,
		clearIntervalFn,
		dispose() {
			for (const timer of timers) {
				clearInterval(timer);
			}
		},
	};
}

describe("PipelineCron", () => {
	it("listens on the pipeline channels, schedules the 30s poll, and drains ready transitions", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [[createTransition()], []];
		const spawnCalls: Array<Record<string, unknown>> = [];
		let pollDelay = 0;

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns((_, delay) => {
			pollDelay = delay;
		});

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => {
				spawnCalls.push(request as unknown as Record<string, unknown>);
				return {
					agentRunId: "run-1",
					worktree: request.worktree,
					exitCode: 0,
					stdout: "ok",
					stderr: "",
					durationMs: 12,
				};
			},
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		assert.deepEqual(listener.queries.slice(0, 2), [
			"LISTEN proposal_maturity_changed",
			"LISTEN transition_queued",
		]);
		assert.equal(pollDelay, 30_000);
		assert.equal(spawnCalls.length, 1);
		assert.equal(spawnCalls[0].worktree, "copilot-one");
		assert.equal(spawnCalls[0].proposalId, 42);
		assert.equal(spawnCalls[0].stage, "Review");
		assert.match(String(spawnCalls[0].task), /Transition queue row: 1/);
		assert.ok(
			sqlCalls.some((call) => call.text.includes("SET status = 'done'")),
		);

		await cron.stop();
		intervals.dispose();
		assert.equal(listener.releaseCalled(), true);
	});

	it("prefers explicit spawn metadata when building spawnAgent requests", async () => {
		const listener = createListener();
		const claimResponses = [
			[
				createTransition({
					metadata: {
						spawn: {
							worktree: "claude-andy",
							task: "Review this transition with the architect worktree.",
							model: "claude-sonnet-4-6",
							timeoutMs: 45_000,
						},
					},
				}),
			],
			[],
		];
		const spawnCalls: Array<Record<string, unknown>> = [];

		const queryFn = createQueryFn(claimResponses);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => {
				spawnCalls.push(request as unknown as Record<string, unknown>);
				return {
					agentRunId: "run-2",
					worktree: request.worktree,
					exitCode: 0,
					stdout: "ok",
					stderr: "",
					durationMs: 10,
				};
			},
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		assert.deepEqual(spawnCalls[0], {
			worktree: "claude-andy",
			task: "Review this transition with the architect worktree.",
			proposalId: 42,
			stage: "Review",
			model: "claude-sonnet-4-6",
			timeoutMs: 45_000,
		});

		await cron.stop();
		intervals.dispose();
	});

	it("requeues failed transitions when attempts remain", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [
			[createTransition({ id: 7, attempt_count: 1, max_attempts: 3 })],
			[],
		];

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => ({
				agentRunId: "run-3",
				worktree: request.worktree,
				exitCode: 1,
				stdout: "",
				stderr: "boom",
				durationMs: 11,
			}),
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		const retryUpdate = sqlCalls.find((call) =>
			call.text.includes("SET status = 'pending'"),
		);
		assert.ok(retryUpdate);
	assert.deepEqual(retryUpdate.params, [
		7,
		1,
		"Agent exit code 1: boom",
	]);

		await cron.stop();
		intervals.dispose();
	});

	it("marks transitions failed when the final attempt fails", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [
			[createTransition({ id: 9, attempt_count: 3, max_attempts: 3 })],
			[],
		];

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => ({
				agentRunId: "run-4",
				worktree: request.worktree,
				exitCode: 2,
				stdout: "",
				stderr: "still failing",
				durationMs: 11,
			}),
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		const failedUpdate = sqlCalls.find((call) =>
			call.text.includes("SET status = 'failed'"),
		);
		assert.ok(failedUpdate);
	assert.deepEqual(failedUpdate.params, [
		9,
		"Agent exit code 2: still failing",
	]);

		await cron.stop();
		intervals.dispose();
	});

	it("drains pending transitions again when a notification arrives", async () => {
		const listener = createListener();
		const claimResponses = [
			[],
			[createTransition({ id: "11", proposal_id: "77", to_stage: "Build" })],
			[],
		];
		const spawnCalls: Array<Record<string, unknown>> = [];

		const queryFn = createQueryFn(claimResponses);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => {
				spawnCalls.push(request as unknown as Record<string, unknown>);
				return {
					agentRunId: "run-5",
					worktree: request.worktree,
					exitCode: 0,
					stdout: "ok",
					stderr: "",
					durationMs: 8,
				};
			},
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();
		assert.equal(spawnCalls.length, 0);

		listener.emit("transition_queued", JSON.stringify({ proposal_id: 77 }));
		await cron.waitForIdle();

		assert.equal(spawnCalls.length, 1);
		assert.equal(spawnCalls[0].proposalId, 77);
		assert.equal(spawnCalls[0].stage, "Build");

		await cron.stop();
		intervals.dispose();
	});
});
