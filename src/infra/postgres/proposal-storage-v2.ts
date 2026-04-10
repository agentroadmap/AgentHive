/**
 * Postgres proposal storage adapter for AgentHive — v2 schema.
 *
 * Targets the active schema selected by the connection pool search_path.
 */
import { getPool, query } from "./pool.ts";

const PROPOSAL_COLUMNS = `
  id, display_id, parent_id, type, status, maturity_state, title,
  summary, motivation, design, drawbacks, alternatives,
  dependency, priority, tags, audit, created_at, modified_at
`;

export type ProposalRow = {
	id: number;
	display_id: string;
	parent_id: number | null;
	type: string;
	status: string;
	maturity_state: 'new' | 'active' | 'mature' | 'obsolete';
	title: string;
	summary: string | null;
	motivation: string | null;
	design: string | null;
	drawbacks: string | null;
	alternatives: string | null;
	dependency: string | null;
	priority: string | null; // descriptive; queue order from v_proposal_queue
	tags: any | null; // jsonb
	audit: any[]; // jsonb: [{ TS, Agent, Activity, Reason }]
	created_at: Date;
	modified_at: Date;
};

export type ProposalCreateInput = {
	display_id?: string | null;
	type: string;
	status?: string | null;
	title: string;
	parent_id?: number | null;
	summary?: string | null;
	motivation?: string | null;
	design?: string | null;
	drawbacks?: string | null;
	alternatives?: string | null;
	dependency?: string | null;
	priority?: string | null;
	tags?: any | null;
};

export type ProposalSummary = Pick<
	ProposalRow,
	| "id"
	| "display_id"
	| "type"
	| "title"
	| "status"
	| "priority"
	| "maturity_state"
	| "tags"
	| "audit"
	| "created_at"
> & {
	workflow_name: string | null;
	current_stage: string | null;
	leased_by: string | null;
	leased_at: Date | null;
	lease_expires: Date | null;
	latest_decision: string | null;
	decision_at: Date | null;
};

export type QueueItem = {
	id: number;
	display_id: string;
	type: string;
	title: string;
	status: string;
	maturity: Record<string, string>;
	blocks_count: number;
	depends_on_count: number;
	tags: any | null;
	created_at: Date;
	queue_position: number;
};

export type ProposalDependency = {
	from_proposal_id: number;
	from_display_id: string;
	to_proposal_id: number;
	to_display_id: string;
	dependency_type: string;
	resolved: boolean;
};

export type ProposalAcceptanceCriterionRow = {
	item_number: number;
	criterion_text: string;
	status: "pending" | "pass" | "fail" | "blocked" | "waived";
	verified_by: string | null;
	verification_notes: string | null;
	verified_at: Date | null;
};

export type ProposalTypeConfigRow = {
	type: string;
	workflow_name: string;
	description: string | null;
};

/**
 * List proposals with optional filters.
 * Uses roadmap.proposal v2 table.
 */
export async function listProposals(filters?: {
	status?: string;
	type?: string;
	maturity_stage?: string;
}): Promise<ProposalRow[]> {
	const clauses: string[] = [];
	const params: any[] = [];
	let idx = 1;

	if (filters?.status) {
		clauses.push(`status = $${idx++}`);
		params.push(filters.status);
	}
	if (filters?.type) {
		clauses.push(`type = $${idx++}`);
		params.push(filters.type);
	}

	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const { rows } = await query<ProposalRow>(
		`SELECT ${PROPOSAL_COLUMNS}
     FROM proposal
     ${where}
     ORDER BY id ASC`,
		params,
	);
	return rows;
}

/**
 * Get a single proposal by ID or display_id (P001, P042, etc).
 */
