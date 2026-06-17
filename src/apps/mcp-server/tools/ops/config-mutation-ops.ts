/**
 * P828: Config mutation + audit surface (MCP).
 * P3784: Config key introspection (config_list).
 *
 * Operator/system tools that sit on top of the P474/P828
 * ConfigResolver.set() audited-mutation core:
 *
 *   config_get            (AC-22) — read a key's current resolved value + scope
 *                                    metadata. No mutation, no identity required
 *                                    beyond the control-plane read grant.
 *   config_mutation       (AC-23) — mutate a key via ConfigResolver.set(). The
 *                                    verified caller identity is read from
 *                                    agentContextStorage by set() itself (same
 *                                    carrier the A2A trust gate populates); this
 *                                    handler refuses if no verified principal is
 *                                    present so the audit row always has a caller.
 *   list_config_mutations (AC-25) — paginated read of core.config_mutation_log
 *                                    filtered by (key_name, scope).
 *   configList            (P3784) — enumerate every key in AllConfigKeys with
 *                                    per-key metadata, resolved value (never
 *                                    secret), editable/masked affordances, and
 *                                    optional category filter.
 *
 * All tools target hiveCentral (control plane) via the shared `query()` helper,
 * which already denies `agent` principals and audits pool access.
 */

import { agentContextStorage } from "../../../../shared/identity/agent-context.ts";
import { query } from "../../../../infra/postgres/pool.ts";
import { AllConfigKeys, getConfigKeyByName } from "../../../../shared/runtime/config-keys.ts";
import {
	type ConfigKey,
	getOptional,
	set as configSet,
} from "../../../../shared/runtime/config.ts";

export interface ConfigGetRequest {
	key_name: string;
}

export interface ConfigGetResponse {
	key_name: string;
	key_class: string;
	scope: string;
	value: unknown;
	required: boolean;
	description?: string;
	db_table?: string;
}

/**
 * AC-22: return the current resolved value + scope metadata for a key.
 * scope is 'global' for the resolver's flag/registry lookups (the only scope
 * ConfigResolver.set() writes today); the metadata is sourced from the static
 * ConfigKey definition so callers see class/required/dbTable without a write.
 */
export async function configGet(
	req: ConfigGetRequest,
): Promise<ConfigGetResponse> {
	if (!req.key_name || typeof req.key_name !== "string") {
		throw new Error("config_get requires a string `key_name`.");
	}
	const key: ConfigKey<unknown> = getConfigKeyByName(req.key_name);
	// getOptional never mutates; tenant_dsn / unresolved keys are reported as
	// value=null rather than throwing so the metadata is always returned.
	let value: unknown = null;
	try {
		value = (await getOptional(key as ConfigKey<unknown>)) ?? null;
	} catch {
		value = null;
	}
	return {
		key_name: key.name,
		key_class: key.class,
		scope: "global",
		value,
		required: key.required,
		description: key.description,
		db_table: key.dbTable,
	};
}

export interface ConfigMutationRequest {
	key_name: string;
	value: unknown;
}

export interface ConfigMutationResponse {
	ok: true;
	key_name: string;
	key_class: string;
	scope: string;
}

/**
 * AC-23: mutate a config key. Identity is read from agentContextStorage by
 * ConfigResolver.set(); we additionally refuse up-front when no verified
 * principal is present (UNLESS the AGENTHIVE_EMERGENCY_OPERATOR_DID override is
 * set, which set() itself honors) so the MCP surface never silently drops the
 * caller. set() performs the authority gate, runtime_flag upsert, audit append,
 * pg_notify, and synchronous cache eviction.
 */
export async function configMutation(
	req: ConfigMutationRequest,
): Promise<ConfigMutationResponse> {
	if (!req.key_name || typeof req.key_name !== "string") {
		throw new Error("config_mutation requires a string `key_name`.");
	}
	const ctx = agentContextStorage.getStore();
	const emergency = process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID?.trim();
	if (!ctx?.verified && !emergency) {
		throw new Error(
			"config_mutation requires a verified caller identity (agentContextStorage) " +
				"or the AGENTHIVE_EMERGENCY_OPERATOR_DID override.",
		);
	}
	const key: ConfigKey<unknown> = getConfigKeyByName(req.key_name);
	await configSet(key as ConfigKey<unknown>, req.value);
	return {
		ok: true,
		key_name: key.name,
		key_class: key.class,
		scope: "global",
	};
}

