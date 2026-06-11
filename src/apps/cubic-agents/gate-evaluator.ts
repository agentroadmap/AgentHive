/**
 * Gate Evaluator Agent — Automated Mature→Advance Transitions
 *
 * P206 AC-4: GateEvaluatorAgent class exists in src/apps/cubic-agents/gate-evaluator.ts
 * with evaluate(proposal, gate) method returning GateDecision.
 *
 * This agent:
 * 1. Checks if a proposal can be promoted (dependencies resolved)
 * 2. Verifies acceptance criteria if required
 * 3. Dispatches to evaluator based on gate mode (auto/ai-agent/quorum)
 * 4. Records decision in gate_decision_log
 * 5. Auto-transitions proposal on approval
 */

import type { query } from "../../infra/postgres/pool.ts";
import {
	createGateEvaluator,
	type GateDecision,
	type GateEvaluatorConfig,
	type GateBrief,
	type ProposalBrief,
} from "../../core/gate/evaluator.ts";
import { RfcStates } from "../../core/workflow/state-names.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GateTaskRequest {
	proposal_id: number;
	gate_name: string;
	from_state: string;
	to_state: string;
}

/**
 * P740 (HF-C): thrown when a gate decision was recorded but the resulting
 * proposal state mutation didn't actually persist. Caller should let it
 * bubble — surrounding job machinery marks the run as failed; circuit
 * breaker (P689) will pause gate scanning after N repeats.
 */
export class GatePersistenceFailure extends Error {
	readonly proposalId: number;
	readonly displayId: string;
	readonly kind: "status" | "maturity";
	readonly expected: string;
	readonly actual: string | null;
	readonly gateName: string;
	constructor(input: {
		proposalId: number;
		displayId: string;
		kind: "status" | "maturity";
		expected: string;
		actual: string | null;
		gateName: string;
	}) {
		super(
			`gate_persistence_failure: ${input.displayId} gate=${input.gateName} ` +
				`${input.kind} expected=${input.expected} actual=${input.actual ?? "<missing>"}`,
		);
		this.name = "GatePersistenceFailure";
		this.proposalId = input.proposalId;
		this.displayId = input.displayId;
		this.kind = input.kind;
		this.expected = input.expected;
		this.actual = input.actual;
		this.gateName = input.gateName;
	}
}

// ─── Gate Evaluator Agent ────────────────────────────────────────────────────

export class GateEvaluatorAgent {
	constructor(
		private queryFn: typeof query,
		private proposalId: number,
		private gateName: string,
		private transitionProposalFn?: (
			id: number,
			newStatus: string,
			authorIdentity?: string,
			changeSummary?: string,
		) => Promise<unknown>,
	) {}

	/**
	 * Main evaluation entrypoint.
	 * P206 AC-4: evaluate(proposal, gate) → GateDecision
	 */
	async evaluate(proposal: ProposalBrief, gate: GateBrief): Promise<GateDecision> {
		console.log(
			`[GateEvaluator] Evaluating ${proposal.display_id} for gate ${gate.name}`,
		);

		// Step 1: Check can_promote (unresolved dependencies)
		const canPromote = await this.checkCanPromote(proposal.id);
		if (!canPromote) {
			const decision: GateDecision = {
				verdict: "reject",
				reason: "Unresolved dependencies prevent promotion",
			};
			await this.recordGateDecision(proposal, gate, decision);
			return decision;
		}

		// Step 2: Verify acceptance criteria if gate requires them
		let acStatus: Awaited<ReturnType<typeof this.verifyAcceptanceCriteria>> | undefined;
		if (gate.requires_ac) {
			acStatus = await this.verifyAcceptanceCriteria(proposal.id);
			if (acStatus.failedCount > 0) {
				const decision: GateDecision = {
					verdict: "reject",
					reason: `Failed ACs: ${acStatus.failedCount}/${acStatus.totalCount}`,
					metadata: {
						pass_rate: acStatus.passRate,
						failed_count: acStatus.failedCount,
						total_count: acStatus.totalCount,
					},
				};
				await this.recordGateDecision(proposal, gate, decision);
				return decision;
			}
		}

		// Step 3: For gates that don't require ACs, auto-approve if deps resolved
		if (!gate.requires_ac) {
			const decision: GateDecision = {
				verdict: "approve",
				reason: "All dependencies resolved; no ACs required for this gate",
				metadata: { gate_requires_ac: false },
			};
			await this.recordGateDecision(proposal, gate, decision, acStatus);
			return decision;
		}

		// Step 4: Get gate evaluator mode and config for AC-required gates
		const evaluatorConfig = await this.getEvaluatorConfig(gate.name);
		if (!evaluatorConfig) {
			const decision: GateDecision = {
				verdict: "abstain",
				reason: `No evaluator configuration found for gate ${gate.name}`,
			};
			await this.recordGateDecision(proposal, gate, decision, acStatus);
			return decision;
		}

		// Step 5: Create evaluator and get decision
		const evaluator = createGateEvaluator(evaluatorConfig, {
			queryFn: this.queryFn,
			// TODO(P206): spawnAgentFn for ai-agent mode dispatches to cubic
			spawnAgentFn: undefined,
		});

		const decision = await evaluator.evaluate(proposal, gate);

		// Step 6: Record decision
		await this.recordGateDecision(proposal, gate, decision, acStatus);

		// Step 7: Apply verdict (transition + persistence verification +
		// maturity demotion). P740 (HF-C): previously this only handled
		// `approve`; `hold`/`reject` left maturity='mature' and re-fired
		// fn_notify_gate_ready forever.
		await this.applyVerdict(proposal, gate, decision);

		return decision;
	}

