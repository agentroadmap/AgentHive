/**
 * template-catalog.ts — catalog hygiene helpers and snapshot reader
 * for template.workflow_template and workflow_active.workflow_template_copy.
 *
 * AC#7: deprecate / retire lifecycle transitions
 * AC#9: snapshot reader (reads from workflow_active.workflow_template_copy)
 *
 * @module workflow/template-catalog
 */

import { query } from "../../infra/postgres/pool.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkflowTemplateRow {
	template_id: string;
	family: string;
	version: number;
	display_name: string;
	description: string | null;
	states: unknown[];
	gates: unknown[];
	published_at: Date;
	owner_did: string;
	lifecycle_status: "active" | "deprecated" | "retired";
	deprecated_at: Date | null;
	retire_after: Date | null;
	notes: string | null;
}

export interface TemplateCopyRow {
	project_id: number;
	template_id: string;
	family: string;
	version: number;
	display_name: string;
	states: unknown[];
	gates: unknown[];
	pinned_at: Date;
	pinned_by_did: string;
}

// ─── Catalog hygiene ─────────────────────────────────────────────────────────

/**
 * AC#7: Deprecate a template. Sets lifecycle_status → 'deprecated'
 * and records deprecated_at. Template rows remain readable.
 */
export async function deprecateTemplate(
	templateId: string,
	retireAfter?: Date,
	notes?: string,
): Promise<void> {
	await query(
		`UPDATE template.workflow_template
     SET lifecycle_status = 'deprecated',
         deprecated_at    = now(),
         retire_after     = $2,
         notes            = COALESCE($3, notes)
     WHERE template_id = $1
       AND lifecycle_status = 'active'`,
		[templateId, retireAfter ?? null, notes ?? null],
	);
}

/**
 * AC#7: Retire a template. Sets lifecycle_status → 'retired'.
 * Can only transition from 'deprecated' (must deprecate first).
 */
export async function retireTemplate(
	templateId: string,
	notes?: string,
): Promise<void> {
	const { rowCount } = await query(
		`UPDATE template.workflow_template
     SET lifecycle_status = 'retired',
         notes            = COALESCE($2, notes)
     WHERE template_id = $1
       AND lifecycle_status = 'deprecated'`,
		[templateId, notes ?? null],
	);
	if (!rowCount) {
		throw new Error(
			`Cannot retire template ${templateId}: must be in 'deprecated' state first`,
		);
	}
}

/**
 * AC#7: List templates by lifecycle status.
 */
export async function listTemplates(
	status: "active" | "deprecated" | "retired" = "active",
): Promise<WorkflowTemplateRow[]> {
	const { rows } = await query<WorkflowTemplateRow>(
		`SELECT * FROM template.workflow_template
     WHERE lifecycle_status = $1
     ORDER BY family, version`,
		[status],
	);
	return rows;
}

// ─── Snapshot reader ─────────────────────────────────────────────────────────

/**
 * AC#9: Pin a template to a project by writing a snapshot into
 * workflow_active.workflow_template_copy. Safe to call repeatedly
 * (ON CONFLICT DO UPDATE).
 */
export async function pinTemplateToProject(
	projectId: number,
	templateId: string,
	pinnedByDid = "system:orchestrator",
): Promise<void> {
	await query(
		`INSERT INTO workflow_active.workflow_template_copy
       (project_id, template_id, family, version, display_name, states, gates, pinned_by_did)
     SELECT $1, t.template_id, t.family, t.version, t.display_name, t.states, t.gates, $3
     FROM template.workflow_template t
     WHERE t.template_id = $2
     ON CONFLICT (project_id, template_id)
     DO UPDATE SET
       states       = EXCLUDED.states,
       gates        = EXCLUDED.gates,
       display_name = EXCLUDED.display_name,
       pinned_at    = now(),
       pinned_by_did = EXCLUDED.pinned_by_did`,
		[projectId, templateId, pinnedByDid],
	);
}

/**
 * AC#9: Read the template snapshot for a project.
 * Returns the pinned copy without joining template.workflow_template.
 */
export async function getProjectTemplateSnapshot(
	projectId: number,
	templateId: string,
): Promise<TemplateCopyRow | null> {
	const { rows } = await query<TemplateCopyRow>(
		`SELECT * FROM workflow_active.workflow_template_copy
     WHERE project_id = $1 AND template_id = $2`,
		[projectId, templateId],
	);
	return rows[0] ?? null;
}

// ─── Alias resolver ──────────────────────────────────────────────────────────

/**
 * Resolve a stable alias name to a concrete template_id.
 * Allows callers to pin by alias (e.g. 'default') rather than a versioned id.
 * Returns null if the alias does not exist.
 */
export async function resolveTemplateAlias(
	aliasName: string,
): Promise<string | null> {
	const { rows } = await query<{ template_id: string }>(
		`SELECT template_id FROM template.workflow_template_alias WHERE alias_name = $1`,
		[aliasName],
	);
	return rows[0]?.template_id ?? null;
}
