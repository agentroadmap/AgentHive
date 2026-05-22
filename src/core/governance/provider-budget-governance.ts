/**
 * P434 — Provider Route and Budget Governance
 *
 * Slices:
 *   1. checkRoutePolicy     — fn_check_route_policy wrapper
 *   2. checkBudgetHeadroom  — fn_check_budget_headroom wrapper
 *   3. preClaimBudgetCheck  — composite pre-claim gate (throws on failure)
 *   4. preSpawnBudgetCheck  — credential + plan-type pre-spawn gate (throws on failure)
 *   5. recordSpend          — spending_log INSERT + plan balance updates
 *   6. resolveContextPolicy — highest-specificity context_policy resolution
 *
 * All functions accept an injectable queryFn for unit testing without a live DB.
 * Production callers pass the query() function from src/infra/postgres/pool.ts.
 *
 * Error codes (operator-visible):
 *   ROUTE_POLICY_MISSING   — no enabled route with active provider_account
 *   BUDGET_EXHAUSTED:<scope> — cap hit at the named scope
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export type BudgetScope =
	| "global"
	| "project"
	| "agency"
	| "provider_account"
	| "route"
	| "proposal"
	| "dispatch";

export interface RoutePolicyCheckResult {
	ok: boolean;
	errorCode: "ROUTE_POLICY_MISSING" | null;
	reason: string | null;
}

export interface BudgetCheckResult {
	ok: boolean;
	errorCode: "BUDGET_EXHAUSTED" | "ROUTE_POLICY_MISSING" | null;
	scope: BudgetScope | null;
	reason: string | null;
}

export interface ContextPolicy {
	policy_id: string;
	scope_type: string;
	max_prompt_tokens: number;
	max_history_tokens: number;
	retrieval_policy: string;
	retrieval_topk: number | null;
	summarization_policy: string;
	truncation_behavior: string;
	attachment_policy_max_files: number | null;
	attachment_policy_max_bytes: number | null;
}

// ─── Error Classes ────────────────────────────────────────────────────────────

export class RoutePolicyMissingError extends Error {
	readonly code = "ROUTE_POLICY_MISSING" as const;

	constructor(detail: string) {
		super(`ROUTE_POLICY_MISSING: ${detail}`);
		this.name = "RoutePolicyMissingError";
	}
}

export class BudgetExhaustedError extends Error {
	readonly code = "BUDGET_EXHAUSTED" as const;
	readonly scope: BudgetScope;

	constructor(scope: BudgetScope, detail: string) {
		super(`BUDGET_EXHAUSTED:${scope}: ${detail}`);
		this.name = "BudgetExhaustedError";
		this.scope = scope;
	}
}

// ─── Slice 1: Route policy check ─────────────────────────────────────────────

export interface CheckRoutePolicyOptions {
	agentProvider: string;
	modelName?: string | null;
	queryFn: QueryFn;
}

export async function checkRoutePolicy(
	opts: CheckRoutePolicyOptions,
): Promise<RoutePolicyCheckResult> {
	const { agentProvider, modelName = null, queryFn } = opts;

	const { rows } = await queryFn(
		`SELECT roadmap.fn_check_route_policy($1, $2) AS error_code`,
		[agentProvider, modelName ?? null],
	);

	const errorCode = rows[0]?.error_code as string | null | undefined;

	if (!errorCode) {
		return { ok: true, errorCode: null, reason: null };
	}

	const parts: string[] = [`provider=${agentProvider}`];
	if (modelName) parts.push(`model=${modelName}`);

	return {
		ok: false,
		errorCode: "ROUTE_POLICY_MISSING",
		reason: `ROUTE_POLICY_MISSING: ${parts.join(", ")}`,
	};
}

// ─── Slice 2: Budget headroom check ──────────────────────────────────────────

export interface CheckBudgetHeadroomOptions {
	estimatedCostUsd: number;
	providerAccountId?: string | null;
	scopeIds?: Partial<Record<BudgetScope, string>> | null;
	queryFn: QueryFn;
}

export async function checkBudgetHeadroom(
	opts: CheckBudgetHeadroomOptions,
): Promise<BudgetCheckResult> {
	const { estimatedCostUsd, providerAccountId = null, scopeIds = null, queryFn } = opts;

	const { rows } = await queryFn(
		`SELECT roadmap.fn_check_budget_headroom($1, $2, $3) AS error_code`,
		[estimatedCostUsd, providerAccountId, JSON.stringify(scopeIds ?? {})],
	);

	const raw = rows[0]?.error_code as string | null | undefined;

	if (!raw) {
		return { ok: true, errorCode: null, scope: null, reason: null };
	}

	if (raw === "ROUTE_POLICY_MISSING") {
		return {
			ok: false,
			errorCode: "ROUTE_POLICY_MISSING",
			scope: null,
			reason: raw,
		};
	}

	// Format: BUDGET_EXHAUSTED:<scope>
	const colonIdx = raw.indexOf(":");
	const scope = (colonIdx >= 0 ? raw.slice(colonIdx + 1) : "global") as BudgetScope;

	return {
		ok: false,
		errorCode: "BUDGET_EXHAUSTED",
		scope,
		reason: raw,
	};
}

// ─── Slice 3: Pre-claim composite gate ───────────────────────────────────────

export interface PreClaimBudgetCheckOptions {
	agentProvider: string;
	modelName?: string | null;
	estimatedCostUsd?: number;
	providerAccountId?: string | null;
	scopeIds?: Partial<Record<BudgetScope, string>> | null;
	queryFn: QueryFn;
}

export async function preClaimBudgetCheck(opts: PreClaimBudgetCheckOptions): Promise<void> {
	const {
		agentProvider,
		modelName,
		estimatedCostUsd = 0,
		providerAccountId,
		scopeIds,
		queryFn,
	} = opts;

	// Route policy check — always runs
	const routeResult = await checkRoutePolicy({ agentProvider, modelName, queryFn });
	if (!routeResult.ok) {
		throw new RoutePolicyMissingError(
			routeResult.reason ?? `no enabled route for provider=${agentProvider}`,
		);
	}

	// Budget headroom check — skipped when cost is zero
	if (estimatedCostUsd > 0) {
		const budgetResult = await checkBudgetHeadroom({
			estimatedCostUsd,
			providerAccountId,
			scopeIds,
			queryFn,
		});

		if (!budgetResult.ok) {
			if (budgetResult.errorCode === "ROUTE_POLICY_MISSING") {
				throw new RoutePolicyMissingError(
					budgetResult.reason ?? "provider_account inactive",
				);
			}
			throw new BudgetExhaustedError(
				budgetResult.scope ?? "global",
				budgetResult.reason ?? "budget cap exceeded",
			);
		}
	}
}

// ─── Slice 4: Pre-spawn credential and plan-type checks ──────────────────────

export interface PreSpawnBudgetCheckOptions {
	providerAccountId: string;
	queryFn: QueryFn;
}

export async function preSpawnBudgetCheck(opts: PreSpawnBudgetCheckOptions): Promise<void> {
	const { providerAccountId, queryFn } = opts;

	// Step 1: Load the provider_account row
	const { rows: accountRows } = await queryFn(
		`SELECT plan_type, credential_status
		   FROM roadmap.provider_account
		  WHERE id = $1`,
		[providerAccountId],
	);

	if (accountRows.length === 0) {
		throw new RoutePolicyMissingError(
			`provider_account ${providerAccountId} not found`,
		);
	}

	const account = accountRows[0] as { plan_type: string; credential_status: string };

	// Step 2: Credential status check
	const activeStatuses = new Set(["active", "rotating"]);
	if (!activeStatuses.has(account.credential_status)) {
		throw new RoutePolicyMissingError(
			`provider_account ${providerAccountId} credential is ${account.credential_status}`,
		);
	}

	// Step 3: Plan-type specific checks
	if (account.plan_type === "token_plan") {
		// Hard pre-flight: remaining tokens > 0 and not expired
		const { rows: tokenRows } = await queryFn(
			`SELECT remaining
			   FROM roadmap.plan_token_budget
			  WHERE provider_account_id = $1
			    AND remaining > 0
			    AND (expires_at IS NULL OR expires_at > now())`,
			[providerAccountId],
		);

		if (tokenRows.length === 0) {
			throw new BudgetExhaustedError(
				"provider_account",
				`token_plan budget exhausted for account ${providerAccountId}`,
			);
		}
	} else if (account.plan_type === "api_key_plan") {
		// Soft check: not frozen and under monthly cap
		const { rows: apiRows } = await queryFn(
			`SELECT is_frozen, monthly_spend_cap_usd, current_month_spend_usd
			   FROM roadmap.api_key_plan
			  WHERE provider_account_id = $1
			    AND is_frozen = false
			    AND (monthly_spend_cap_usd IS NULL
			         OR current_month_spend_usd < monthly_spend_cap_usd)`,
			[providerAccountId],
		);

		if (apiRows.length === 0) {
			throw new BudgetExhaustedError(
				"provider_account",
				`api_key_plan frozen or monthly cap exceeded for account ${providerAccountId}`,
			);
		}
	}
	// subscription and local plans: no plan-specific DB check needed
}

// ─── Slice 5: Spend recording ─────────────────────────────────────────────────

export interface RecordSpendOptions {
	agentIdentity: string;
	proposalId?: number | null;
	dispatchId?: number | null;
	routeId?: number | null;
	providerAccountId?: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheTokens?: number;
	costUsd: number;
	budgetScope?: string | null;
	contextPolicyId?: string | null;
	queryFn: QueryFn;
}

export async function recordSpend(opts: RecordSpendOptions): Promise<void> {
	const {
		agentIdentity,
		proposalId = null,
		dispatchId = null,
		routeId = null,
		providerAccountId = null,
		inputTokens,
		outputTokens,
		cacheTokens = 0,
		costUsd,
		budgetScope = null,
		contextPolicyId = null,
		queryFn,
	} = opts;

	// INSERT spending_log
	await queryFn(
		`INSERT INTO roadmap.spending_log
		   (agent_identity, proposal_id, dispatch_id, route_id, provider_account_id,
		    input_tokens, output_tokens, cache_tokens, cost_usd, budget_scope, context_policy_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[
			agentIdentity,
			proposalId,
			dispatchId,
			routeId,
			providerAccountId,
			inputTokens,
			outputTokens,
			cacheTokens,
			costUsd,
			budgetScope,
			contextPolicyId,
		],
	);

	if (!providerAccountId) return;

	// UPDATE plan_token_budget.consumed_tokens
	const totalTokens = inputTokens + outputTokens + cacheTokens;
	await queryFn(
		`UPDATE roadmap.plan_token_budget
		    SET consumed_tokens = consumed_tokens + $2
		  WHERE provider_account_id = $1`,
		[providerAccountId, totalTokens],
	);

	// UPDATE api_key_plan.current_month_spend_usd
	await queryFn(
		`UPDATE roadmap.api_key_plan
		    SET current_month_spend_usd = current_month_spend_usd + $2
		  WHERE provider_account_id = $1`,
		[providerAccountId, costUsd],
	);
}

// ─── Slice 6: Context policy resolution ──────────────────────────────────────

export interface ResolveContextPolicyOptions {
	proposalId?: string | null;
	agencyId?: string | null;
	projectId?: string | null;
	queryFn: QueryFn;
}

export async function resolveContextPolicy(
	opts: ResolveContextPolicyOptions,
): Promise<ContextPolicy | null> {
	const { proposalId = null, agencyId = null, projectId = null, queryFn } = opts;

	const { rows } = await queryFn(
		`SELECT policy_id, scope_type,
		        max_prompt_tokens, max_history_tokens,
		        retrieval_policy, retrieval_topk,
		        summarization_policy, truncation_behavior,
		        attachment_policy_max_files, attachment_policy_max_bytes
		   FROM roadmap.context_policy
		  WHERE (scope_type = 'proposal'  AND scope_ref = $1)
		     OR (scope_type = 'agency'    AND scope_ref = $2)
		     OR (scope_type = 'project'   AND scope_ref = $3)
		     OR (scope_type = 'global')
		  ORDER BY CASE scope_type
		             WHEN 'proposal' THEN 1
		             WHEN 'agency'   THEN 2
		             WHEN 'project'  THEN 3
		             WHEN 'global'   THEN 4
		             ELSE 5
		           END ASC
		  LIMIT 1`,
		[proposalId, agencyId, projectId],
	);

	if (rows.length === 0) return null;

	return rows[0] as unknown as ContextPolicy;
}