export async function getProposal(
	identifier: string | number,
): Promise<ProposalRow | null> {
	const numId =
		typeof identifier === "number" ? identifier : parseInt(identifier, 10);
	if (!Number.isNaN(numId) && numId > 0) {
		const { rows } = await query<ProposalRow>(
			`SELECT ${PROPOSAL_COLUMNS}
       FROM proposal WHERE id = $1 LIMIT 1`,
			[numId],
		);
		if (rows[0]) return rows[0];
	}
	const { rows } = await query<ProposalRow>(
		`SELECT ${PROPOSAL_COLUMNS}
     FROM proposal WHERE display_id = $1 LIMIT 1`,
		[String(identifier)],
	);
	return rows[0] ?? null;
}

export async function resolveProposalId(
	identifier: string | number,
): Promise<number | null> {
	const proposal = await getProposal(identifier);
	return proposal?.id ?? null;
}

/**
 * Get proposal summary with live workflow stage, lease, and latest decision.
 * Uses v_proposal_summary view.
 */
export async function getProposalSummary(
	identifier: string | number,
): Promise<ProposalSummary | null> {
	const numericId =
		typeof identifier === "number"
			? identifier
			: Number.parseInt(identifier, 10);
	const { rows } = await query<ProposalSummary>(
		`SELECT *
     FROM v_proposal_summary
     WHERE display_id = $1 OR id = $2
     LIMIT 1`,
		[String(identifier), Number.isNaN(numericId) ? null : numericId],
	);
	return rows[0] ?? null;
}

export async function listProposalSummaries(filters?: {
	status?: string;
	type?: string;
}): Promise<ProposalSummary[]> {
	const clauses: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (filters?.status) {
		clauses.push(`status = $${idx++}`);
		params.push(filters.status);
	}
	if (filters?.type) {
		clauses.push(`type = $${idx++}`);
		params.push(filters.type);
	}

	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const { rows } = await query<ProposalSummary>(
		`SELECT *
     FROM roadmap.v_proposal_summary
     ${where}
     ORDER BY id ASC`,
		params,
	);
	return rows;
}

/**
 * Create a new proposal.
 * Workflow instance is auto-spawned by trg_spawn_workflow trigger.
 * display_id is auto-generated by trg_proposal_display_id trigger.
 */
export async function createProposal(
	input: ProposalCreateInput,
	authorIdentity: string,
): Promise<ProposalRow> {
	// Resolve the workflow's start_stage for this proposal type so the initial
	// status matches the workflow (e.g. Quick Fix starts at TRIAGE, not Draft).
	// Falls back to "Draft" if no workflow is configured for this type.
	let initialStatus = input.status ?? "Draft";
	if (!input.status) {
		const { rows: wfRows } = await query<{ start_stage: string | null }>(
			`SELECT ws.stage_name AS start_stage
       FROM roadmap.proposal_type_config ptc
       JOIN roadmap.workflow_templates wt ON wt.name = ptc.workflow_name
       JOIN roadmap.workflow_stages ws ON ws.template_id = wt.id
       WHERE ptc.type = $1
       ORDER BY ws.stage_order ASC
       LIMIT 1`,
			[input.type],
		);
		if (wfRows[0]?.start_stage) {
			initialStatus = wfRows[0].start_stage;
		}
	}

	const { rows } = await query<ProposalRow>(
		`INSERT INTO proposal (
      display_id, type, status, title, parent_id, summary, motivation, design,
      drawbacks, alternatives, dependency, priority, tags, audit
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
    RETURNING ${PROPOSAL_COLUMNS}`,
		[
			input.display_id ?? null,
			input.type,
			initialStatus,
			input.title,
			input.parent_id ?? null,
			input.summary ?? null,
			input.motivation ?? null,
			input.design ?? null,
			input.drawbacks ?? null,
			input.alternatives ?? null,
			input.dependency ?? null,
			input.priority ?? null,
			input.tags ? JSON.stringify(input.tags) : null,
			JSON.stringify([
				{
					TS: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
					Agent: authorIdentity,
					Activity: "Created",
				},
			]),
		],
	);
	return rows[0];
}

export async function listProposalTypes(): Promise<ProposalTypeConfigRow[]> {
	const { rows } = await query<ProposalTypeConfigRow>(
		`SELECT type, workflow_name, description
     FROM roadmap.proposal_type_config
     ORDER BY type ASC`,
	);
	return rows;
}

