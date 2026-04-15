/**
 * Tool Agent Registry — zero-cost mechanical operator framework.
 *
 * Tool agents are deterministic, non-LLM operators that handle mechanical
 * tasks: state transitions, health checks, merges, tests, cleanup, budget
 * enforcement. They are registered in agent_registry with agent_type='tool'
 * and configured in tool_agent_config.
 *
 * The registry resolves handler classes, manages the event loop, and provides
 * direct invocation without subprocess spawn.
 */

import { query } from "../../infra/postgres/pool.ts";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ToolTask {
	type: string;
	proposalId?: number;
	payload: Record<string, unknown>;
}

export interface ToolResult {
	success: boolean;
	output: string;
	tokensUsed: 0; // always zero
	escalate?: boolean;
	escalationReason?: string;
}

export interface ToolAgent {
	identity: string;
	capabilities: string[];
	invoke(task: ToolTask): Promise<ToolResult>;
	healthCheck(): Promise<boolean>;
}

export interface ToolAgentConfigRow {
	id: number;
	agent_identity: string;
	agent_type: string;
	trigger_type: string;
	trigger_source: string | null;
	handler_class: string;
	is_active: boolean;
	config: Record<string, unknown>;
}

type ToolAgentConstructor = new (
	config: Record<string, unknown>,
) => ToolAgent;

// ─── Registry ─────────────────────────────────────────────────────────────────

export class ToolAgentRegistry {
	private readonly agents = new Map<string, ToolAgent>();
	private readonly constructors = new Map<string, ToolAgentConstructor>();
	private readonly logger: Pick<Console, "log" | "warn" | "error">;

	constructor(
		logger?: Pick<Console, "log" | "warn" | "error">,
	) {
		this.logger = logger ?? console;
	}

	/**
	 * Register a handler class constructor. Called at startup before load().
	 */
	registerHandler(
		className: string,
		constructor: ToolAgentConstructor,
	): void {
		this.constructors.set(className, constructor);
	}

	/**
	 * Load all active tool agent configs from Postgres and instantiate handlers.
	 */
	async load(): Promise<void> {
		const { rows } = await query<ToolAgentConfigRow>(
			`SELECT id, agent_identity, agent_type, trigger_type,
			        trigger_source, handler_class, is_active, config
			   FROM roadmap.tool_agent_config
			  WHERE is_active = true
			  ORDER BY id`,
		);

		for (const row of rows) {
			const Ctor = this.constructors.get(row.handler_class);
			if (!Ctor) {
				this.logger.warn(
					`[ToolAgentRegistry] No handler class for ${row.handler_class} (${row.agent_identity})`,
				);
				continue;
			}

			try {
				const agent = new Ctor(row.config ?? {});
				this.agents.set(row.agent_identity, agent);
				this.logger.log(
					`[ToolAgentRegistry] Loaded ${row.agent_identity} (${row.trigger_type})`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(
					`[ToolAgentRegistry] Failed to instantiate ${row.agent_identity}: ${msg}`,
				);
			}
		}

		this.logger.log(
			`[ToolAgentRegistry] Loaded ${this.agents.size} tool agent(s)`,
		);
	}

	/**
	 * Invoke a tool agent by identity.
	 */
	async invoke(identity: string, task: ToolTask): Promise<ToolResult> {
		const agent = this.agents.get(identity);
		if (!agent) {
			return {
				success: false,
				output: `Tool agent not found: ${identity}`,
				tokensUsed: 0,
			};
		}

		try {
			return await agent.invoke(task);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				output: `Tool agent error: ${msg}`,
				tokensUsed: 0,
				escalate: true,
				escalationReason: msg,
			};
		}
	}

	/**
	 * Health check all loaded tool agents.
	 */
	async healthCheckAll(): Promise<
		Record<string, { healthy: boolean; error?: string }>
	> {
		const results: Record<string, { healthy: boolean; error?: string }> = {};

		for (const [identity, agent] of this.agents) {
			try {
				const healthy = await agent.healthCheck();
				results[identity] = { healthy };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				results[identity] = { healthy: false, error: msg };
			}
		}

		return results;
	}

	/**
	 * List all loaded tool agent identities.
	 */
	list(): string[] {
		return [...this.agents.keys()];
	}

	/**
	 * Get a specific tool agent.
	 */
	get(identity: string): ToolAgent | undefined {
		return this.agents.get(identity);
	}

	/**
	 * Stop all tool agents that implement a stop() method.
	 */
	async stopAll(): Promise<void> {
		for (const [identity, agent] of this.agents) {
			if (
				"stop" in agent &&
				typeof (agent as { stop?: () => Promise<void> }).stop ===
					"function"
			) {
				try {
					await (agent as { stop: () => Promise<void> }).stop();
					this.logger.log(
						`[ToolAgentRegistry] Stopped ${identity}`,
					);
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : String(err);
					this.logger.warn(
						`[ToolAgentRegistry] Error stopping ${identity}: ${msg}`,
					);
				}
			}
		}
	}
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

let globalRegistry: ToolAgentRegistry | null = null;

export function getToolAgentRegistry(): ToolAgentRegistry {
	if (!globalRegistry) {
		globalRegistry = new ToolAgentRegistry();
	}
	return globalRegistry;
}
