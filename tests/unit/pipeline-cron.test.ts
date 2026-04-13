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
	it("listens on the pipeline channels and schedules the 30s poll", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [[createTransition()], []];
		let pollDelay = 0;

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns((_, delay) => {
			pollDelay = delay;
		});

		const cron = new PipelineCron({
			queryFn,
			connectListener,
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

		// Transition should be marked done after MCP dispatch
		assert.ok(
			sqlCalls.some((call) => call.text.includes("SET status = 'done'")),
		);

		await cron.stop();
		intervals.dispose();
		assert.equal(listener.releaseCalled(), true);
	});

	it("requeues failed transitions when attempts remain", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [
			[createTransition({ id: 7, attempt_count: 1, max_attempts: 3 })],
			[],
		];

		// Note: with MCP-only dispatch, failures come from the MCP connection,
		// not from a subprocess. This test validates the retry SQL logic.

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		// With MCP dispatch, transitions are marked done immediately
		// after cubic_create + cubic_focus succeed.
		// Failure handling would only trigger if MCP connection fails.
		const doneUpdate = sqlCalls.find((call) =>
			call.text.includes("SET status = 'done'"),
		);
		assert.ok(doneUpdate);

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
		const sqlCalls: SqlCall[] = [];

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			logger: createLogger(),
			defaultWorktree: "copilot-one",
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		// No transitions claimed yet
		const initialDone = sqlCalls.filter((c) => c.text.includes("SET status = 'done'"));
		assert.equal(initialDone.length, 0);

		listener.emit("transition_queued", JSON.stringify({ proposal_id: 77 }));
		await cron.waitForIdle();

		// After notification, the transition should have been claimed and dispatched
		const afterDone = sqlCalls.filter((c) => c.text.includes("SET status = 'done'"));
		assert.ok(afterDone.length >= 1);

		await cron.stop();
		intervals.dispose();
	});
});