	/**
	 * P740 (HF-C): apply the verdict and verify the side-effects actually
	 * persisted. Without this, a hold/reject decision was logged to
	 * gate_decision_log but the proposal stayed maturity='mature', so the
	 * gate-ready notification kept firing on every tick — the silent loop
	 * we observed with P435 (60+ reclaims) and others.
	 */
	private async applyVerdict(
		proposal: ProposalBrief,
		gate: GateBrief,
		decision: GateDecision,
	): Promise<void> {
		// Closure verdicts that set maturity=obsolete
		const closureVerdicts = new Set([
			"wontfix",
			"discard",
			"replace",
			"escalate",
			"nonissue",
		]);
		const isClosureVerdict = closureVerdicts.has(decision.verdict);

		switch (decision.verdict) {
			case "approve": {
				try {
					const transitionFn =
						this.transitionProposalFn || (await this.getDefaultTransitionFn());
					await transitionFn(
						proposal.id,
						gate.to_state,
						"gate-evaluator",
						`Auto-advanced via gate ${gate.name}`,
					);
				} catch (err) {
					console.error(
						`[GateEvaluator] ✗ Failed to transition proposal:`,
						err,
					);
					throw err;
				}
				await this.assertStatusAdvanced(
					proposal.id,
					proposal.display_id ?? `#${proposal.id}`,
					gate.to_state,
					gate.name,
				);
				console.log(
					`[GateEvaluator] ✓ Transitioned ${proposal.display_id} to ${gate.to_state}`,
				);
				return;
			}
			case "hold":
			case "reject": {
				const targetMaturity =
					decision.verdict === "reject" ? "obsolete" : "active";
				try {
					await this.setMaturity(
						proposal.id,
						targetMaturity,
						`Gate ${gate.name} ${decision.verdict}: ${decision.reason ?? "no reason given"}`,
					);
				} catch (err) {
					console.error(
						`[GateEvaluator] ✗ Failed to set maturity for ${decision.verdict}:`,
						err,
					);
					throw err;
				}
				await this.assertMaturityDemoted(
					proposal.id,
					proposal.display_id ?? `#${proposal.id}`,
					targetMaturity,
					gate.name,
				);
				console.log(
					`[GateEvaluator] ✓ Demoted ${proposal.display_id} maturity to ${targetMaturity} after ${decision.verdict}`,
				);
				return;
			}
			case "wontfix":
			case "discard":
			case "replace":
			case "escalate":
			case "nonissue": {
				// Closure verdicts: set maturity=obsolete, store obsoleted_reason, do NOT change status
				const obsoletedReason = `${decision.verdict}: ${decision.reason ?? "no reason given"}`;
				try {
					await this.setMaturityObsolete(
						proposal.id,
						obsoletedReason,
					);
				} catch (err) {
					console.error(
						`[GateEvaluator] ✗ Failed to set maturity for closure verdict ${decision.verdict}:`,
						err,
					);
					throw err;
				}
				await this.assertMaturityDemoted(
					proposal.id,
					proposal.display_id ?? `#${proposal.id}`,
					"obsolete",
					gate.name,
				);
				console.log(
					`[GateEvaluator] ✓ Closure verdict ${decision.verdict} applied to ${proposal.display_id}: maturity=obsolete, status unchanged`,
				);
				return;
			}
			default:
				// 'pending', 'abstain', or future verdicts: do not mutate state.
				return;
		}
	}

