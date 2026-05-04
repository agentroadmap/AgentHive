/**
 * P749: Queue context resolver.
 *
 * Bridges a ProposalInQueueResult (from gate-scanner-v2) to a QueueContext
 * that includes the resolved workflow template id and role profiles.
 *
 * v_mature_queue does not carry workflow_template_id or project_id, so this
 * module does a lightweight enrichment query before handing off to the role
 * resolver.
 */

import { query } from "../../infra/postgres/pool.ts";
import type { ProposalInQueueResult } from "../proposal/gate-scanner-v2.ts";
import { getRolesForQueue } from "./role-resolver.ts";
import type { QueueKey, RoleProfile } from "./role-resolver.ts";

// Default template: Standard RFC (id 14). Used when a proposal has no
// associated workflow entry (pre-migration proposals or legacy records).
const DEFAULT_WORKFLOW_TEMPLATE_ID = 14;

export interface QueueContext {
	proposal: ProposalInQueueResult;
	workflowTemplateId: number;
	projectId: number | null;
	key: QueueKey;
	roleProfiles: RoleProfile[];
}

/**
 * Enrich a mature-queue proposal with its workflow template and role profiles.
 *
 * 1. Queries roadmap.workflows to resolve the workflow_template_id for this
 *    proposal (falls back to DEFAULT_WORKFLOW_TEMPLATE_ID = 14 if not found).
 * 2. Constructs the QueueKey and calls getRolesForQueue().
 * 3. Returns the full QueueContext for use by the readiness-resolver and
 *    scanQueues() dispatch loop.
 *
 * project_id is not currently stored in v_mature_queue or in a quickly
 * queryable place without additional joins; pass null so getRolesForQueue()
 * returns global-scope profiles only. A follow-up migration can add
 * project_id to v_mature_queue to enable project-scoped role overrides.
 */
export async function resolveQueueContext(
	proposal: ProposalInQueueResult,
): Promise<QueueContext> {
	let workflowTemplateId = DEFAULT_WORKFLOW_TEMPLATE_ID;

	try {
		const { rows } = await query<{ template_id: number }>(
			`SELECT w.template_id
			 FROM roadmap.workflows w
			 WHERE w.proposal_id = $1
			 LIMIT 1`,
			[proposal.id],
		);
		if (rows[0]?.template_id) {
			workflowTemplateId = Number(rows[0].template_id);
		}
	} catch (err) {
		console.warn(
			`[QueueContextResolver] workflow lookup failed for proposal ${proposal.id}, using default template ${DEFAULT_WORKFLOW_TEMPLATE_ID}:`,
			err instanceof Error ? err.message : err,
		);
	}

	const key: QueueKey = {
		workflowTemplateId,
		stage: proposal.status,
		maturity: proposal.maturity,
		projectId: null,
	};

	const roleProfiles = await getRolesForQueue(key);

	return {
		proposal,
		workflowTemplateId,
		projectId: null,
		key,
		roleProfiles,
	};
}
