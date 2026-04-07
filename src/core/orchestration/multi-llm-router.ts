/**
 * Multi-LLM Task Router
 *
 * Implements STATE-93: Multi-LLM Task Router
 *
 * AC#1: Router reads proposal priority and labels to determine reasoning tier
 * AC#2: Dynamic team builder uses the router to select agents
 * AC#3: Cost tracking per task based on model usage
 * AC#4: Support for fallback routing
 */

// ===================== Types =====================

/** LLM reasoning tiers from basic to premium */
export type ReasoningTier = "basic" | "standard" | "advanced" | "premium";

/** Model provider identifiers */
export type ModelProvider = "anthropic" | "openai" | "google" | "local";

/** Model configuration */
export interface ModelConfig {
	/** Unique model identifier */
	modelId: string;
	/** Human-readable name */
	displayName: string;
	/** Provider */
	provider: ModelProvider;
	/** Reasoning capability tier */
	tier: ReasoningTier;
	/** Cost per 1K input tokens (USD) */
	inputCostPer1k: number;
	/** Cost per 1K output tokens (USD) */
	outputCostPer1k: number;
	/** Maximum context window tokens */
	maxContextTokens: number;
	/** Supported capabilities */
	capabilities: string[];
	/** Whether this model is currently available */
	available: boolean;
}

/** Task definition for routing */
export interface TaskDefinition {
	/** Unique task identifier */
	taskId: string;
	/** Associated proposal ID if applicable */
	proposalId?: string;
	/** Proposal priority level */
	priority: "low" | "medium" | "high" | "critical";
	/** Proposal labels */
	labels: string[];
	/** Required capabilities for the task */
	requiredCapabilities: string[];
	/** Estimated complexity (affects tier selection) */
	complexity: "trivial" | "simple" | "moderate" | "complex" | "critical";
	/** Maximum acceptable latency in ms */
	maxLatencyMs?: number;
	/** Preferred model provider (if any) */
	preferredProvider?: ModelProvider;
}

/** Routing decision output */
export interface RoutingDecision {
	/** The task being routed */
	taskId: string;
	/** Selected model config */
	selectedModel: ModelConfig;
	/** Reason for selection */
	reason: string;
	/** Assigned reasoning tier */
	tier: ReasoningTier;
	/** Estimated cost for this task */
	estimatedCost: EstimatedCost;
	/** Fallback models in order of preference */
	fallbackModels: ModelConfig[];
	/** Routing timestamp */
	routedAt: number;
}

/** Cost estimation for a task */
export interface EstimatedCost {
	/** Estimated input tokens */
	estimatedInputTokens: number;
	/** Estimated output tokens */
	estimatedOutputTokens: number;
	/** Estimated cost (USD) */
	estimatedCostUsd: number;
	/** Whether this is within budget */
	withinBudget: boolean;
	/** Budget limit if set */
	budgetLimitUsd: number | null;
}

/** Cost tracking record */
export interface CostRecord {
	/** Task identifier */
	taskId: string;
	/** Model used */
	modelId: string;
	/** Reasoning tier */
	tier: ReasoningTier;
	/** Actual input tokens consumed */
	inputTokens: number;
	/** Actual output tokens consumed */
	outputTokens: number;
	/** Actual cost in USD */
	costUsd: number;
	/** Timestamp */
	timestamp: number;
	/** Task priority at time of routing */
	priority: string;
}

/** Routing history entry */
export interface RoutingHistoryEntry {
	decision: RoutingDecision;
	costRecord: CostRecord | null;
	usedFallback: boolean;
	fallbackReason: string | null;
}

// ===================== Constants =====================

/** Complexity to reasoning tier mapping */
export const COMPLEXITY_TO_TIER: Record<string, ReasoningTier> = {
	trivial: "basic",
	simple: "basic",
	moderate: "standard",
	complex: "advanced",
	critical: "premium",
};