/**
 * Update proposal fields (non-status).
 */
export async function updateProposal(
	id: number,
	updates: Partial<Omit<ProposalCreateInput, "status">>,
): Promise<ProposalRow | null> {
	const setClauses: string[] = [];
	const params: any[] = [];
	let idx = 1;

	const jsonbFields = ["tags"] as const;

	for (const [key, value] of Object.entries(updates)) {
		if (value !== undefined) {
			if (jsonbFields.includes(key as any)) {
				setClauses.push(`${key} = $${idx}::jsonb`);
				params.push(value === null ? null : JSON.stringify(value));
			} else {
				setClauses.push(`${key} = $${idx}`);
				params.push(value);
			}
			idx++;
		}
	}

	if (setClauses.length === 0) return null;
	setClauses.push(`modified_at = NOW()`);
	params.push(id);

	const { rows } = await query<ProposalRow>(
		`UPDATE proposal SET ${setClauses.join(", ")}
     WHERE id = $${idx}
     RETURNING ${PROPOSAL_COLUMNS}`,
		params,
	);
	return rows[0] ?? null;
}

/**
 * Transition proposal status.
 * v2 validates transitions against proposal_valid_transitions at the
 * application layer. The DB trigger (fn_log_proposal_state_change)
 * automatically:
 * 1. Appends to proposal.audit jsonb
 * 2. Inserts into proposal_state_transitions
 * 3. Inserts into proposal_event (outbox)
 *
 * caller should validate the transition is allowed before calling.
 */
// Gate transitions that require a recorded decision when reason = 'decision'.
const GATE_TRANSITIONS = new Set([
	"DRAFT→REVIEW",
	"REVIEW→DEVELOP",
	"DEVELOP→MERGE",
	"MERGE→COMPLETE",
]);

export async function transitionProposal(
	proposalId: number,
	toState: string,
	transitionedBy: string,
	reason?: string,
	notes?: string,
): Promise<ProposalRow | null> {
	// Get current status
	const current = await query<{ status: string }>(
		`SELECT status FROM proposal WHERE id = $1 LIMIT 1`,
		[proposalId],
	);
	if (current.rows.length === 0) return null;
	const fromState = current.rows[0].status;

	// Gate guard: decision transitions require an explicit notes record
	const gateKey = `${fromState.toUpperCase()}→${toState.toUpperCase()}`;
	if (GATE_TRANSITIONS.has(gateKey) && reason === "decision") {
		if (!notes?.trim()) {
			throw new Error(
				`Gate transition ${gateKey} requires a decision record in 'notes' — ` +
				`record what was decided and why (required for D* auditability)`,
			);
		}
		if (!transitionedBy?.trim()) {
			throw new Error(
				`Gate transition ${gateKey} requires 'transitionedBy' — ` +
				`record which agent or human made the gating decision`,
			);
		}
	}

	// Validate transition exists
	const { rowCount } = await query(
		`SELECT 1
     FROM proposal_valid_transitions pvt
     JOIN workflows w ON w.proposal_id = $1
     JOIN workflow_templates wt ON wt.id = w.template_id
     JOIN proposal_type_config ptc ON ptc.workflow_name = wt.name
     WHERE pvt.workflow_name = ptc.workflow_name
       AND LOWER(pvt.from_state) = LOWER($2)
       AND LOWER(pvt.to_state) = LOWER($3)
     LIMIT 1`,
		[proposalId, fromState, toState],
	);

	if (rowCount === 0) {
		throw new Error(
			`Transition ${fromState} → ${toState} not allowed for this proposal's workflow`,
		);
	}

	// Ensure the author exists in agent_registry so the FK on
	// proposal_state_transitions.transitioned_by doesn't reject the trigger insert.
	await query(
		`INSERT INTO agent_registry (agent_identity, agent_type, status)
     VALUES ($1, 'llm', 'active')
     ON CONFLICT (agent_identity) DO NOTHING`,
		[transitionedBy],
	);

	// DB trigger will handle state_transitions + outbox + audit
	const { rows } = await query<ProposalRow>(
		`WITH _actor AS (
       SELECT set_config('app.agent_identity', $1, true) AS agent_identity
     )
     UPDATE proposal
     SET status = $2, modified_at = NOW()
     FROM _actor
     WHERE id = $3
     RETURNING ${PROPOSAL_COLUMNS}`,
		[transitionedBy, toState, proposalId],
	);

	if (!rows[0]) {
		return null;
	}

	await query(
		`UPDATE workflows
     SET current_stage = $1
     WHERE proposal_id = $2`,
		[toState, proposalId],
	);

	// Backfill the trigger's minimal entry with full metadata
	await query(
		`UPDATE proposal_state_transitions
     SET transition_reason = $1,
         transitioned_by   = $2,
         notes             = COALESCE($3, notes)
     WHERE id = (
       SELECT id
       FROM proposal_state_transitions
       WHERE proposal_id = $4 AND LOWER(to_state) = LOWER($5)
       ORDER BY id DESC
       LIMIT 1
     )`,
		[reason ?? "submit", transitionedBy, notes ?? null, proposalId, toState],
	);

	return rows[0];
}