	/**
	 * Re-read proposal.status and throw if it didn't advance to the gate's
	 * to_state. This catches silent failures: workflow_name lookup miss,
	 * lease conflicts, FK rejects — anywhere the SQL update returns success
	 * but the row state doesn't reflect the intended change.
	 */
	private async assertStatusAdvanced(
		proposalId: number,
		displayId: string,
		expectedState: string,
		gateName: string,
	): Promise<void> {
		const result = await this.queryFn(
			`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
			[proposalId],
		);
		const actual = (result.rows[0] as { status?: string } | undefined)?.status;
		if (
			!actual ||
			actual.toUpperCase() !== expectedState.toUpperCase()
		) {
			const msg = `[GateEvaluator] gate_persistence_failure: ${displayId} gate=${gateName} expected status=${expectedState} actual=${actual ?? "<missing>"}`;
			console.error(msg);
			throw new GatePersistenceFailure({
				proposalId,
				displayId,
				kind: "status",
				expected: expectedState,
				actual: actual ?? null,
				gateName,
			});
		}
	}

	/**
	 * Re-read proposal.maturity and throw if it's still 'mature' after a
	 * non-approve verdict was supposed to demote it. Stops the gate-ready
	 * loop in the case where the setMaturity SQL silently failed.
	 */
	private async assertMaturityDemoted(
		proposalId: number,
		displayId: string,
		expectedMaturity: string,
		gateName: string,
	): Promise<void> {
		const result = await this.queryFn(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[proposalId],
		);
		const actual = (result.rows[0] as { maturity?: string } | undefined)
			?.maturity;
		if (!actual || actual === "mature") {
			const msg = `[GateEvaluator] gate_persistence_failure: ${displayId} gate=${gateName} expected maturity=${expectedMaturity} actual=${actual ?? "<missing>"} (still mature → loop risk)`;
			console.error(msg);
			throw new GatePersistenceFailure({
				proposalId,
				displayId,
				kind: "maturity",
				expected: expectedMaturity,
				actual: actual ?? null,
				gateName,
			});
		}
	}

	/**
	 * Update proposal.maturity directly. The full prop_set_maturity tool
	 * goes through the MCP layer; here we hit the table directly because
	 * we're already inside the gate-evaluator's authoritative pipeline.
	 */
	private async setMaturity(
		proposalId: number,
		maturity: string,
		note: string,
	): Promise<void> {
		await this.queryFn(
			`WITH _actor AS (
				 SELECT set_config('app.agent_identity', $1, true) AS agent_identity
			 )
			 UPDATE roadmap_proposal.proposal
			    SET maturity = $2, modified_at = NOW()
			   FROM _actor
			  WHERE id = $3`,
			["gate-evaluator", maturity, proposalId],
		);
		// Best-effort discussion entry; do not throw if discussion table
		// is unavailable (e.g. test fixture).
		try {
			await this.queryFn(
				`INSERT INTO roadmap_proposal.proposal_discussions
				   (proposal_id, author, context_prefix, content)
				 VALUES ($1, 'gate-evaluator', 'general:', $2)`,
				[proposalId, `Maturity demoted to ${maturity}: ${note}`],
			);
		} catch {
			// non-fatal
		}
	}

	/**
	 * P778: Update proposal to maturity=obsolete with obsoleted_reason.
	 * Closure verdicts (reject, wontfix, discard, replace, escalate, nonissue)
	 * do NOT change proposal.status; they only set maturity and obsoleted_reason.
	 */
	private async setMaturityObsolete(
		proposalId: number,
		obsoletedReason: string,
	): Promise<void> {
		await this.queryFn(
			`WITH _actor AS (
				 SELECT set_config('app.agent_identity', $1, true) AS agent_identity
			 )
			 UPDATE roadmap_proposal.proposal
			    SET maturity = 'obsolete',
			        obsoleted_reason = $2,
			        modified_at = NOW()
			   FROM _actor
			  WHERE id = $3`,
			["gate-evaluator", obsoletedReason, proposalId],
		);
		// Best-effort discussion entry; do not throw if discussion table
		// is unavailable (e.g. test fixture).
		try {
			await this.queryFn(
				`INSERT INTO roadmap_proposal.proposal_discussions
				   (proposal_id, author, context_prefix, content)
				 VALUES ($1, 'gate-evaluator', 'general:', $2)`,
				[proposalId, `Closure verdict applied: ${obsoletedReason}`],
			);
		} catch {
			// non-fatal
		}
	}

	/**
	 * P206 AC-6: Gate evaluator checks can_promote() before evaluating
	 */
	private async checkCanPromote(proposalId: number): Promise<boolean> {
		const { rows } = await this.queryFn<{ count: string }>(
			`SELECT COUNT(*) as count
			 FROM roadmap_proposal.proposal_dependencies
			 WHERE from_proposal_id = $1 AND resolved = false`,
			[proposalId],
		);

		const unresolvedCount = Number(rows[0]?.count ?? 0);
		return unresolvedCount === 0;
	}

	/**
	 * Verify acceptance criteria status for a proposal
	 */
	private async verifyAcceptanceCriteria(
		proposalId: number,
	): Promise<{
		totalCount: number;
		passedCount: number;
		failedCount: number;
		passRate: number;
	}> {
		const { rows } = await this.queryFn<{
			total: string;
			passed: string;
			failed: string;
		}>(
			`SELECT COUNT(*) as total,
			        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
			        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failed
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1`,
			[proposalId],
		);

		const totalCount = Number(rows[0]?.total ?? 0);
		const passedCount = Number(rows[0]?.passed ?? 0);
		const failedCount = Number(rows[0]?.failed ?? 0);
		const passRate = totalCount > 0 ? (passedCount / totalCount) * 100 : 0;

		return { totalCount, passedCount, failedCount, passRate };
	}

	/**
	 * Get evaluator configuration for a gate
	 * For now, uses hardcoded modes. TODO(P206): Load from gate_task_template
	 *
	 * Note: Gates that don't require ACs still use 'auto' mode but with
	 * ac_pass_threshold=0, which means they only check dependencies.
	 */
	private async getEvaluatorConfig(
		gateName: string,
	): Promise<GateEvaluatorConfig | null> {
		// TODO(P206): Query gate_task_template table once it's populated
		// For MVP, use hardcoded defaults based on gate name
		const configs: Record<string, GateEvaluatorConfig> = {
			D1: {
				mode: "auto",
				ac_pass_threshold: 0, // Draft→Review: only dependency check, no AC required
				allow_unresolved_deps: false,
			},
			D2: {
				mode: "auto",
				ac_pass_threshold: 100, // Review→Develop: requires 100% AC pass
				allow_unresolved_deps: false,
			},
			D3: {
				mode: "auto",
				ac_pass_threshold: 100, // Develop→Merge: requires 100% AC pass
				allow_unresolved_deps: false,
			},
			D4: {
				mode: "auto",
				ac_pass_threshold: 0, // Merge→Complete: only dependency check, no AC required
				allow_unresolved_deps: false,
			},
		};

		return configs[gateName] ?? null;
	}

	/**
	 * Get default transition function from actual storage module
	 */
	private async getDefaultTransitionFn(): Promise<typeof import("../../infra/postgres/proposal-storage-v2.ts").transitionProposal> {
		const { transitionProposal } = await import("../../infra/postgres/proposal-storage-v2.ts");
		return transitionProposal;
	}

	/**
	 * Record gate decision in gate_decision_log.
	 *
	 * Operational contract: on `reject` and `pending` verdicts, the rationale
	 * and `ac_verification.details` payload are the canonical channel back to
	 * the enhancing agent. MCP discussions/messages are best-effort and may
	 * never reach the downstream cubic — so any failure list, remediation
	 * instructions, evidence pointers, and explicit next-step hints MUST live
	 * here. The next enhancing agent reads `gate_decision_log` to decide what
	 * to revise; if details are missing, the loop stalls.
	 *
	 * P206 AC-2 & AC-5: Records verdict='approve'/'reject' with metadata.
	 */
	private async recordGateDecision(
		proposal: ProposalBrief,
		gate: GateBrief,
		decision: GateDecision,
		acStatus?: {
			totalCount: number;
			passedCount: number;
			failedCount: number;
			passRate: number;
		},
	): Promise<void> {
		try {
			// P206 AC-5: ac_pass_rate field
			const acPassRate = acStatus
				? acStatus.passRate
				: null;

			const rationaleText = renderRationale(decision);

			await this.queryFn(
				`INSERT INTO roadmap_proposal.gate_decision_log
				 (proposal_id, from_state, to_state, maturity, gate, decided_by,
				  authority_agent, decision, rationale, ac_verification)
				 VALUES ($1, $2, $3, 'mature', $4, 'system', 'gate-evaluator',
				 $5, $6, $7)`,
				[
					proposal.id,
					gate.from_state,
					gate.to_state,
					gate.name,
					decision.verdict,
					rationaleText,
					JSON.stringify({
						pass_rate: acPassRate,
						...(decision.metadata ?? {}),
						// Full machine-readable structure. The enhancing agent
						// reads `details` from here to plan its next revision.
						details: decision.details ?? null,
					}),
				],
			);

			// Operational guard: non-approve verdicts without details strand
			// the enhancing agent. Log loudly so the gap is visible.
			if (decision.verdict !== "approve" && !decision.details) {
				console.warn(
					`[GateEvaluator] ⚠ ${decision.verdict} on ${proposal.display_id} ` +
					`without structured details — enhancing agent will only see the ` +
					`one-line reason. Populate decision.details for actionable rejections.`,
				);
			}

			console.log(
				`[GateEvaluator] Recorded decision: ${decision.verdict} for ${proposal.display_id}`,
			);
		} catch (err) {
			console.error(`[GateEvaluator] Failed to record gate decision:`, err);
			throw err;
		}
	}
}

/**
 * Render a GateDecision into a multi-section rationale string. The enhancing
 * agent reads this via MCP/proposal browser when it doesn't parse the JSONB.
 * Keep the format stable and grep-friendly — downstream tooling looks for the
 * `## Failures`, `## Remediation`, `## Next step` headings.
 */
function renderRationale(decision: GateDecision): string {
	const head = decision.reason || `Gate ${decision.verdict}`;
	const d = decision.details;
	if (!d) return head;

	const parts: string[] = [head];

	if (d.failures && d.failures.length > 0) {
		parts.push("\n## Failures");
		for (const f of d.failures) {
			const code = f.code ? `[${f.code}] ` : "";
			const ev = f.evidence ? ` — evidence: ${f.evidence}` : "";
			parts.push(`- (${f.severity}) ${code}${f.summary}${ev}`);
		}
	}

	if (d.remediation && d.remediation.length > 0) {
		parts.push("\n## Remediation");
		for (const r of d.remediation) {
			const refs = r.applies_to_failure_codes?.length
				? ` (fixes: ${r.applies_to_failure_codes.join(", ")})`
				: "";
			parts.push(`- ${r.action}${refs}`);
		}
	}

	if (d.reviewer_breakdown && d.reviewer_breakdown.length > 0) {
		parts.push("\n## Reviewer breakdown");
		for (const r of d.reviewer_breakdown) {
			parts.push(`- ${r.reviewer_role}: ${r.verdict.toUpperCase()} — ${r.headline}`);
		}
	}

	if (d.evidence_uri) {
		parts.push(`\n## Evidence\n${d.evidence_uri}`);
	}

	if (d.next_step) {
		parts.push(`\n## Next step\n${d.next_step}`);
	}

	return parts.join("\n");
}

/**
 * Factory function to create and run gate evaluator
 * Used by orchestrator or standalone execution
 */
export async function runGateEvaluation(
	request: GateTaskRequest,
	queryFn: typeof query,
): Promise<GateDecision> {
	// Fetch proposal details
	const { rows: proposals } = await queryFn<{
		id: number;
		display_id: string;
		title: string;
		status: string;
		workflow_name: string;
	}>(
		`SELECT id, display_id, title, status,
		        (SELECT workflow_name FROM roadmap_proposal.proposal_type_config
		         WHERE type = p.type LIMIT 1) as workflow_name
		 FROM roadmap_proposal.proposal p
		 WHERE id = $1`,
		[request.proposal_id],
	);

	if (!proposals[0]) {
		throw new Error(`Proposal ${request.proposal_id} not found`);
	}

	const proposal = proposals[0];

	// Construct gate brief
	const gate: GateBrief = {
		name: request.gate_name,
		from_state: request.from_state,
		to_state: request.to_state,
		requires_ac:
			request.from_state !== RfcStates.DRAFT && request.from_state !== RfcStates.MERGE,
	};

	const proposalBrief: ProposalBrief = {
		id: proposal.id,
		display_id: proposal.display_id,
		title: proposal.title,
		status: proposal.status,
		workflow_name: proposal.workflow_name,
	};

	const agent = new GateEvaluatorAgent(
		queryFn,
		request.proposal_id,
		request.gate_name,
	);

	return await agent.evaluate(proposalBrief, gate);
}