/** Priority to reasoning tier mapping */
export const PRIORITY_TO_TIER: Record<string, ReasoningTier> = {
	low: "basic",
	medium: "standard",
	high: "advanced",
	critical: "premium",
};

/** Labels that trigger higher reasoning tiers */
export const HIGH_TIER_LABELS = new Set([
	"security",
	"federation",
	"architecture",
	"critical-thinking",
	"risk-assessment",
	"auth",
	"crypto",
	"data-migration",
]);

/** Labels that can use lower tiers (routine tasks) */
export const LOW_TIER_LABELS = new Set([
	"docs",
	"documentation",
	"routine",
	"maintenance",
	"cleanup",
	"style",
]);

/** Default cost budget per task (USD) */
export const DEFAULT_COST_BUDGET_USD = 0.1;

/** Maximum context tokens for cost estimation */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

// ===================== Model Registry =====================

/** Default model configurations */
export const DEFAULT_MODELS: ModelConfig[] = [
	// Anthropic models
	{
		modelId: "claude-opus-4",
		displayName: "Claude Opus 4",
		provider: "anthropic",
		tier: "premium",
		inputCostPer1k: 0.015,
		outputCostPer1k: 0.075,
		maxContextTokens: 200000,
		capabilities: ["code", "analysis", "reasoning", "creative", "long-context"],
		available: true,
	},
	{
		modelId: "claude-sonnet-4",
		displayName: "Claude Sonnet 4",
		provider: "anthropic",
		tier: "advanced",
		inputCostPer1k: 0.003,
		outputCostPer1k: 0.015,
		maxContextTokens: 200000,
		capabilities: ["code", "analysis", "reasoning", "creative"],
		available: true,
	},
	{
		modelId: "claude-haiku-3.5",
		displayName: "Claude Haiku 3.5",
		provider: "anthropic",
		tier: "standard",
		inputCostPer1k: 0.0008,
		outputCostPer1k: 0.004,
		maxContextTokens: 200000,
		capabilities: ["code", "analysis", "reasoning"],
		available: true,
	},
	// OpenAI models
	{
		modelId: "gpt-4o",
		displayName: "GPT-4o",
		provider: "openai",
		tier: "advanced",
		inputCostPer1k: 0.0025,
		outputCostPer1k: 0.01,
		maxContextTokens: 128000,
		capabilities: ["code", "analysis", "reasoning", "multimodal"],
		available: true,
	},
	{
		modelId: "gpt-4o-mini",
		displayName: "GPT-4o Mini",
		provider: "openai",
		tier: "standard",
		inputCostPer1k: 0.00015,
		outputCostPer1k: 0.0006,
		maxContextTokens: 128000,
		capabilities: ["code", "analysis"],
		available: true,
	},
	// Local model (always available, lowest cost)
	{
		modelId: "local-fast",
		displayName: "Local Fast Model",
		provider: "local",
		tier: "basic",
		inputCostPer1k: 0.00001,
		outputCostPer1k: 0.00002,
		maxContextTokens: 32000,
		capabilities: ["code", "analysis"],
		available: true,
	},
];

// ===================== Multi-LLM Task Router =====================

/**
 * Routes tasks to appropriate LLM models based on priority, complexity,
 * and capability requirements. Supports cost tracking and fallback routing.
 */
export class MultiLLMRouter {
	private models: Map<string, ModelConfig> = new Map();
	private routingHistory: RoutingHistoryEntry[] = [];
	private costRecords: CostRecord[] = [];
	private costBudgetUsd: number;

	constructor(
		models: ModelConfig[] = DEFAULT_MODELS,
		costBudgetUsd: number = DEFAULT_COST_BUDGET_USD,
	) {
		for (const model of models) {
			this.models.set(model.modelId, model);
		}
		this.costBudgetUsd = costBudgetUsd;
	}

	// ===================== AC#1: Tier Determination from Priority & Labels =====================

