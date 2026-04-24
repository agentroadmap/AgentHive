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
type McpClientFactory = NonNullable<PipelineCronDeps["mcpClientFactory"]>;

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

/** Create a mock MCP client factory that records tool calls and returns configurable responses. */
function createMcpClientFactory(
	toolResponses: Record<string, unknown> = {},
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [],
): McpClientFactory {
	return (_url: string) => ({
		async callTool(args: { name: string; arguments: Record<string, unknown> }) {
			toolCalls.push(args);
			const response = toolResponses[args.name] ?? {
				success: true,
				cubic: { id: "cubic-test-1" },
			};
			return { content: [{ type: "text", text: JSON.stringify(response) }] };
		},
		async close() {},
	});
}

describe("PipelineCron", () => {
	it("listens on the pipeline channels, schedules the 30s poll, and dispatches via cubic", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [[createTransition()], []];
		const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const scheduledDelays: number[] = [];

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns((_, delay) => {
			scheduledDelays.push(delay);
		});

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: createMcpClientFactory({}, toolCalls),
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		assert.deepEqual(listener.queries.slice(0, 2), [
			"LISTEN proposal_maturity_changed",
			"LISTEN transition_queued",
		]);
		assert.deepEqual(scheduledDelays, [30_000, 60_000]);

		// Dispatched via cubic_create + cubic_focus — NOT spawnAgent
		assert.ok(toolCalls.some((c) => c.name === "cubic_create"), "cubic_create should be called");
		assert.ok(toolCalls.some((c) => c.name === "cubic_focus"), "cubic_focus should be called");

		// Task content should include transition context
		const focusCall = toolCalls.find((c) => c.name === "cubic_focus")!;
		assert.match(String(focusCall.arguments.task), /Transition queue row: 1/);

		// Cubic dispatch is not a completed state transition. The queue stays
		// processing until the proposal status itself reaches the target stage.
		assert.ok(
			sqlCalls.some((call) => call.text.includes("SET status = 'processing'")),
			"transition should stay processing after cubic dispatch",
		);
		assert.equal(
			sqlCalls.some((call) => call.text.includes("SET status = 'done'")),
			false,
			"transition should not be marked done after dispatch alone",
		);
		assert.equal(
			sqlCalls.some((call) => call.text.includes("fn_enqueue_mature_proposals")),
			false,
			"legacy cron must not create transition_queue rows from mature proposals",
		);

		await cron.stop();
		intervals.dispose();
		assert.equal(listener.releaseCalled(), true);
	});

	it("uses gate task from spawn metadata when provided", async () => {
		const listener = createListener();
		const claimResponses = [
			[
				createTransition({
					metadata: {
						gate: "D3",
						task: "You are an AgentHive gate reviewer (D3: Code Review Gate).",
						spawn: {
							worktree: "claude-andy",
							task: "Explicit task from spawn metadata.",
							timeoutMs: 45_000,
						},
					},
				}),
			],
			[],
		];
		const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

		const queryFn = createQueryFn(claimResponses);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: createMcpClientFactory({}, toolCalls),
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		const focusCall = toolCalls.find((c) => c.name === "cubic_focus")!;
		assert.ok(focusCall, "cubic_focus should be called");
		// Spawn metadata task takes precedence
		assert.equal(focusCall.arguments.task, "Explicit task from spawn metadata.");

		await cron.stop();
		intervals.dispose();
	});

	it("uses gate task metadata when dispatching through spawn executor", async () => {
		const listener = createListener();
		const claimResponses = [
			[
				createTransition({
					metadata: {
						task: "D1 gate task from queue metadata.",
						spawn: {
							worktree: "claude-andy",
							timeoutMs: 45_000,
						},
					},
				}),
			],
			[],
		];
		const spawnRequests: unknown[] = [];

		const queryFn = createQueryFn(claimResponses);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => {
				spawnRequests.push(request);
				return {
					agentRunId: "run-1",
					worktree: String(request.worktree),
					exitCode: 0,
					stdout: "",
					stderr: "",
					durationMs: 1,
				};
			},
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		assert.equal(spawnRequests.length, 1);
		assert.deepEqual(spawnRequests[0], {
			worktree: "claude-andy",
			task: "D1 gate task from queue metadata.",
			proposalId: 42,
			stage: "Review",
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

		// MCP client that always throws (simulates cubic dispatch failure)
		const failingFactory: McpClientFactory = (_url) => ({
			async callTool() { throw new Error("cubic_create failed: MCP error"); },
			async close() {},
		});

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: failingFactory,
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		const retryUpdate = sqlCalls.find((call) =>
			call.text.includes("SET status = 'pending'"),
		);
		assert.ok(retryUpdate, "should requeue on failure when attempts remain");
		assert.equal(retryUpdate.params?.[0], 7);
		assert.match(String(retryUpdate.params?.[2]), /cubic_create failed/);

		await cron.stop();
		intervals.dispose();
	});

	it("marks transitions failed and inserts notification_queue when the final attempt fails (AC-3)", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [
			[createTransition({ id: 9, proposal_id: "42", from_stage: "DEVELOP", to_stage: "MERGE", attempt_count: 3, max_attempts: 3 })],
			[],
		];

		const queryFn = createQueryFn(claimResponses, sqlCalls);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const failingFactory: McpClientFactory = (_url) => ({
			async callTool() { throw new Error("still failing: auth error"); },
			async close() {},
		});

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: failingFactory,
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		// Transition should be marked failed
		const failedUpdate = sqlCalls.find((call) =>
			call.text.includes("SET status = 'failed'"),
		);
		assert.ok(failedUpdate, "transition should be marked failed on final attempt");
		assert.equal(failedUpdate.params?.[0], 9);
		assert.match(String(failedUpdate.params?.[1]), /still failing/);

		// AC-3: notification_queue INSERT should be present (escalation)
		const notificationInsert = sqlCalls.find((call) =>
			call.text.includes("notification_queue") && call.text.includes("'CRITICAL'"),
		);
		assert.ok(notificationInsert, "AC-3: notification_queue should be inserted on exhausted failure");
		assert.equal(notificationInsert.params?.[0], 42); // proposal_id
		assert.match(String(notificationInsert.params?.[1]), /failed permanently/);
		assert.match(String(notificationInsert.params?.[5]), /still failing/);

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
		const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

		const queryFn = createQueryFn(claimResponses);
		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: createMcpClientFactory({}, toolCalls),
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();
		assert.equal(toolCalls.length, 0, "no cubic calls before notification");

		listener.emit("transition_queued", JSON.stringify({ proposal_id: 77 }));
		await cron.waitForIdle();

		const createCalls = toolCalls.filter((c) => c.name === "cubic_create");
		assert.equal(createCalls.length, 1, "one cubic_create after notification");
		assert.match(String(createCalls[0].arguments.name), /77/);

		const focusCalls = toolCalls.filter((c) => c.name === "cubic_focus");
		assert.equal(focusCalls.length, 1, "one cubic_focus after notification");
		assert.match(String(focusCalls[0].arguments.phase), /build/);

		await cron.stop();
		intervals.dispose();
	});

	it("dispatches prep work when a proposal is not ready for the next state", async () => {
		const listener = createListener();
		const spawnRequests: Array<Record<string, unknown>> = [];
		const claimResponses = [
			[
				createTransition({
					id: 21,
					proposal_id: "99",
					from_stage: "DRAFT",
					to_stage: "REVIEW",
				}),
			],
			[],
		];

		const queryFn = (async (text: string) => {
			if (text.includes("FROM roadmap.transition_queue tq")) {
				const rows = claimResponses.shift() ?? [];
				return {
					rows,
				} as unknown as QueryResultLike;
			}

			if (text.includes("FROM roadmap_proposal.proposal p")) {
				return {
					rows: [
						{
							id: 99,
							display_id: "P099",
							status: "DRAFT",
							maturity: "mature",
							title: "Needs more research",
							priority: "high",
							summary: null,
							design: null,
							alternatives: null,
							drawbacks: null,
							dependency: null,
							unresolved_dependencies: 2,
							total_acceptance_criteria: 0,
							blocking_acceptance_criteria: 0,
							passed_acceptance_criteria: 0,
							latest_decision: null,
						},
					],
				} as unknown as QueryResultLike;
			}

			if (text.includes("FROM roadmap.v_capable_agents")) {
				return {
					rows: [
						{
							agent_identity: "architect-alpha",
							agent_type: "llm",
							role: "architect",
							preferred_model: "claude-sonnet-4-6",
							active_model: "claude-sonnet-4-6",
							status: "healthy",
							active_leases: 0,
							context_load: 0,
							cpu_percent: 15,
							memory_mb: 2048,
							daily_limit_usd: 100,
							daily_spend_usd: 10,
							is_frozen: false,
							cost_per_1k_input: 0.012,
							capability: "architect",
						},
						{
							agent_identity: "reviewer-beta",
							agent_type: "llm",
							role: "reviewer",
							preferred_model: "gpt-4o",
							active_model: "gpt-4o",
							status: "healthy",
							active_leases: 2,
							context_load: 2,
							cpu_percent: 55,
							memory_mb: 4096,
							daily_limit_usd: 100,
							daily_spend_usd: 25,
							is_frozen: false,
							cost_per_1k_input: 0.018,
							capability: "reviewer",
						},
					],
				} as unknown as QueryResultLike;
			}

			return { rows: [], rowCount: 1 } as unknown as QueryResultLike;
		}) as QueryFn;

		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => {
				spawnRequests.push(request as Record<string, unknown>);
				return {
					agentRunId: "run-prep",
					worktree: String(request.worktree),
					exitCode: 0,
					stdout: "",
					stderr: "",
					durationMs: 1,
				};
			},
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		assert.equal(spawnRequests.length, 1);
		assert.match(
			String(spawnRequests[0].task),
			/preparation agent|enhance the proposal/i,
		);
		assert.equal(spawnRequests[0].worktree, "architect-alpha");
		assert.equal(spawnRequests[0].stage, "review");

		await cron.stop();
		intervals.dispose();
	});

	it("invokes fn_reap_expired_offers at startup and logs non-zero results", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const logs: string[] = [];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_reap_expired_offers")) {
				return {
					rows: [{ reissued_count: 2, expired_count: 1 }],
				} as unknown as QueryResultLike;
			}
			return { rows: [], rowCount: 0 } as unknown as QueryResultLike;
		}) as QueryFn;

		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: createMcpClientFactory(),
			logger: {
				log: (msg: string) => logs.push(msg),
				warn: () => {},
				error: () => {},
			},
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();
		// Allow the kickoff reaper microtask to settle.
		await new Promise((resolve) => setImmediate(resolve));

		const reapCall = sqlCalls.find((c) =>
			c.text.includes("fn_reap_expired_offers"),
		);
		assert.ok(reapCall, "fn_reap_expired_offers should be invoked at startup");
		assert.ok(
			logs.some((l) => l.includes("offer reaper") && l.includes("2 reissued")),
			"non-zero reap result should be logged",
		);

		await cron.stop();
		intervals.dispose();
	});

	it("dispatches gate review work when the proposal is ready for promotion", async () => {
		const listener = createListener();
		const spawnRequests: Array<Record<string, unknown>> = [];
		const claimResponses = [
			[
				createTransition({
					id: 22,
					proposal_id: "100",
					from_stage: "REVIEW",
					to_stage: "DEVELOP",
				}),
			],
			[],
		];

		const queryFn = (async (text: string) => {
			if (text.includes("FROM roadmap.transition_queue tq")) {
				const rows = claimResponses.shift() ?? [];
				return {
					rows,
				} as unknown as QueryResultLike;
			}

			if (text.includes("FROM roadmap_proposal.proposal p")) {
				return {
					rows: [
						{
							id: 100,
							display_id: "P100",
							status: "REVIEW",
							maturity: "mature",
							title: "Ready to develop",
							priority: "medium",
							summary: "Research completed.",
							design: "Design completed.",
							alternatives: null,
							drawbacks: null,
							dependency: null,
							unresolved_dependencies: 0,
							total_acceptance_criteria: 3,
							blocking_acceptance_criteria: 0,
							passed_acceptance_criteria: 3,
							latest_decision: "approved",
						},
					],
				} as unknown as QueryResultLike;
			}

			if (text.includes("FROM roadmap.v_capable_agents")) {
				return {
					rows: [
						{
							agent_identity: "reviewer-beta",
							agent_type: "llm",
							role: "reviewer",
							preferred_model: "gpt-4o",
							active_model: "gpt-4o",
							status: "healthy",
							active_leases: 0,
							context_load: 0,
							cpu_percent: 10,
							memory_mb: 2048,
							daily_limit_usd: 100,
							daily_spend_usd: 8,
							is_frozen: false,
							cost_per_1k_input: 0.018,
							capability: "reviewer",
						},
						{
							agent_identity: "architect-alpha",
							agent_type: "llm",
							role: "architect",
							preferred_model: "claude-sonnet-4-6",
							active_model: "claude-sonnet-4-6",
							status: "healthy",
							active_leases: 1,
							context_load: 1,
							cpu_percent: 35,
							memory_mb: 4096,
							daily_limit_usd: 100,
							daily_spend_usd: 20,
							is_frozen: false,
							cost_per_1k_input: 0.012,
							capability: "architect",
						},
					],
				} as unknown as QueryResultLike;
			}

			return { rows: [], rowCount: 1 } as unknown as QueryResultLike;
		}) as QueryFn;

		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			spawnAgentFn: async (request) => {
				spawnRequests.push(request as Record<string, unknown>);
				return {
					agentRunId: "run-gate",
					worktree: String(request.worktree),
					exitCode: 0,
					stdout: "",
					stderr: "",
					durationMs: 1,
				};
			},
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		});

		await cron.run();

		assert.equal(spawnRequests.length, 1);
		assert.match(
			String(spawnRequests[0].task),
			/gate agent|ready to gate|decide whether the proposal is ready/i,
		);
		assert.equal(spawnRequests[0].worktree, "reviewer-beta");
		assert.equal(spawnRequests[0].stage, "develop");

		await cron.stop();
		intervals.dispose();
	});

	it("emits an offer into squad_dispatch and notifies work_offers when useOfferDispatch is set", async () => {
		const listener = createListener();
		const sqlCalls: SqlCall[] = [];
		const claimResponses = [
			[createTransition({ id: 77, proposal_id: 42, to_stage: "Develop" })],
			[],
		];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("FROM roadmap.transition_queue tq")) {
				return {
					rows: claimResponses.shift() ?? [],
				} as unknown as QueryResultLike;
			}
			if (text.includes("INSERT INTO roadmap_workforce.squad_dispatch")) {
				return { rows: [{ id: 9001 }] } as unknown as QueryResultLike;
			}
			return { rows: [], rowCount: 1 } as unknown as QueryResultLike;
		}) as QueryFn;

		const connectListener: ConnectListener = async () => listener.client;
		const intervals = createIntervalFns();
		const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

		const cron = new PipelineCron({
			queryFn,
			connectListener,
			mcpClientFactory: createMcpClientFactory({}, toolCalls),
			logger: createLogger(),
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
			useOfferDispatch: true,
		});

		await cron.run();
		await new Promise((resolve) => setImmediate(resolve));

		const insertCall = sqlCalls.find((c) =>
			c.text.includes("INSERT INTO roadmap_workforce.squad_dispatch"),
		);
		assert.ok(insertCall, "expected an INSERT into squad_dispatch");
		assert.equal(insertCall!.params?.[0], 42, "proposal_id should be numeric 42");
		assert.match(
			String(insertCall!.params?.[1]),
			/^42-develop$/,
			"squad_name should be displayId-phase",
		);

		const requiredCapabilities = JSON.parse(String(insertCall!.params?.[3]));
		assert.deepEqual(requiredCapabilities, { all: ["developer"] });

		const offerMetadata = JSON.parse(String(insertCall!.params?.[4]));
		assert.equal(offerMetadata.transition_id, 77);
		assert.equal(offerMetadata.phase, "develop");
		assert.equal(offerMetadata.proposal_display_id, "42");
		assert.ok(typeof offerMetadata.task === "string" && offerMetadata.task.length > 0);

		const notifyCall = sqlCalls.find((c) =>
			c.text.includes("pg_notify('work_offers'"),
		);
		assert.ok(notifyCall, "expected pg_notify on work_offers");
		const notifyPayload = JSON.parse(String(notifyCall!.params?.[0]));
		assert.equal(notifyPayload.event, "emitted");
		assert.equal(notifyPayload.dispatch_id, 9001);

		assert.ok(
			sqlCalls.some((c) => c.text.includes("SET status = 'processing'")),
			"transition should be marked processing after offer emission",
		);
		assert.equal(
			toolCalls.length,
			0,
			"offer dispatch must not invoke MCP cubic tools",
		);

		await cron.stop();
		intervals.dispose();
	});
});
