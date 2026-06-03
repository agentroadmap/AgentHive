/**
 * P434 — Provider Route and Budget Governance
 *
 * Source of truth: roadmap.* in agenthive DB (single-DB until P501/P429).
 * Migration: scripts/migrations/133-p434-provider-budget-governance.sql
 *
 * Slices:
 *   1 — checkRoutePolicy()      calls fn_check_route_policy; returns RoutePolicyCheckResult
 *   2 — checkBudgetHeadroom()   calls fn_check_budget_headroom; returns BudgetCheckResult
 *   3 — preClaimBudgetCheck()   runs slices 1+2; throws on failure
 *   4 — preSpawnBudgetCheck()   credential status + plan-type hard/soft check
 *   5 — recordSpend()           INSERT spending_log + UPDATE plan balances
 *   6 — resolveContextPolicy()  returns highest-specificity context_policy row
 *
 * Error codes (operator-visible):
 *   ROUTE_POLICY_MISSING      — no enabled route with active provider_account
 *   BUDGET_EXHAUSTED:<scope>  — named scope exceeded (global/project/agency/…)
 *
 * All functions accept optional queryFn for unit testing without a live DB.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface RoutePolicyCheckResult {
  ok: boolean;
  errorCode: "ROUTE_POLICY_MISSING" | null;
  reason?: string;
}

export interface BudgetCheckResult {
  ok: boolean;
  errorCode: "BUDGET_EXHAUSTED" | "ROUTE_POLICY_MISSING" | null;
  scope: string | null;
}

export interface ContextPolicyRow {
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

export interface CheckRoutePolicyOptions {
  agentProvider: string;
  modelName?: string;
  queryFn?: QueryFn;
}

export interface CheckBudgetHeadroom {
  estimatedCostUsd: number;
  providerAccountId?: string;
  scopeIds?: {
    project?: string;
    agency?: string;
    route?: string;
    proposal?: string;
    dispatch?: string;
  };
  queryFn?: QueryFn;
}

export interface PreClaimBudgetCheckOptions {
  agentProvider: string;
  modelName?: string;
  estimatedCostUsd?: number;
  providerAccountId?: string;
  scopeIds?: CheckBudgetHeadroom["scopeIds"];
  queryFn?: QueryFn;
}

export interface PreSpawnBudgetCheckOptions {
  providerAccountId: string;
  queryFn?: QueryFn;
}

export interface RecordSpendOptions {
  agentIdentity: string;
  proposalId?: number;
  dispatchId?: number;
  routeId?: number;
  providerAccountId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  costUsd: number;
  budgetScope?: string;
  contextPolicyId?: string;
  queryFn?: QueryFn;
}

export interface ResolveContextPolicyOptions {
  proposalId?: string;
  agencyId?: string;
  projectId?: string;
  queryFn?: QueryFn;
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class RoutePolicyMissingError extends Error {
  readonly code = "ROUTE_POLICY_MISSING" as const;

  constructor(detail: string) {
    super(`ROUTE_POLICY_MISSING: ${detail}`);
    this.name = "RoutePolicyMissingError";
  }
}

export class BudgetExhaustedError extends Error {
  readonly code = "BUDGET_EXHAUSTED" as const;
  readonly scope: string;

  constructor(scope: string, detail: string) {
    super(`BUDGET_EXHAUSTED:${scope}: ${detail}`);
    this.name = "BudgetExhaustedError";
    this.scope = scope;
  }
}

// ─── Slice 1: Route policy ────────────────────────────────────────────────────

export async function checkRoutePolicy(
  opts: CheckRoutePolicyOptions,
): Promise<RoutePolicyCheckResult> {
  const { agentProvider, modelName = null, queryFn = defaultQuery } = opts;

  const { rows } = await queryFn(
    `SELECT fn_check_route_policy($1, $2) AS error_code`,
    [agentProvider, modelName],
  );

  const row = rows[0] as { error_code: string | null } | undefined;
  const errorCode = row?.error_code ?? null;

  if (errorCode === "ROUTE_POLICY_MISSING") {
    const parts = [agentProvider, modelName].filter(Boolean).join("/");
    return {
      ok: false,
      errorCode: "ROUTE_POLICY_MISSING",
      reason: `ROUTE_POLICY_MISSING: no enabled route for provider=${parts}`,
    };
  }

  return { ok: true, errorCode: null };
}

// ─── Slice 2: Budget headroom ─────────────────────────────────────────────────

export async function checkBudgetHeadroom(
  opts: CheckBudgetHeadroom,
): Promise<BudgetCheckResult> {
  const {
    estimatedCostUsd,
    providerAccountId = null,
    scopeIds = {},
    queryFn = defaultQuery,
  } = opts;

  const { rows } = await queryFn(
    `SELECT fn_check_budget_headroom($1, $2, $3::jsonb) AS error_code`,
    [estimatedCostUsd, providerAccountId, JSON.stringify(scopeIds)],
  );

  const row = rows[0] as { error_code: string | null } | undefined;
  const raw = row?.error_code ?? null;

  if (!raw) {
    return { ok: true, errorCode: null, scope: null };
  }

  if (raw.startsWith("BUDGET_EXHAUSTED:")) {
    const scope = raw.slice("BUDGET_EXHAUSTED:".length);
    return { ok: false, errorCode: "BUDGET_EXHAUSTED", scope };
  }

  if (raw === "ROUTE_POLICY_MISSING") {
    return { ok: false, errorCode: "ROUTE_POLICY_MISSING", scope: null };
  }

  return { ok: false, errorCode: null, scope: null };
}

// ─── Slice 3: Pre-claim composite gate ───────────────────────────────────────

export async function preClaimBudgetCheck(
  opts: PreClaimBudgetCheckOptions,
): Promise<void> {
  const {
    agentProvider,
    modelName,
    estimatedCostUsd = 0,
    providerAccountId,
    scopeIds,
    queryFn = defaultQuery,
  } = opts;

  const routeResult = await checkRoutePolicy({ agentProvider, modelName, queryFn });
  if (!routeResult.ok) {
    throw new RoutePolicyMissingError(
      routeResult.reason ?? `no enabled route for provider=${agentProvider}`,
    );
  }

  if (estimatedCostUsd === 0) return;

  const budgetResult = await checkBudgetHeadroom({
    estimatedCostUsd,
    providerAccountId,
    scopeIds,
    queryFn,
  });

  if (!budgetResult.ok) {
    if (budgetResult.errorCode === "BUDGET_EXHAUSTED") {
      throw new BudgetExhaustedError(
        budgetResult.scope ?? "unknown",
        `estimated cost $${estimatedCostUsd} exceeds ${budgetResult.scope} cap`,
      );
    }
    if (budgetResult.errorCode === "ROUTE_POLICY_MISSING") {
      throw new RoutePolicyMissingError(
        `provider_account inactive for provider=${agentProvider}`,
      );
    }
  }
}

// ─── Slice 4: Pre-spawn credential and plan-type checks ───────────────────────

export async function preSpawnBudgetCheck(
  opts: PreSpawnBudgetCheckOptions,
): Promise<void> {
  const { providerAccountId, queryFn = defaultQuery } = opts;

  const { rows: accountRows } = await queryFn(
    `SELECT plan_type, credential_status
       FROM roadmap.provider_account
      WHERE id = $1`,
    [providerAccountId],
  );

  if (accountRows.length === 0) {
    throw new RoutePolicyMissingError(
      `provider_account not found: ${providerAccountId}`,
    );
  }

  const account = accountRows[0] as { plan_type: string; credential_status: string };

  if (account.credential_status === "expired") {
    throw new RoutePolicyMissingError(
      `provider_account credential expired: ${providerAccountId}`,
    );
  }
  if (account.credential_status === "revoked") {
    throw new RoutePolicyMissingError(
      `provider_account credential revoked: ${providerAccountId}`,
    );
  }

  if (account.plan_type === "token_plan") {
    const { rows: planRows } = await queryFn(
      `SELECT remaining
         FROM roadmap.plan_token_budget
        WHERE provider_account_id = $1
          AND remaining > 0
          AND (expires_at IS NULL OR expires_at > now())`,
      [providerAccountId],
    );
    if (planRows.length === 0) {
      throw new BudgetExhaustedError(
        "provider_account",
        `token_plan budget exhausted for account ${providerAccountId}`,
      );
    }
    return;
  }

  if (account.plan_type === "api_key_plan") {
    const { rows: planRows } = await queryFn(
      `SELECT is_frozen, monthly_spend_cap_usd, current_month_spend_usd
         FROM roadmap.api_key_plan
        WHERE provider_account_id = $1
          AND is_frozen = false
          AND (monthly_spend_cap_usd IS NULL
               OR current_month_spend_usd < monthly_spend_cap_usd)`,
      [providerAccountId],
    );
    if (planRows.length === 0) {
      throw new BudgetExhaustedError(
        "provider_account",
        `api_key_plan frozen or monthly cap exceeded for account ${providerAccountId}`,
      );
    }
    return;
  }

  // subscription / local: no plan-specific check
}

// ─── Slice 5: Spend recording ─────────────────────────────────────────────────

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
    queryFn = defaultQuery,
  } = opts;

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

  const totalTokens = inputTokens + outputTokens + cacheTokens;

  await queryFn(
    `UPDATE roadmap.plan_token_budget
        SET consumed_tokens = consumed_tokens + $2
      WHERE provider_account_id = $1`,
    [providerAccountId, totalTokens],
  );

  await queryFn(
    `UPDATE roadmap.api_key_plan
        SET current_month_spend_usd = current_month_spend_usd + $2
      WHERE provider_account_id = $1`,
    [providerAccountId, costUsd],
  );
}

// ─── Slice 6: Context policy resolution ──────────────────────────────────────

export async function resolveContextPolicy(
  opts: ResolveContextPolicyOptions,
): Promise<ContextPolicyRow | null> {
  const {
    proposalId = null,
    agencyId = null,
    projectId = null,
    queryFn = defaultQuery,
  } = opts;

  const { rows } = await queryFn(
    `SELECT policy_id, scope_type, max_prompt_tokens, max_history_tokens,
            retrieval_policy, retrieval_topk, summarization_policy,
            truncation_behavior, attachment_policy_max_files, attachment_policy_max_bytes
       FROM roadmap.context_policy
      WHERE scope_type = 'global'
         OR ($1 IS NOT NULL AND scope_type = 'proposal' AND scope_ref = $1)
         OR ($2 IS NOT NULL AND scope_type = 'agency'   AND scope_ref = $2)
         OR ($3 IS NOT NULL AND scope_type = 'project'  AND scope_ref = $3)
      ORDER BY CASE scope_type
                 WHEN 'proposal' THEN 1
                 WHEN 'agency'   THEN 2
                 WHEN 'project'  THEN 3
                 WHEN 'global'   THEN 4
               END
      LIMIT 1`,
    [proposalId, agencyId, projectId],
  );

  if (rows.length === 0) return null;
  return rows[0] as ContextPolicyRow;
}