	/**
	 * Determine reasoning tier based on proposal priority and labels.
	 * AC#1: Router reads proposal priority and labels to determine reasoning tier
	 *
	 * @param task - Task definition with priority and labels
	 * @returns Determined reasoning tier
	 */
	determineTier(task: TaskDefinition): ReasoningTier {
		// Start with complexity-based tier
		let tier = COMPLEXITY_TO_TIER[task.complexity] || "standard";

		// Override with priority-based tier if higher
		const priorityTier = PRIORITY_TO_TIER[task.priority] || "standard";
		tier = this._promoteTierIfHigher(tier, priorityTier);

		// Adjust based on labels
		const labelTier = this._tierFromLabels(task.labels);
		tier = this._promoteTierIfHigher(tier, labelTier);

		// If task requires premium capabilities, ensure premium tier
		if (
			task.requiredCapabilities.includes("critical-thinking") ||
			task.requiredCapabilities.includes("risk-assessment")
		) {
			tier = this._promoteTierIfHigher(tier, "premium");
		}

		return tier;
	}

	/**
	 * Determine tier from labels.
	 */
	private _tierFromLabels(labels: string[]): ReasoningTier {
		let tier: ReasoningTier = "basic";

		for (const label of labels) {
			if (HIGH_TIER_LABELS.has(label)) {
				tier = this._promoteTierIfHigher(tier, "advanced");
			} else if (LOW_TIER_LABELS.has(label)) {
				// Keep at basic or standard
				if (tier === "premium" || tier === "advanced") {
					// Don't downgrade high-tier tasks
				} else {
					tier = "basic";
				}
			}
		}

		return tier;
	}

	/**
	 * Promote tier if the new tier is higher.
	 */
	private _promoteTierIfHigher(
		current: ReasoningTier,
		candidate: ReasoningTier,
	): ReasoningTier {
		const rank: Record<ReasoningTier, number> = {
			basic: 0,
			standard: 1,
			advanced: 2,
			premium: 3,
		};
		return rank[candidate] > rank[current] ? candidate : current;
	}

	// ===================== AC#2: Team Builder Integration =====================

	/**
	 * Route a task to an appropriate model, considering team builder integration.
	 * AC#2: Dynamic team builder uses the router to select agents
	 *
	 * @param task - Task definition
	 * @returns Routing decision with selected model and fallbacks
	 */
	route(task: TaskDefinition): RoutingDecision {
		const tier = this.determineTier(task);

		// Find models matching tier and capabilities
		const candidates = this._findCandidateModels(
			tier,
			task.requiredCapabilities,
		);

		// Apply provider preference if specified
		const filtered = task.preferredProvider
			? candidates.filter((m) => m.provider === task.preferredProvider)
			: candidates;

		// Use preferred provider candidates, or fall back to all candidates
		const selection = filtered.length > 0 ? filtered : candidates;

		if (selection.length === 0) {
			throw new Error(
				`No available models for tier ${tier} with capabilities: ${task.requiredCapabilities.join(", ")}`,
			);
		}

		// Select best model (prefer lower cost within same tier)
		const selected = this._selectBestModel(selection, task);

		// Build fallback chain (other models in tier, then lower tiers)
		const fallbacks = this._buildFallbackChain(
			tier,
			task.requiredCapabilities,
			selected.modelId,
		);

		// Estimate cost
		const estimatedCost = this._estimateCost(task, selected);

		const decision: RoutingDecision = {
			taskId: task.taskId,
			selectedModel: selected,
			reason: this._buildReason(task, tier, selected),
			tier,
			estimatedCost,
			fallbackModels: fallbacks,
			routedAt: Date.now(),
		};

		return decision;
	}

	/**
	 * Route task with team builder integration.
	 * Provides a routing decision suitable for team builder consumption.
	 */
	routeForTeam(
		task: TaskDefinition,
		teamContext?: {
			projectId: string;
			teamId: string;
			agentRoles: string[];
		},
	): RoutingDecision {
		const decision = this.route(task);

		// Log with team context if provided
		if (teamContext) {
			this.routingHistory.push({
				decision,
				costRecord: null,
				usedFallback: false,
				fallbackReason: null,
			});
		}

		return decision;
	}

