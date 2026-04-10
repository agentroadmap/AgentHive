/**
 * Autonomous transition worker for the pipeline queue.
 *
 * Listens for Postgres NOTIFY events and falls back to polling so queued
 * transitions are still processed if notifications are missed.
 */

import { basename } from "node:path";
import { getPool, query } from "../../infra/postgres/pool.ts";
import {
	type SpawnRequest,
	type SpawnResult,
	spawnAgent,
} from "../orchestration/agent-spawner.ts";

const MATURITY_CHANGED_CHANNEL = "proposal_maturity_changed";
const TRANSITION_QUEUED_CHANNEL = "transition_queued";
const GATE_READY_CHANNEL = "proposal_gate_ready";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;
const WORKTREE_PREFIXES = ["claude", "gemini", "copilot", "openclaw"] as const;

type TransitionQueueId = number | string;
type JsonRecord = Record<string, unknown>;
type Logger = Pick<Console, "log" | "warn" | "error">;

export interface NotificationMessage {
	channel: string;
	payload?: string;
}

type NotificationHandler = (message: NotificationMessage) => void;
type ListenerErrorHandler = (error: Error) => void;

export interface ListenerClient {
	query(text: string, params?: unknown[]): Promise<unknown>;
	on(event: "notification", handler: NotificationHandler): unknown;
	on(event: "error", handler: ListenerErrorHandler): unknown;
	removeListener(event: "notification", handler: NotificationHandler): unknown;
	removeListener(event: "error", handler: ListenerErrorHandler): unknown;
	release?(): void;
}

interface TransitionQueueRow {
	id: TransitionQueueId;
	proposal_id: number | string;
	from_stage: string;
	to_stage: string;
	triggered_by: string;
	attempt_count: number;
	max_attempts: number;
	metadata: JsonRecord | null;
}

export interface PipelineCronDeps {
	queryFn?: typeof query;
	connectListener?: () => Promise<ListenerClient>;
	spawnAgentFn?: typeof spawnAgent;
	logger?: Logger;
	defaultWorktree?: string;
	pollIntervalMs?: number;
	batchSize?: number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): JsonRecord | null {
	if (isRecord(value)) {
		return value;
	}

	if (typeof value === "string" && value.trim().length > 0) {
		try {
			const parsed = JSON.parse(value);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	return null;
}

function readString(
	source: JsonRecord | null,
	...keys: string[]
): string | null {
	if (!source) return null;

	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	return null;
}

function readNumber(
	source: JsonRecord | null,
	...keys: string[]
): number | null {
	if (!source) return null;

	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}

	return null;
}

function looksLikeWorktreeName(
	value: string | null | undefined,
): value is string {
	if (!value) return false;
	return WORKTREE_PREFIXES.some(
		(prefix) => value.startsWith(`${prefix}-`) || value === prefix,
	);
}

function coerceProposalId(value: number | string): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(parsed)) {
		throw new Error(`Invalid transition_queue.proposal_id value: ${value}`);
	}
	return parsed;
}

function buildFailureMessage(result: SpawnResult): string {
	const parts: string[] = [];

	if (result.exitCode !== null) {
		parts.push(`spawnAgent exited with code ${result.exitCode}`);
	} else {
		parts.push("spawnAgent exited without a process exit code");
	}

	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();

	if (stderr.length > 0) {
		parts.push(stderr.slice(0, 1000));
	} else if (stdout.length > 0) {
		parts.push(stdout.slice(0, 1000));
	}

	return parts.join("\n");
}

function buildDefaultTask(transition: TransitionQueueRow): string {
	const lines = [
		"Process the queued AgentHive proposal transition below.",
		"",
		`Transition queue row: ${transition.id}`,
		`Proposal ID: ${transition.proposal_id}`,
		`From stage: ${transition.from_stage}`,
		`To stage: ${transition.to_stage}`,
		`Triggered by: ${transition.triggered_by}`,
	];

	if (transition.metadata && Object.keys(transition.metadata).length > 0) {
		lines.push(
			"",
			"Queue metadata:",
			JSON.stringify(transition.metadata, null, 2),
		);
	}

	lines.push(
		"",
		"Read the current proposal state from the roadmap schema, perform the work required for this transition, and persist any resulting updates through the normal application paths.",
	);

	return lines.join("\n");
}

export class PipelineCron {
	private readonly queryFn: typeof query;
	private readonly connectListener: () => Promise<ListenerClient>;
	private readonly spawnAgentFn: typeof spawnAgent;
	private readonly logger: Logger;
	private readonly defaultWorktree: string;
	private readonly pollIntervalMs: number;
	private readonly batchSize: number;
	private readonly setIntervalFn: typeof setInterval;
	private readonly clearIntervalFn: typeof clearInterval;

