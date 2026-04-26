/**
 * Workflow state names and maturity levels — single source of truth.
 *
 * This module provides:
 * - Frozen maturity constants (NEW, ACTIVE, MATURE, OBSOLETE)
 * - DB-sourced registry of workflow templates and their stages/transitions
 * - Predicates for stage transitions, terminal states, and gatable stages
 * - Per-template convenience objects (RfcStates, HotfixStates) that read from registry
 *
 * The registry is loaded once at process start and reloaded on DB NOTIFY events
 * to ensure live SMDL edits propagate without restart.
 *
 * DESIGN:
 * - All workflow state information comes from roadmap.workflow_templates.smdl_definition (JSONB)
 * - The SMDL is a standardized workflow definition format (stages, transitions, roles)
 * - No string literals for stage/maturity names in the codebase outside this module
 * - Registry is lazily cached; getRegistry() throws if not yet loaded
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Frozen maturity levels — the only valid maturity values in the system.
 */
export const Maturity = Object.freeze({
	NEW: "new",
	ACTIVE: "active",
	MATURE: "mature",
	OBSOLETE: "obsolete",
});

export type MaturityValue = typeof Maturity[keyof typeof Maturity];

/**
 * Metadata for a single stage in a workflow.
 */
export interface StageInfo {
	name: string;
	isTerminal: boolean;
	isGateable: boolean;
	nextOnMature: string | null;
	order: number;
}

/**
 * View of a workflow template's stages and transitions.
 */
export interface WorkflowStateView {
	template: string; // e.g., 'rfc', 'hotfix', 'code-review'
	startStage: string; // first non-terminal stage in order
	terminalStages: ReadonlyArray<string>; // stages with order >= 97
	gateableStages: ReadonlyArray<string>; // stages where a gating decision can occur
	stages: ReadonlyArray<StageInfo>;
}

/**
 * Raw SMDL workflow definition from the DB (subset of fields we care about).
 */
interface SmDlWorkflow {
	id: string;
	name: string;
	stages: Array<{
		name: string;
		order: number;
		description?: string;
		requires_ac?: boolean;
	}>;
	transitions: Array<{
		from: string;
		to: string;
		labels: string[];
		gating?: {
			type: string;
			[key: string]: unknown;
		};
		allowed_roles?: string[];
	}>;
	default_maturity_gate?: number;
}

/**
 * Internal registry entry for a workflow template.
 */
interface TemplateEntry {
	id: string;
	name: string;
	smdlWorkflow: SmDlWorkflow;
	stagesById: Map<string, StageInfo>;
	terminalStages: Set<string>;
	gateableStages: Set<string>;
	transitionMap: Map<string, Set<string>>; // from → {to, to, ...}
	gatingMap: Map<string, string | null>; // from:to → gateType or null
}

/**
 * Global state-names registry — loaded from DB, keyed by template name (lowercase).
 */
export class StateNamesRegistry {
	private entries: Map<string, TemplateEntry> = new Map();
	private notifySubscription: { client: PoolClient; unsubscribe: () => Promise<void> } | null = null;

	/**
	 * Load the registry from the database and set up NOTIFY listeners for live reloads.
	 */
	async load(pool: Pool): Promise<void> {
		// Fetch all workflow templates from the DB
		const result: QueryResult<{ id: string; name: string; smdl_definition: unknown }> =
			await pool.query(
				`SELECT id, name, smdl_definition FROM roadmap.workflow_templates ORDER BY id`,
			);

		this.entries.clear();

		for (const row of result.rows) {
			try {
				// Skip templates with null smdl_definition (not yet configured)
				if (!row.smdl_definition) {
					if (process.env.DEBUG_STATE_NAMES) {
						console.error(
							`[StateNames] Skipping template ${row.id} (${row.name}): null smdl_definition`,
						);
					}
					continue;
				}

				// smdl_definition is JSONB; parse the workflow
				const smdlDef = typeof row.smdl_definition === "string"
					? JSON.parse(row.smdl_definition)
					: row.smdl_definition;
				const workflow: SmDlWorkflow = smdlDef.workflow || smdlDef;

				const templateKey = row.name.toLowerCase();
				const entry = this.buildTemplateEntry(row.id, row.name, workflow);
				this.entries.set(templateKey, entry);
			} catch (error) {
				console.error(`[StateNames] Error parsing workflow template ${row.id}:`, error);
			}
		}

		// Set up NOTIFY listener for live reloads.
		// P522: idempotent — dispose any existing subscription before installing a new one.
		// Previously a fresh registry per createMcpServer() call would acquire a new
		// PoolClient and never release it, exhausting the pool after ~5-10 restarts.
		if (this.notifySubscription) {
			try {
				await this.notifySubscription.unsubscribe();
			} catch (err) {
				console.error("[StateNames] Failed to dispose stale NOTIFY subscription:", err);
			}
			this.notifySubscription = null;
		}

		let client: PoolClient | null = null;
		try {
			client = await pool.connect();
			await client.query("LISTEN workflow_templates_changed");

			const acquiredClient = client;
			const reloadHandler = async () => {
				await this.load(pool).catch((err) => {
					console.error("[StateNames] Error reloading registry on NOTIFY:", err);
				});
			};

			acquiredClient.on("notification", reloadHandler);
			this.notifySubscription = {
				client: acquiredClient,
				unsubscribe: async () => {
					try {
						await acquiredClient.query("UNLISTEN workflow_templates_changed");
					} catch {
						// LISTEN may already be torn down; release anyway.
					}
					acquiredClient.removeListener("notification", reloadHandler);
					acquiredClient.release();
				},
			};
			// Hand-off succeeded; do not release in the finally guard below.
			client = null;
		} catch (error) {
			console.error("[StateNames] Failed to set up NOTIFY listener:", error);
			// Non-fatal; registry will still work without live reload.
			// Release the client we acquired so it returns to the pool.
			if (client) {
				try {
					client.release();
				} catch {
					// best-effort
				}
			}
		}
	}