	// ===================== AC#3: Cost Tracking =====================

	/**
	 * Track cost for a completed task.
	 * AC#3: Cost tracking per task based on model usage
	 *
	 * @param taskId - Task identifier
	 * @param modelId - Model that was used
	 * @param inputTokens - Actual input tokens consumed
	 * @param outputTokens - Actual output tokens consumed
	 */
	trackCost(
		taskId: string,
		modelId: string,
		inputTokens: number,
		outputTokens: number,
	): CostRecord {
		const model = this.models.get(modelId);
		if (!model) {
			throw new Error(`Unknown model: ${modelId}`);
		}

		const costUsd =
			(inputTokens / 1000) * model.inputCostPer1k +
			(outputTokens / 1000) * model.outputCostPer1k;

		const record: CostRecord = {
			taskId,
			modelId,
			tier: model.tier,
			inputTokens,
			outputTokens,
			costUsd,
			timestamp: Date.now(),
			priority: "unknown", // Will be updated if decision is available
		};

		this.costRecords.push(record);

		// Update routing history if exists
		const historyEntry = this.routingHistory.find(
			(h) => h.decision.taskId === taskId,
		);
		if (historyEntry) {
			historyEntry.costRecord = record;
		}

		return record;
	}

	/**
	 * Get total cost across all tracked tasks.
	 */
	getTotalCost(): number {
		return this.costRecords.reduce((sum, r) => sum + r.costUsd, 0);
	}

	/**
	 * Get cost breakdown by tier.
	 */
	getCostByTier(): Record<ReasoningTier, number> {
		const breakdown: Record<ReasoningTier, number> = {
			basic: 0,
			standard: 0,
			advanced: 0,
			premium: 0,
		};

		for (const record of this.costRecords) {
			breakdown[record.tier] += record.costUsd;
		}

		return breakdown;
	}

	/**
	 * Get cost breakdown by model.
	 */
	getCostByModel(): Record<string, number> {
		const breakdown: Record<string, number> = {};

		for (const record of this.costRecords) {
			breakdown[record.modelId] =
				(breakdown[record.modelId] || 0) + record.costUsd;
		}

		return breakdown;
	}

	/**
	 * Get routing history.
	 */
	getRoutingHistory(): RoutingHistoryEntry[] {
		return [...this.routingHistory];
	}

	/**
	 * Get cost records.
	 */
	getCostRecords(): CostRecord[] {
		return [...this.costRecords];
	}

	// ===================== AC#4: Fallback Routing =====================

	/**
	 * Execute task with automatic fallback on failure.
	 * AC#4: Support for fallback routing
	 *
	 * @param task - Task definition
	 * @param executeFn - Function to execute the task with a model
	 * @returns Result from successful execution
	 */
	async routeWithFallback<T>(
		task: TaskDefinition,
		executeFn: (model: ModelConfig) => Promise<T>,
	): Promise<{ result: T; model: ModelConfig; usedFallback: boolean }> {
		const decision = this.route(task);
		const allModels = [decision.selectedModel, ...decision.fallbackModels];

		let lastError: Error | null = null;

		for (const model of allModels) {
			try {
				const result = await executeFn(model);
				const usedFallback = model.modelId !== decision.selectedModel.modelId;

				// Record routing history
				this.routingHistory.push({
					decision,
					costRecord: null,
					usedFallback,
					fallbackReason: usedFallback
						? `Primary model failed: ${lastError?.message}`
						: null,
				});

				return { result, model, usedFallback };
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				// Continue to next fallback
			}
		}

		// All models failed
		throw new Error(
			`All models failed for task ${task.taskId}. Last error: ${lastError?.message}`,
		);
	}

