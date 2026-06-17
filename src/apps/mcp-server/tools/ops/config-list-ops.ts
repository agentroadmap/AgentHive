/**
 * P3784: Config introspection — shared core for MCP tool and REST endpoint.
 *
 * Enumerates every key in AllConfigKeys with derived metadata.
 * Secret-class keys are short-circuited before any getOptional call.
 * Both surfaces (mcp_ops config_list + GET /api/config/keys) must import and
 * call this function so they cannot drift from each other (AC-8).
 */

import { AllConfigKeys } from "../../../../shared/runtime/config-keys.ts";
import { getOptional } from "../../../../shared/runtime/config.ts";
import type { ConfigKey } from "../../../../shared/runtime/config.ts";

export interface ConfigKeyDescriptor {
	name: string;
	class: string;
	category: string | null;
	description: string | null;
	value: unknown;
	default_value: unknown;
	required: boolean;
	db_table: string | null;
	scope: null;
	editable: boolean;
	masked: boolean;
}

export interface ConfigListResult {
	keys: ConfigKeyDescriptor[];
	count: number;
	category_filter: string | null;
}

/**
 * Resolve metadata + live value for every registered config key.
 *
 * - Secret keys: value=null, masked=true. getOptional is NEVER invoked.
 * - tenant_dsn keys: value=null (pool-bound, not value-bound).
 * - All others: value resolved via getOptional; errors silently yield null.
 */
export async function configList(opts?: {
	category?: string;
}): Promise<ConfigListResult> {
	const categoryFilter = opts?.category ?? null;

	const allKeys = Object.values(AllConfigKeys) as ConfigKey<unknown>[];
	const filtered = categoryFilter
		? allKeys.filter(
				(k) => (k as { category?: string }).category === categoryFilter,
			)
		: allKeys;

	const descriptors: ConfigKeyDescriptor[] = [];
	for (const key of filtered) {
		const masked = key.class === "secret";
		const editable = key.class === "flag" || key.class === "registry";
		const isTenantDsn = key.class === "tenant_dsn";

		let value: unknown = null;
		if (!masked && !isTenantDsn) {
			try {
				value =
					(await getOptional(
						key as ConfigKey<unknown | undefined>,
					)) ?? null;
			} catch {
				value = null;
			}
		}

		descriptors.push({
			name: key.name,
			class: key.class,
			category: (key as { category?: string }).category ?? null,
			description: (key as { description?: string }).description ?? null,
			value,
			default_value:
				("defaultValue" in key
					? (key as { defaultValue?: unknown }).defaultValue
					: null) ?? null,
			required: key.required,
			db_table: (key as { dbTable?: string }).dbTable ?? null,
			scope: null,
			editable,
			masked,
		});
	}

	return {
		keys: descriptors,
		count: descriptors.length,
		category_filter: categoryFilter,
	};
}