	/**
	 * Release any held NOTIFY PoolClient. Safe to call on a never-loaded registry.
	 * P522: callers that throw away a registry should call this first to avoid pool leaks.
	 */
	async dispose(): Promise<void> {
		if (this.notifySubscription) {
			try {
				await this.notifySubscription.unsubscribe();
			} finally {
				this.notifySubscription = null;
			}
		}
	}

	/**
	 * Build a TemplateEntry from an SMDL workflow definition.
	 */
	private buildTemplateEntry(
		id: string,
		name: string,
		workflow: SmDlWorkflow,
	): TemplateEntry {
		// Build stage metadata
		const stagesById = new Map<string, StageInfo>();
		const terminalStages = new Set<string>();
		const gateableStages = new Set<string>();
		const transitionMap = new Map<string, Set<string>>();
		const gatingMap = new Map<string, string | null>();

		// Index stages and mark terminal ones (order >= 97)
		for (const stage of workflow.stages) {
			const isTerminal = stage.order >= 97;
			if (isTerminal) {
				terminalStages.add(stage.name);
			}
			stagesById.set(stage.name, {
				name: stage.name,
				isTerminal,
				isGateable: false, // Will be updated from transitions
				nextOnMature: null, // Will be updated from transitions
				order: stage.order,
			});
		}

		// Index transitions to build graph and detect gating
		for (const transition of workflow.transitions) {
			const key = `${transition.from}:${transition.to}`;

			// Track valid next states from this stage
			if (!transitionMap.has(transition.from)) {
				transitionMap.set(transition.from, new Set());
			}
			transitionMap.get(transition.from)!.add(transition.to);

			// Check if this transition has gating
			const hasGating = !!transition.gating;
			gatingMap.set(key, hasGating ? (transition.gating?.type || "true") : null);

			// Mark stages as gateable if they have any "mature" transition
			// (maturity decisions happen at the source of mature transitions)
			if (transition.labels?.includes("mature")) {
				gateableStages.add(transition.from);
			}
		}

		// For each stage, determine nextOnMature (first mature transition)
		for (const stage of workflow.stages) {
			const nextStates = transitionMap.get(stage.name);
			if (nextStates && nextStates.size > 0) {
				// Find the first transition labeled "mature"
				const matured = workflow.transitions.find(
					(t) => t.from === stage.name && t.labels?.includes("mature"),
				);
				if (matured) {
					const stageInfo = stagesById.get(stage.name)!;
					stageInfo.nextOnMature = matured.to;
				}
			}
		}

		// Find start stage: first stage by order that's not terminal
		let startStage = "";
		let minOrder = Infinity;
		for (const [stageName, info] of stagesById) {
			if (!info.isTerminal && info.order < minOrder) {
				startStage = stageName;
				minOrder = info.order;
			}
		}

		// Update isGateable in stageInfo
		for (const stageName of gateableStages) {
			const info = stagesById.get(stageName);
			if (info) {
				info.isGateable = true;
			}
		}

		return {
			id,
			name,
			smdlWorkflow: workflow,
			stagesById,
			terminalStages,
			gateableStages,
			transitionMap,
			gatingMap,
		};
	}

	/**
	 * Get the view for a workflow template (case-insensitive lookup).
	 */
	getView(templateName: string): WorkflowStateView {
		const key = templateName.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) {
			throw new Error(
				`[StateNames] Unknown workflow template: "${templateName}". ` +
					`Known: ${[...this.entries.keys()].join(", ") || "none"}`,
			);
		}

		const stages = [...entry.stagesById.values()].sort((a, b) => a.order - b.order);