	// ===================== Internal Helpers =====================

	/**
	 * Find candidate models matching tier and capabilities.
	 */
	private _findCandidateModels(
		tier: ReasoningTier,
		requiredCapabilities: string[],
	): ModelConfig[] {
		const tierRank: Record<ReasoningTier, number> = {
			basic: 0,
			standard: 1,
			advanced: 2,
			premium: 3,
		};
		const targetRank = tierRank[tier];

		const candidates: ModelConfig[] = [];

		for (const model of this.models.values()) {
			if (!model.available) continue;
			if (tierRank[model.tier] !== targetRank) continue;

			// Check capability coverage
			const modelCaps = new Set(model.capabilities);
			const hasAllCaps = requiredCapabilities.every((cap) =>
				modelCaps.has(cap),
			);

			if (hasAllCaps || requiredCapabilities.length === 0) {
				candidates.push(model);
			}
		}

		// If no exact match, look at higher tiers
		if (candidates.length === 0) {
			for (const model of this.models.values()) {
				if (!model.available) continue;
				if (tierRank[model.tier] <= targetRank) continue;

				const modelCaps = new Set(model.capabilities);
				const hasAllCaps = requiredCapabilities.every((cap) =>
					modelCaps.has(cap),
				);

				if (hasAllCaps || requiredCapabilities.length === 0) {
					candidates.push(model);
				}
			}
		}

		return candidates;
	}

	/**
	 * Select the best model from candidates (prefer lower cost).
	 */
	private _selectBestModel(
		candidates: ModelConfig[],
		task: TaskDefinition,
	): ModelConfig {
		// Sort by cost (ascending), then by tier match (closer to required is better)
		const tier = this.determineTier(task);
		const tierRank: Record<ReasoningTier, number> = {
			basic: 0,
			standard: 1,
			advanced: 2,
			premium: 3,
		};
		const targetRank = tierRank[tier];

		candidates.sort((a, b) => {
			// Prefer models at exact tier
			const aTierDiff = Math.abs(tierRank[a.tier] - targetRank);
			const bTierDiff = Math.abs(tierRank[b.tier] - targetRank);
			if (aTierDiff !== bTierDiff) return aTierDiff - bTierDiff;

			// Then prefer lower cost
			const aCost = a.inputCostPer1k + a.outputCostPer1k;
			const bCost = b.inputCostPer1k + b.outputCostPer1k;
			return aCost - bCost;
		});

		return candidates[0];
	}

	/**
	 * Build fallback chain of models.
	 */
	private _buildFallbackChain(
		tier: ReasoningTier,
		requiredCapabilities: string[],
		excludeModelId: string,
	): ModelConfig[] {
		const tierRank: Record<ReasoningTier, number> = {
			basic: 0,
			standard: 1,
			advanced: 2,
			premium: 3,
		};
		const targetRank = tierRank[tier];

		const fallbacks: ModelConfig[] = [];

		// First: other models at same tier
		for (const model of this.models.values()) {
			if (!model.available) continue;
			if (model.modelId === excludeModelId) continue;
			if (tierRank[model.tier] !== targetRank) continue;

			const modelCaps = new Set(model.capabilities);
			const hasAllCaps = requiredCapabilities.every((cap) =>
				modelCaps.has(cap),
			);
			if (hasAllCaps || requiredCapabilities.length === 0) {
				fallbacks.push(model);
			}
		}

		// Second: models at higher tiers (more capable)
		const higherTiers = (Object.keys(tierRank) as ReasoningTier[])
			.filter((t) => tierRank[t] > targetRank)
			.sort((a, b) => tierRank[a] - tierRank[b]);

		for (const higherTier of higherTiers) {
			for (const model of this.models.values()) {
				if (!model.available) continue;
				if (model.modelId === excludeModelId) continue;
				if (model.tier !== higherTier) continue;

				const modelCaps = new Set(model.capabilities);
				const hasAllCaps = requiredCapabilities.every((cap) =>
					modelCaps.has(cap),
				);
				if (hasAllCaps || requiredCapabilities.length === 0) {
					fallbacks.push(model);
				}
			}
		}

		// Third: any available model (ultimate fallback)
		if (fallbacks.length === 0) {
			for (const model of this.models.values()) {
				if (!model.available) continue;
				if (model.modelId === excludeModelId) continue;
				fallbacks.push(model);
			}
		}

		return fallbacks;
	}