export interface ListConfigMutationsRequest {
	key_name?: string;
	scope?: string;
	limit?: number;
	offset?: number;
}

export interface ConfigMutationLogRow {
	mutation_id: string;
	key_name: string;
	key_class: string;
	scope: string | null;
	old_value: unknown;
	new_value: unknown;
	caller_did: string;
	principal_id: string;
	mutation_authority: string;
	validation_result: string;
	validation_error: string | null;
	mutated_at: string;
}

export interface ListConfigMutationsResponse {
	rows: ConfigMutationLogRow[];
	limit: number;
	offset: number;
	count: number;
}

/**
 * AC-25: paginated read of core.config_mutation_log filtered by (key_name,
 * scope). Newest-first. limit defaults to 50, clamped to [1, 500]; offset >= 0.
 */
export async function listConfigMutations(
	req: ListConfigMutationsRequest,
): Promise<ListConfigMutationsResponse> {
	const limit = Math.min(Math.max(Number(req.limit ?? 50) || 50, 1), 500);
	const offset = Math.max(Number(req.offset ?? 0) || 0, 0);

	const where: string[] = [];
	const params: unknown[] = [];
	if (req.key_name) {
		params.push(req.key_name);
		where.push(`key_name = $${params.length}`);
	}
	if (req.scope) {
		params.push(req.scope);
		where.push(`scope = $${params.length}`);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	params.push(limit);
	const limitIdx = params.length;
	params.push(offset);
	const offsetIdx = params.length;

	const result = await query<ConfigMutationLogRow>(
		`SELECT mutation_id, key_name, key_class, scope, old_value, new_value,
		        caller_did, principal_id, mutation_authority, validation_result,
		        validation_error, mutated_at
		   FROM core.config_mutation_log
		   ${whereSql}
		  ORDER BY mutated_at DESC
		  LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
		params as any[],
	);

	return {
		rows: result.rows,
		limit,
		offset,
		count: result.rows.length,
	};
}

// ─── P3784: Config key introspection ─────────────────────────────────────────

export interface ConfigKeyDescriptor {
	name: string;
	class: string;
	category: string | null;
	description: string | null;
	default_value: unknown;
	required: boolean;
	db_table: string | null;
	scope: string;
	editable: boolean;
	masked: boolean;
	value: unknown;
}

export interface ConfigListRequest {
	category?: string;
}

export interface ConfigListResponse {
	keys: ConfigKeyDescriptor[];
	count: number;
	category_filter: string | null;
}

/**
 * P3784: Enumerate every key in AllConfigKeys with per-key metadata,
 * resolved value (secrets are never read), editable/masked affordances,
 * and optional category filter.
 *
 * - Secret keys: masked=true, editable=false, value=null — getOptional is
 *   never called for them (short-circuit before any DB/env read).
 * - tenant_dsn keys: editable=false, value=null (pool-bound, not resolvable).
 * - registry/flag keys: editable=true.
 * - structural/diagnostic keys: editable=false.
 * - Unresolved/required-but-unset keys: value=null (no throw).
 * - P3782 null-degradation: category is null when absent on the ConfigKey
 *   definition (safe pre-P3782 behaviour).
 */
export async function configList(
	req: ConfigListRequest,
): Promise<ConfigListResponse> {
	const categoryFilter = req.category ?? null;
	const descriptors: ConfigKeyDescriptor[] = [];

	for (const key of Object.values(AllConfigKeys) as ConfigKey<unknown>[]) {
		const masked = key.class === "secret";
		const editable = key.class === "registry" || key.class === "flag";
		const category = ((key as unknown as Record<string, unknown>).category as string | null) ?? null;

		if (categoryFilter !== null && category !== categoryFilter) {
			continue;
		}

		let value: unknown = null;
		if (!masked && key.class !== "tenant_dsn") {
			try {
				value = (await getOptional(key)) ?? null;
			} catch {
				value = null;
			}
		}

		descriptors.push({
			name: key.name,
			class: key.class,
			category,
			description: key.description ?? null,
			default_value: key.defaultValue !== undefined ? key.defaultValue : null,
			required: key.required,
			db_table: key.dbTable ?? null,
			scope: "global",
			editable,
			masked,
			value,
		});
	}

	return {
		keys: descriptors,
		count: descriptors.length,
		category_filter: categoryFilter,
	};
}