/**
 * Get valid transitions for a proposal.
 */
export async function getValidTransitions(proposalId: number): Promise<
	{
		from_state: string;
		to_state: string;
		labels?: string[];
		allowed_roles?: string[];
	}[]
> {
	const { rows } = await query(
		`SELECT pvt.from_state, pvt.to_state, pvt.allowed_reasons AS labels, pvt.allowed_roles
     FROM proposal_valid_transitions pvt
     JOIN workflows w ON w.proposal_id = $1
     JOIN workflow_templates wt ON wt.id = w.template_id
     JOIN proposal_type_config ptc ON ptc.workflow_name = wt.name
     WHERE pvt.workflow_name = ptc.workflow_name`,
		[proposalId],
	);
	return rows;
}

/**
 * Set maturity_state on a proposal.
 *
 * This is the canonical way for agents to declare readiness within a state:
 *   new → active → mature → obsolete
 *
 * When maturity_state reaches 'mature', the DB trigger fn_notify_gate_ready fires
 * pg_notify('proposal_gate_ready', ...) to queue a D* gating review.
 */
export async function setMaturity(
	proposalId: number,
	maturityState: "new" | "active" | "mature" | "obsolete",
	agentIdentity: string,
	reason?: string,
): Promise<ProposalRow | null> {
	const valid = new Set(["new", "active", "mature", "obsolete"]);
	if (!valid.has(maturityState)) {
		throw new Error(
			`Invalid maturity_state '${maturityState}'. Must be one of: new, active, mature, obsolete`,
		);
	}

	const { rows } = await query<ProposalRow>(
		`WITH _actor AS (
       SELECT set_config('app.agent_identity', $1, true) AS agent_identity
     )
     UPDATE proposal
     SET maturity_state = $2,
         modified_at    = NOW()
     FROM _actor
     WHERE id = $3
     RETURNING ${PROPOSAL_COLUMNS}`,
		[agentIdentity, maturityState, proposalId],
	);

	if (!rows[0]) return null;

	await query(
		`UPDATE proposal
     SET audit = audit || $1::jsonb
     WHERE id = $2`,
		[
			JSON.stringify({
				TS: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
				Agent: agentIdentity,
				Activity: "MaturityChange",
				To: maturityState,
			}),
			proposalId,
		],
	);

	// Record an audit note when self-declaring mature (the gate-ready event)
	if (maturityState === "mature") {
		await query(
			`INSERT INTO proposal_discussions
         (proposal_id, author_identity, context_prefix, body)
       VALUES ($1, $2, 'general:', $3)`,
			[
				proposalId,
				agentIdentity,
				reason
					? `Declared mature: ${reason}`
					: `Agent self-declared proposal ready for gate review (maturity → mature)`,
			],
		);
	}

	return rows[0];
}