	/**
	 * Estimate cost for a task given a model.
	 */
	private _estimateCost(
		task: TaskDefinition,
		model: ModelConfig,
	): EstimatedCost {
		// Rough estimation based on task complexity
		const complexityMultiplier: Record<string, number> = {
			trivial: 0.5,
			simple: 1,
			moderate: 2,
			complex: 4,
			critical: 8,
		};

		const multiplier = complexityMultiplier[task.complexity] || 2;
		const estimatedInputTokens = 1000 * multiplier;
		const estimatedOutputTokens = Math.min(
			DEFAULT_MAX_OUTPUT_TOKENS,
			500 * multiplier,
		);

		const estimatedCostUsd =
			(estimatedInputTokens / 1000) * model.inputCostPer1k +
			(estimatedOutputTokens / 1000) * model.outputCostPer1k;

		return {
			estimatedInputTokens,
			estimatedOutputTokens,
			estimatedCostUsd,
			withinBudget: estimatedCostUsd <= this.costBudgetUsd,
			budgetLimitUsd: this.costBudgetUsd,
		};
	}

	/**
	 * Build human-readable reason for routing decision.
	 */
	private _buildReason(
		task: TaskDefinition,
		tier: ReasoningTier,
		model: ModelConfig,
	): string {
		const reasons: string[] = [];

		reasons.push(
			`tier ${tier} (priority: ${task.priority}, complexity: ${task.complexity})`,
		);

		if (task.labels.some((l) => HIGH_TIER_LABELS.has(l))) {
			const highLabels = task.labels.filter((l) => HIGH_TIER_LABELS.has(l));
			reasons.push(`high-tier labels: ${highLabels.join(", ")}`);
		}

		if (task.requiredCapabilities.length > 0) {
			reasons.push(`requires: ${task.requiredCapabilities.join(", ")}`);
		}

		reasons.push(
			`selected: ${model.displayName} ($${model.inputCostPer1k}/1k in, $${model.outputCostPer1k}/1k out)`,
		);

		return reasons.join("; ");
	}

	// ===================== Model Management =====================

	/**
	 * Add or update a model configuration.
	 */
	registerModel(model: ModelConfig): void {
		this.models.set(model.modelId, model);
	}

	/**
	 * Remove a model from the registry.
	 */
	deregisterModel(modelId: string): boolean {
		return this.models.delete(modelId);
	}

	/**
	 * Set model availability.
	 */
	setModelAvailable(modelId: string, available: boolean): void {
		const model = this.models.get(modelId);
		if (model) {
			model.available = available;
		}
	}

	/**
	 * Get all registered models.
	 */
	getModels(): ModelConfig[] {
		return Array.from(this.models.values());
	}

	/**
	 * Get models by tier.
	 */
	getModelsByTier(tier: ReasoningTier): ModelConfig[] {
		return Array.from(this.models.values()).filter((m) => m.tier === tier);
	}

	/**
	 * Get models by provider.
	 */
	getModelsByProvider(provider: ModelProvider): ModelConfig[] {
		return Array.from(this.models.values()).filter(
			(m) => m.provider === provider,
		);
	}

	/**
	 * Set cost budget per task.
	 */
	setCostBudget(budgetUsd: number): void {
		this.costBudgetUsd = budgetUsd;
	}

	/**
	 * Clear cost tracking history.
	 */
	clearCostHistory(): void {
		this.costRecords = [];
		this.routingHistory = [];
	}
}