	private listenerClient: ListenerClient | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private drainPromise: Promise<void> | null = null;
	private rerunRequested = false;
	private started = false;

	private readonly notificationHandler = (
		message: NotificationMessage,
	): void => {
		if (
			message.channel !== MATURITY_CHANGED_CHANNEL &&
			message.channel !== TRANSITION_QUEUED_CHANNEL &&
			message.channel !== GATE_READY_CHANNEL
		) {
			return;
		}

		this.logger.log(`[PipelineCron] Received NOTIFY on ${message.channel}`);
		void this.scheduleDrain(`notify:${message.channel}`);
	};

	private readonly listenerErrorHandler = (error: Error): void => {
		this.logger.error(`[PipelineCron] Listener error: ${error.message}`);
	};

	constructor(deps: PipelineCronDeps = {}) {
		this.queryFn = deps.queryFn ?? query;
		this.connectListener =
			deps.connectListener ?? (async () => getPool().connect());
		this.spawnAgentFn = deps.spawnAgentFn ?? spawnAgent;
		this.logger = deps.logger ?? console;
		this.defaultWorktree = deps.defaultWorktree ?? basename(process.cwd());
		this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
		this.setIntervalFn = deps.setIntervalFn ?? setInterval;
		this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
	}

	async run(): Promise<void> {
		if (this.started) {
			return;
		}

		this.started = true;
		await this.startListener();

		this.pollTimer = this.setIntervalFn(() => {
			void this.scheduleDrain("poll");
		}, this.pollIntervalMs);

		this.logger.log(
			`[PipelineCron] Listening on ${MATURITY_CHANGED_CHANNEL} and ${TRANSITION_QUEUED_CHANNEL}; polling every ${this.pollIntervalMs}ms`,
		);

		await this.scheduleDrain("startup");
	}

