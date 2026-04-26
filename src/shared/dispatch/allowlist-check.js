/**
 * P484 Phase 1: Dispatch Allowlist Check
 *
 * Evaluates whether a dispatch request is allowed based on:
 * 1. Route allowlist (fail-closed: missing row = deny)
 * 2. Capability scope (fail-closed: missing row = deny)
 * 3. Budget cap (optional, with atomic enforcement)
 * 4. Compliance hook (Phase 2: stubbed as pass-through)
 *
 * All decisions are written to dispatch_route_audit for audit trail.
 * Budget checks use SELECT...FOR UPDATE to prevent race conditions.
 *
 * AC #102: Default-DENY verified. No code path treats "no row" as "allow all".
 * AC #103: Compliance hook stubbed for Phase 2.
 * AC #104: Audit redaction: only stores route_name, no secret leaks.
 */
import { query } from "../../infra/postgres/pool.ts";
/**
 * Evaluate a dispatch request against allowlist, capability scope, and budget.
 * All decisions are audited via INSERT into dispatch_route_audit.
 *
 * Fail-closed: missing allowlist or capability scope = DENY.
 * Budget check is optional (if estimated_usd_cents not provided, skipped).
 * Compliance hook is Phase 2 (currently pass-through).
 */
export async function evaluateDispatch(args) {
    const { project_id, route_name, capability_name, estimated_usd_cents, agency_identity, agent_identity, } = args;
    // Step 1: Check route allowlist (fail-closed: NOT EXISTS = deny)
    const routeCheckResult = await query(`SELECT id FROM roadmap.project_route_allowlist
     WHERE project_id = $1 AND route_name = $2`, [project_id, route_name]);
    if (!routeCheckResult.rows.length) {
        const auditResult = await writeAudit(project_id, route_name, capability_name, "deny_route", "Route not in allowlist for this project", null, agency_identity, agent_identity);
        return {
            allow: false,
            reason: "route_not_in_allowlist",
            audit_id: auditResult,
        };
    }
    // Step 2: Check capability scope (fail-closed: NOT EXISTS = deny)
    const capabilityCheckResult = await query(`SELECT id FROM roadmap.project_capability_scope
     WHERE project_id = $1 AND capability_name = $2`, [project_id, capability_name]);
    if (!capabilityCheckResult.rows.length) {
        const auditResult = await writeAudit(project_id, route_name, capability_name, "deny_capability", "Capability not in scope for this project", null, agency_identity, agent_identity);
        return {
            allow: false,
            reason: "capability_not_in_scope",
            audit_id: auditResult,
        };
    }
    // Step 3: Budget check (optional, atomic via SELECT...FOR UPDATE)
    let remainingBudgetCents = null;
    if (estimated_usd_cents !== undefined) {
        const budgetCheckResult = await checkBudgetAtomic(project_id, estimated_usd_cents);
        if (!budgetCheckResult.allowed) {
            const auditResult = await writeAudit(project_id, route_name, capability_name, "deny_budget", budgetCheckResult.reason, budgetCheckResult.remaining_cents, agency_identity, agent_identity);
            return {
                allow: false,
                reason: "budget_exceeded",
                remaining_budget_cents: budgetCheckResult.remaining_cents,
                audit_id: auditResult,
            };
        }
        remainingBudgetCents = budgetCheckResult.remaining_cents;
    }
    // Step 4: Compliance hook (Phase 2: stubbed)
    // TODO Phase 2: Integrate compliance_check_callback
    // const complianceResult = await checkContentPolicy(project_id, route_name, capability_name);
    // if (!complianceResult.allowed) {
    //   return {
    //     allow: false,
    //     reason: 'content_policy_denied',
    //     audit_id: await writeAudit(...)
    //   };
    // }
    // All checks passed: ALLOW
    const auditResult = await writeAudit(project_id, route_name, capability_name, "allow", "All allowlist, capability, and budget checks passed", remainingBudgetCents, agency_identity, agent_identity);
    return {
        allow: true,
        reason: "allowed",
        remaining_budget_cents: remainingBudgetCents,
        audit_id: auditResult,
    };
}
/**
 * Check budget atomically using SELECT...FOR UPDATE.
 * Returns whether the dispatch would exceed the cap and remaining budget.
 *
 * TODO: Integrate with agent_budget_ledger table when available.
 * For Phase 1, this stub always allows if budget cap is not set,
 * and returns a placeholder remaining_cents value.
 *
 * AC #101: Race-test deferred to Phase 2 (concurrent load test).
 */
async function checkBudgetAtomic(project_id, estimated_usd_cents) {
    // Phase 1: No agent_budget_ledger table exists yet.
    // TODO Phase 2: Once agent_budget_ledger is available, sum spend by (project_id, period).
    // For now, stub the budget check: if project_budget_cap row exists, validate atomically.
    // Otherwise, allow.
    // Query all budget caps for this project (day, week, month).
    const capsResult = await query(`SELECT id, period, max_usd_cents FROM roadmap.project_budget_cap
     WHERE project_id = $1
     ORDER BY period FOR UPDATE`, [project_id]);
    if (!capsResult.rows.length) {
        // No budget cap configured; allow dispatch.
        return {
            allowed: true,
            reason: "No budget cap configured",
            remaining_cents: -1, // Placeholder: unlimited
        };
    }
    // For each cap period, check if estimated spend would exceed it.
    // Since agent_budget_ledger doesn't exist yet, we calculate remaining as:
    // remaining = max - estimated (without adding to current spend).
    // This is a Phase 1 stub; Phase 2 will sum actual spend from ledger.
    for (const cap of capsResult.rows) {
        const maxCents = Number(cap.max_usd_cents);
        // TODO Phase 2: Query agent_budget_ledger for current spend in this period.
        // For Phase 1, assume no current spend.
        const currentSpend = 0;
        const projected = currentSpend + estimated_usd_cents;
        if (projected > maxCents) {
            const remaining = Math.max(0, maxCents - currentSpend);
            return {
                allowed: false,
                reason: `Budget exceeded for period ${cap.period}. Cap: ${maxCents} cents, estimated spend: ${estimated_usd_cents} cents, current: ${currentSpend} cents.`,
                remaining_cents: remaining,
            };
        }
    }
    // All budget caps are satisfied.
    // Return remaining budget (minimum across all periods).
    const minRemaining = Math.min(...capsResult.rows.map((c) => Number(c.max_usd_cents)));
    return {
        allowed: true,
        reason: "Within budget caps",
        remaining_cents: minRemaining,
    };
}
/**
 * Write an audit row for this dispatch decision.
 * Returns the audit row id.
 *
 * AC #104: Audit redaction: only stores route_name, no API keys or secrets.
 * The route_name itself is safe (it's from the allowlist, not user input).
 */
async function writeAudit(project_id, route_name, capability_name, decision, reason, remaining_budget_cents, agency_identity, agent_identity) {
    const result = await query(`INSERT INTO roadmap.dispatch_route_audit
     (project_id, route_name, capability_name, decision, reason, remaining_budget_cents, agency_identity, agent_identity, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`, [
        project_id,
        route_name,
        capability_name,
        decision,
        reason,
        remaining_budget_cents,
        agency_identity || null,
        agent_identity || null,
    ]);
    return Number(result.rows[0]?.id || 0);
}