/**
 * Claim a proposal (acquire lease).
 * Only one active lease per proposal (enforced by DB constraint).
 * Trigger fn_event_lease_change writes proposal_event outbox row.
 */
export async function claimLease(
	proposalId: number,
	agentIdentity: string,
	expiresAt?: Date,
): Promise<boolean> {
	try {
		await query(
			`INSERT INTO proposal_lease (proposal_id, agent_identity, expires_at)
       VALUES ($1, $2, $3)`,
			[proposalId, agentIdentity, expiresAt ?? null],
		);
		return true;
	} catch {
		return false; // Already leased
	}
}

/**
 * Release a lease.
 */
export async function releaseLease(
	proposalId: number,
	agentIdentity: string,
	reason?: string,
): Promise<boolean> {
	const { rowCount } = await query(
		`UPDATE proposal_lease
     SET released_at = now(), release_reason = $1
     WHERE proposal_id = $2
       AND agent_identity = $3
       AND released_at IS NULL`,
		[reason ?? "completed", proposalId, agentIdentity],
	);
	return (rowCount ?? 0) > 0;
}

export async function renewLease(
	proposalId: number,
	agentIdentity: string,
	expiresAt?: Date,
): Promise<boolean> {
	const { rowCount } = await query(
		`UPDATE roadmap.proposal_lease
     SET expires_at = $1
     WHERE proposal_id = $2
       AND agent_identity = $3
       AND released_at IS NULL`,
		[expiresAt ?? null, proposalId, agentIdentity],
	);
	return (rowCount ?? 0) > 0;
}

/**
 * Get active leases.
 */
export async function getActiveLeases(proposalId?: number) {
	if (proposalId !== undefined) {
		const { rows } = await query(
			`SELECT pl.id, p.display_id, p.type, p.status,
              pl.agent_identity, pl.claimed_at, pl.expires_at,
              CASE
                WHEN pl.expires_at IS NULL THEN 'open'
                WHEN pl.expires_at > now() THEN 'active'
                ELSE 'expired'
               END AS lease_status
       FROM roadmap.proposal_lease pl
       JOIN roadmap.proposal p ON p.id = pl.proposal_id
       WHERE pl.released_at IS NULL AND pl.proposal_id = $1`,
			[proposalId],
		);
		return rows;
	}
	const { rows } = await query(`SELECT * FROM roadmap.v_active_leases`);
	return rows;
}

/**
 * Get proposal queue (DAG-based priority).
 * Uses v_proposal_queue view.
 */
export async function getProposalQueue(): Promise<QueueItem[]> {
	const { rows } = await query<QueueItem>(
		`SELECT id, display_id, type, title, status, maturity,
            blocks_count, depends_on_count, tags, created_at, queue_position
     FROM roadmap.v_proposal_queue
     ORDER BY queue_position ASC`,
	);
	return rows;
}

export async function listDependencies(
	proposalIds?: number[],
): Promise<ProposalDependency[]> {
	const params: unknown[] = [];
	let where = "WHERE d.resolved = false";
	if (proposalIds && proposalIds.length > 0) {
		params.push(proposalIds);
		where += " AND d.from_proposal_id = ANY($1::bigint[])";
	}

	const { rows } = await query<ProposalDependency>(
		`SELECT
       d.from_proposal_id,
       pf.display_id AS from_display_id,
       d.to_proposal_id,
       pt.display_id AS to_display_id,
       d.dependency_type,
       d.resolved
     FROM roadmap.proposal_dependencies d
     JOIN roadmap.proposal pf ON pf.id = d.from_proposal_id
     JOIN roadmap.proposal pt ON pt.id = d.to_proposal_id
     ${where}
     ORDER BY d.from_proposal_id, d.dependency_type, pt.display_id`,
		params,
	);
	return rows;
}