		return {
			template: entry.name,
			startStage: stages.find((s) => !s.isTerminal)?.name || stages[0]?.name || "",
			terminalStages: Object.freeze([...entry.terminalStages]),
			gateableStages: Object.freeze([...entry.gateableStages]),
			stages: Object.freeze(stages),
		};
	}

	/**
	 * Check if a stage is terminal (order >= 97).
	 */
	isTerminal(templateName: string, stage: string): boolean {
		const key = templateName.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) return false;
		return entry.terminalStages.has(stage);
	}

	/**
	 * Check if a stage is gateable (has gating transitions).
	 */
	isGateable(templateName: string, stage: string): boolean {
		const key = templateName.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) return false;
		return entry.gateableStages.has(stage);
	}

	/**
	 * Get the next stage when a proposal matures (first "mature" transition).
	 */
	nextOnMature(templateName: string, stage: string): string | null {
		const key = templateName.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) return null;
		const stageInfo = entry.stagesById.get(stage);
		return stageInfo?.nextOnMature || null;
	}

	/**
	 * Check if a transition is valid.
	 */
	isValidTransition(templateName: string, from: string, to: string): boolean {
		const key = templateName.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) return false;
		const nextStates = entry.transitionMap.get(from);
		return nextStates ? nextStates.has(to) : false;
	}

	/**
	 * Get the gating type for a transition (null if no gating, or gating type string).
	 */
	gateForTransition(templateName: string, from: string, to: string): string | null {
		const key = templateName.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) return null;
		const gatingKey = `${from}:${to}`;
		return entry.gatingMap.get(gatingKey) ?? null;
	}

	/**
	 * Clean up NOTIFY subscription.
	 */
	async unsubscribe(): Promise<void> {
		if (this.notifySubscription) {
			await this.notifySubscription.unsubscribe();
			this.notifySubscription = null;
		}
	}
}

// Global singleton instance
let globalRegistry: StateNamesRegistry | null = null;

/**
 * Load the state-names registry from the database.
 * Call this once at process startup.
 *
 * P522: dispose the previous global registry before installing a new one so
 * repeated calls don't leak NOTIFY PoolClients. Prior behaviour orphaned the
 * old registry's subscription on every reload — the root of the pool exhaustion.
 */
export async function loadStateNames(pool: Pool): Promise<StateNamesRegistry> {
	if (globalRegistry) {
		try {
			await globalRegistry.dispose();
		} catch (err) {
			console.error("[StateNames] Failed to dispose prior registry:", err);
		}
	}
	const registry = new StateNamesRegistry();
	await registry.load(pool);
	globalRegistry = registry;
	return registry;
}

/**
 * Get the cached state-names registry.
 * Throws if not yet loaded.
 */
export function getRegistry(): StateNamesRegistry {
	if (!globalRegistry) {
		throw new Error(
			"[StateNames] Registry not loaded. Call loadStateNames(pool) at process startup.",
		);
	}
	return globalRegistry;
}

/**
 * Get the view for a workflow template.
 */
export function getView(templateName: string): WorkflowStateView {
	return getRegistry().getView(templateName);
}

/**
 * Predicate: Is a stage terminal?
 */
export function isTerminal(templateName: string, stage: string): boolean {
	return getRegistry().isTerminal(templateName, stage);
}

/**
 * Predicate: Is a stage gateable?
 */
export function isGateable(templateName: string, stage: string): boolean {
	return getRegistry().isGateable(templateName, stage);
}

/**
 * Get the next stage on maturity.
 */
export function nextOnMature(templateName: string, stage: string): string | null {
	return getRegistry().nextOnMature(templateName, stage);
}

/**
 * Predicate: Is a transition valid?
 */
export function isValidTransition(templateName: string, from: string, to: string): boolean {
	return getRegistry().isValidTransition(templateName, from, to);
}

/**
 * Get the gating type for a transition.
 */
export function gateForTransition(templateName: string, from: string, to: string): string | null {
	return getRegistry().gateForTransition(templateName, from, to);
}

/**
 * Convenience namespace for RFC workflow states.
 * All accessors read from the registry — never literal values.
 */
export const RfcStates = {
	get DRAFT(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "DRAFT")?.name || "DRAFT";
	},
	get REVIEW(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "REVIEW")?.name || "REVIEW";
	},
	get DEVELOP(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "DEVELOP")?.name || "DEVELOP";
	},
	get MERGE(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "MERGE")?.name || "MERGE";
	},
	get COMPLETE(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "COMPLETE")?.name || "COMPLETE";
	},
	get REJECTED(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "REJECTED")?.name || "REJECTED";
	},
	get DISCARDED(): string {
		return getView("Standard RFC").stages.find((s) => s.name === "DISCARDED")?.name || "DISCARDED";
	},
};

/**
 * Convenience namespace for Hotfix workflow states.
 * NOTE: Hotfix template requires smdl_definition in the DB.
 * If not available, accessing HotfixStates.view will throw.
 */
export const HotfixStates = {
	get view(): WorkflowStateView {
		try {
			return getView("Hotfix");
		} catch {
			// Hotfix template not loaded (likely null smdl_definition in DB)
			throw new Error(
				"[StateNames] Hotfix template not available. " +
					"Ensure workflow_templates row id=37 has smdl_definition configured.",
			);
		}
	},
	// Get all stages dynamically; callers can access stages via the view
};