	async stop(): Promise<void> {
		this.started = false;

		if (this.pollTimer) {
			this.clearIntervalFn(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.listenerClient) {
			const listener = this.listenerClient;
			listener.removeListener("notification", this.notificationHandler);
			listener.removeListener("error", this.listenerErrorHandler);

			try {
				await listener.query(`UNLISTEN ${MATURITY_CHANGED_CHANNEL}`);
				await listener.query(`UNLISTEN ${TRANSITION_QUEUED_CHANNEL}`);
				await listener.query(`UNLISTEN ${GATE_READY_CHANNEL}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn(
					`[PipelineCron] Failed to unlisten cleanly: ${message}`,
				);
			}

			listener.release?.();
			this.listenerClient = null;
		}

		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		await (this.drainPromise ?? Promise.resolve());
	}

	private async startListener(): Promise<void> {
		const listener = await this.connectListener();
		this.listenerClient = listener;
		listener.on("notification", this.notificationHandler);
		listener.on("error", this.listenerErrorHandler);

		await listener.query(`LISTEN ${MATURITY_CHANGED_CHANNEL}`);
		await listener.query(`LISTEN ${TRANSITION_QUEUED_CHANNEL}`);
		await listener.query(`LISTEN ${GATE_READY_CHANNEL}`);
	}

	private async scheduleDrain(reason: string): Promise<void> {
		if (this.drainPromise) {
			this.rerunRequested = true;
			return this.drainPromise;
		}

		this.drainPromise = this.drainLoop(reason).finally(() => {
			this.drainPromise = null;
		});

		return this.drainPromise;
	}

	private async drainLoop(initialReason: string): Promise<void> {
		let reason = initialReason;

		while (true) {
			this.rerunRequested = false;
			await this.drainReadyTransitions(reason);

			if (!this.rerunRequested) {
				return;
			}

			reason = "coalesced";
		}
	}

	private async drainReadyTransitions(reason: string): Promise<void> {
		// Pull scan: enqueue any mature proposals not yet in transition_queue.
		// This is the fallback for push-missed events (crash, pre-migration backlog).
		try {
			await this.queryFn(
				`SELECT roadmap.fn_enqueue_mature_proposals()`,
				[],
			);
		} catch (err) {
			// fn_enqueue_mature_proposals may not exist in older deployments — non-fatal
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("does not exist")) {
				this.logger.warn(`[PipelineCron] fn_enqueue_mature_proposals: ${msg}`);
			}
		}

		while (true) {
			const transitions = await this.claimPendingTransitions();
			if (transitions.length === 0) {
				return;
			}

			this.logger.log(
				`[PipelineCron] Claimed ${transitions.length} transition(s) for ${reason}`,
			);

			for (const transition of transitions) {
				await this.processTransition(transition);
			}
		}
	}

	private async claimPendingTransitions(): Promise<TransitionQueueRow[]> {
		const { rows } = await this.queryFn<TransitionQueueRow>(
			`WITH next_transitions AS (
         SELECT tq.id
         FROM roadmap.transition_queue tq
         WHERE tq.status = 'pending'
           AND tq.process_after <= now()
         ORDER BY tq.process_after ASC, tq.id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE roadmap.transition_queue tq
       SET status = 'processing',
           processing_at = now(),
           attempt_count = tq.attempt_count + 1,
           last_error = NULL
       FROM next_transitions nt
       WHERE tq.id = nt.id
       RETURNING tq.id,
                 tq.proposal_id,
                 tq.from_stage,
                 tq.to_stage,
                 tq.triggered_by,
                 tq.attempt_count,
                 tq.max_attempts,
                 tq.metadata`,
			[this.batchSize],
		);

		return rows.map((row) => ({
			...row,
			metadata: normalizeMetadata(row.metadata),
		}));
	}

	private async processTransition(
		transition: TransitionQueueRow,
	): Promise<void> {
		try {
			const request = this.buildSpawnRequest(transition);
			const result = await this.spawnAgentFn(request);

			if (result.exitCode === 0) {
				await this.markTransitionDone(transition.id);
				this.logger.log(
					`[PipelineCron] Completed transition ${transition.id} for proposal ${transition.proposal_id}`,
				);
				return;
			}

			await this.handleTransitionFailure(
				transition,
				buildFailureMessage(result),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.handleTransitionFailure(transition, message);
		}
	}

	private buildSpawnRequest(transition: TransitionQueueRow): SpawnRequest {
		const metadata = transition.metadata;
		const spawnConfig = normalizeMetadata(metadata?.spawn);
		const worktree = this.resolveWorktree(transition, metadata, spawnConfig);
		const task = this.resolveTask(transition, metadata, spawnConfig);
		const model =
			readString(spawnConfig, "model") ?? readString(metadata, "model");
		const timeoutMs =
			readNumber(spawnConfig, "timeoutMs", "timeout_ms") ??
			readNumber(metadata, "timeoutMs", "timeout_ms");

		return {
			worktree,
			task,
			proposalId: coerceProposalId(transition.proposal_id),
			stage: transition.to_stage,
			model: model ?? undefined,
			timeoutMs: timeoutMs ?? undefined,
		};
	}

	private resolveWorktree(
		transition: TransitionQueueRow,
		metadata: JsonRecord | null,
		spawnConfig: JsonRecord | null,
	): string {
		const worktree =
			readString(spawnConfig, "worktree") ??
			readString(metadata, "worktree") ??
			(looksLikeWorktreeName(transition.triggered_by)
				? transition.triggered_by
				: null) ??
			this.defaultWorktree;

		if (!looksLikeWorktreeName(worktree)) {
			throw new Error(
				`No valid worktree available for transition ${transition.id}`,
			);
		}

		return worktree;
	}

	private resolveTask(
		transition: TransitionQueueRow,
		metadata: JsonRecord | null,
		spawnConfig: JsonRecord | null,
	): string {
		return (
			readString(spawnConfig, "task", "prompt") ??
			readString(metadata, "task", "prompt") ??
			buildDefaultTask(transition)
		);
	}

	private async markTransitionDone(id: TransitionQueueId): Promise<void> {
		await this.queryFn(
			`UPDATE roadmap.transition_queue
       SET status = 'done',
           completed_at = now(),
           last_error = NULL
       WHERE id = $1`,
			[id],
		);
	}

	private async handleTransitionFailure(
		transition: TransitionQueueRow,
		errorMessage: string,
	): Promise<void> {
		const exhausted = transition.attempt_count >= transition.max_attempts;

		if (exhausted) {
			await this.queryFn(
				`UPDATE roadmap.transition_queue
         SET status = 'failed',
             completed_at = now(),
             last_error = $2
         WHERE id = $1`,
				[transition.id, errorMessage],
			);

			this.logger.error(
				`[PipelineCron] Transition ${transition.id} failed permanently: ${errorMessage}`,
			);
			return;
		}

		await this.queryFn(
			`UPDATE roadmap.transition_queue
       SET status = 'pending',
           process_after = now() + ($2 * interval '2 minutes'),
           processing_at = NULL,
           completed_at = NULL,
           last_error = $3
       WHERE id = $1`,
			[transition.id, Math.max(transition.attempt_count, 1), errorMessage],
		);

		this.logger.warn(
			`[PipelineCron] Transition ${transition.id} requeued after failure: ${errorMessage}`,
		);
	}
}