export async function replaceDependencies(
	proposalId: number,
	dependencyIds: number[],
	dependencyType = "blocks",
): Promise<void> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`DELETE FROM roadmap.proposal_dependencies
       WHERE from_proposal_id = $1
         AND dependency_type = $2`,
			[proposalId, dependencyType],
		);

		for (const dependencyId of dependencyIds) {
			await client.query(
				`INSERT INTO roadmap.proposal_dependencies (from_proposal_id, to_proposal_id, dependency_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (from_proposal_id, to_proposal_id)
         DO UPDATE SET dependency_type = EXCLUDED.dependency_type, resolved = false, resolved_at = NULL, updated_at = now()`,
				[proposalId, dependencyId, dependencyType],
			);
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function listAcceptanceCriteria(
	proposalId: number,
): Promise<ProposalAcceptanceCriterionRow[]> {
	const { rows } = await query<ProposalAcceptanceCriterionRow>(
		`SELECT item_number, criterion_text, status, verified_by, verification_notes, verified_at
     FROM roadmap.proposal_acceptance_criteria
     WHERE proposal_id = $1
     ORDER BY item_number ASC`,
		[proposalId],
	);
	return rows;
}

export async function replaceAcceptanceCriteria(
	proposalId: number,
	criteria: Array<{
		item_number: number;
		criterion_text: string;
		status?: string;
	}>,
): Promise<void> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`DELETE FROM roadmap.proposal_acceptance_criteria
       WHERE proposal_id = $1`,
			[proposalId],
		);

		for (const criterion of criteria) {
			await client.query(
				`INSERT INTO roadmap.proposal_acceptance_criteria
           (proposal_id, item_number, criterion_text, status)
         VALUES ($1, $2, $3, $4)`,
				[
					proposalId,
					criterion.item_number,
					criterion.criterion_text,
					criterion.status ?? "pending",
				],
			);
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function releaseExpiredLeases(
	before = new Date(),
): Promise<number[]> {
	const { rows } = await query<{ proposal_id: number }>(
		`UPDATE roadmap.proposal_lease
     SET released_at = now(), release_reason = 'expired'
     WHERE released_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at <= $1
     RETURNING proposal_id`,
		[before],
	);
	return rows.map((row) => row.proposal_id);
}

/**
 * Search proposals by title (or use body_vector if pgvector is configured).
 */
export async function searchProposals(
	queryText: string,
	limit?: number,
): Promise<ProposalRow[]> {
	const maxResults = limit ?? 10;
	const { rows } = await query<ProposalRow>(
		`SELECT ${PROPOSAL_COLUMNS}
     FROM proposal
     WHERE to_tsvector(
             'english',
             CONCAT_WS(
               ' ',
               COALESCE(title, ''),
               COALESCE(summary, ''),
               COALESCE(motivation, ''),
               COALESCE(design, ''),
               COALESCE(drawbacks, ''),
               COALESCE(alternatives, ''),
               COALESCE(dependency, '')
             )
           )
            @@ plainto_tsquery('english', $1)
     ORDER BY modified_at DESC
     LIMIT $2`,
		[queryText, maxResults],
	);
	return rows;
}

/**
 * Proposal count by status.
 */
export async function proposalSummary(): Promise<
	{ status: string; count: number }[]
> {
	const { rows } = await query<{ status: string; count: number }>(
		`SELECT status, COUNT(*)::int as count
     FROM proposal
     GROUP BY status
     ORDER BY status`,
	);
	return rows;
}

/**
 * Get proposal versions.
 */
export async function getProposalVersions(identifier: string | number) {
	const proposalId = await resolveProposalId(identifier);
	if (proposalId === null) {
		return [];
	}

	const { rows } = await query(
		`SELECT * FROM proposal_version
     WHERE proposal_id = $1
     ORDER BY version_number ASC`,
		[proposalId],
	);
	return rows;
}

export async function deleteProposal(
	identifier: string | number,
): Promise<boolean> {
	const proposalId = await resolveProposalId(identifier);
	if (proposalId === null) {
		return false;
	}

	const { rowCount } = await query(
		`DELETE FROM proposal
     WHERE id = $1`,
		[proposalId],
	);
	return (rowCount ?? 0) > 0;
}
