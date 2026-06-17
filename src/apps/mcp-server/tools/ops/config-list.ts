/**
 * P3784: Config introspection — enumerate all keys in AllConfigKeys with
 * per-key metadata and current resolved value.
 *
 * Design rules:
 * - Secret-class keys: masked=true, editable=false, value=null. getOptional is
 *   NEVER called for secret keys (short-circuit before resolution).
 * - tenant_dsn keys: editable=false, value=null (access is via getProjectDb, not get/getOptional).
 * - registry/flag keys: editable=true.
 * - Unresolved required keys: value=null (no throw — AC-4).
 * - Category filter: if provided, only keys with matching category are returned.
 *   Pre-P3782 category is absent → emitted as null, no throw (AC-10).
 */

import { getOptional } from "../../../../shared/runtime/config.ts";
import { AllConfigKeys } from "../../../../shared/runtime/config-keys.ts";

export interface ConfigKeyDescriptor {
	name: string;
	class: string;
	category: string | null;
	description: string | null;
	required: boolean;
	default_value: unknown | null;
	db_table: string | null;
	editable: boolean;
	masked: boolean;
	value: unknown | null;
}

export interface ConfigListResult {
	keys: ConfigKeyDescriptor[];
	count: number;
	category_filter: string | null;
}

export interface ConfigListArgs {
	category?: string;
}

export async function configList(
	args: ConfigListArgs = {},
): Promise<ConfigListResult> {
	const categoryFilter = args.category ?? null;

	const allEntries = Object.values(AllConfigKeys);
	const descriptors: ConfigKeyDescriptor[] = [];

	for (const key of allEntries) {
		const isSecret = key.class === "secret";
		const isTenantDsn = key.class === "tenant_dsn";
		const editable = key.class === "registry" || key.class === "flag";
		const masked = isSecret;

		// AC-10: category added by P3782; keys without it (non-flag) emit null
		const category = key.category ?? null;

		// Apply category filter
		if (categoryFilter !== null && category !== categoryFilter) {
			continue;
		}

		// AC-2 / AC-11: never invoke getOptional for secret keys
		let value: unknown | null = null;
		if (!isSecret && !isTenantDsn) {
			try {
				// Cast to ConfigKey<unknown | undefined> — getOptional accepts this shape
				const resolved = await getOptional(key as Parameters<typeof getOptional>[0]);
				value = resolved ?? null;
			} catch {
				// AC-4: unresolved/required-but-missing → null, no throw
				value = null;
			}
		}

		descriptors.push({
			name: key.name,
			class: key.class,
			category,
			description: key.description ?? null,
			required: key.required,
			default_value: key.defaultValue ?? null,
			db_table: key.dbTable ?? null,
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
