/**
 * P1124: D4 Merge-Gate Validator MCP Tool
 *
 * Operator-triggered path for manual AC validation invocation.
 * Action: d4_validate
 * Args: { proposal_id: number, correlation_id?: string, force_re_run?: boolean }
 */

import { validateProposal } from "../../../../core/orchestration/d4-validator.ts";

export interface D4ValidateRequest {
	proposal_id: number;
	correlation_id?: string;
	force_re_run?: boolean;
}

export interface D4ValidateResponse {
	decision: string;
	ac_verification: Array<{
		ac_number: number;
		command: string;
		command_type: string;
		status: string;
		output?: string;
		error?: string;
		duration_ms: number;
	}>;
	challenges: number[];
	blockers: number[];
	log_id?: number | null;
	rationale: string;
}

export async function d4Validate(req: D4ValidateRequest): Promise<D4ValidateResponse> {
	const result = await validateProposal(req.proposal_id, req.correlation_id, req.force_re_run);

	return {
		decision: result.decision,
		ac_verification: result.ac_verification,
		challenges: result.challenges,
		blockers: result.blockers,
		log_id: result.log_id,
		rationale: result.rationale,
	};
}
