import { query } from "../../../../infra/postgres/pool.ts";

export type SchemaColumn = {
	column_name: string;
	data_type: string;
	is_nullable: boolean;
	column_default: string | null;
};

export type SchemaCheckConstraint = {
	name: string;
	definition: string;
};

export type SchemaTrigger = {
	name: string;
	timing: string;
	event: string;
	function: string;
};

export type SchemaIndex = {
	name: string;
	is_unique: boolean;
	definition: string;
};

export type SchemaDescribeResult = {
	schema: string;
	table: string;
	columns: SchemaColumn[];
	check_constraints: SchemaCheckConstraint[];
	triggers: SchemaTrigger[];
	indexes: SchemaIndex[];
	found: boolean;
	error?: string;
};

/**
 * Resolve {schema, table} from a possibly-qualified input. Accepts:
 *   "message_ledger"
 *   "roadmap.message_ledger"
 *   "roadmap_workforce.squad_dispatch"
 *
 * When unqualified, searches the search_path schemas and returns the FIRST
 * match. Build agents that pass an unqualified name and get back a schema
 * they didn't expect should look at the schema field of the result.
 */
async function resolveTable(
	raw: string,
): Promise<{ schema: string; table: string } | null> {
	if (raw.includes(".")) {
		const [schema, table] = raw.split(".", 2);
		return { schema, table };
	}
	const candidates = await query<{ table_schema: string }>(
		`SELECT table_schema FROM information_schema.tables
		  WHERE table_name = $1
		    AND table_schema NOT IN ('pg_catalog','information_schema')
		  ORDER BY array_position(
		    ARRAY['roadmap','roadmap_workforce','roadmap_proposal','roadmap_efficiency','public'],
		    table_schema
		  ) NULLS LAST, table_schema
		  LIMIT 1`,
		[raw],
	);
	if (candidates.rows.length === 0) return null;
	return { schema: candidates.rows[0].table_schema, table: raw };
}

export async function describeTable(
	tableArg: string,
): Promise<SchemaDescribeResult> {
	const resolved = await resolveTable(tableArg);
	if (!resolved) {
		return {
			schema: "",
			table: tableArg,
			columns: [],
			check_constraints: [],
			triggers: [],
			indexes: [],
			found: false,
			error: `Table not found in any non-system schema: ${tableArg}`,
		};
	}
	const { schema, table } = resolved;

	const columnsQ = await query<SchemaColumn>(
		`SELECT column_name, data_type,
		        (is_nullable = 'YES') AS is_nullable,
		        column_default
		   FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2
		  ORDER BY ordinal_position`,
		[schema, table],
	);

	if (columnsQ.rows.length === 0) {
		return {
			schema,
			table,
			columns: [],
			check_constraints: [],
			triggers: [],
			indexes: [],
			found: false,
			error: `Table ${schema}.${table} has no columns visible (does it exist?)`,
		};
	}

	const checksQ = await query<{ name: string; definition: string }>(
		`SELECT conname AS name, pg_get_constraintdef(oid) AS definition
		   FROM pg_constraint
		  WHERE conrelid = ($1 || '.' || $2)::regclass
		    AND contype = 'c'
		  ORDER BY conname`,
		[schema, table],
	);

	const triggersQ = await query<{
		name: string;
		timing: string;
		event: string;
		function: string;
	}>(
		`SELECT t.tgname AS name,
		        CASE WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE'
		             WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF'
		             ELSE 'AFTER' END AS timing,
		        CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT'
		             WHEN (t.tgtype & 8) <> 0 THEN 'DELETE'
		             WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE'
		             WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE'
		             ELSE 'UNKNOWN' END AS event,
		        p.proname AS function
		   FROM pg_trigger t
		   JOIN pg_proc p ON p.oid = t.tgfoid
		  WHERE t.tgrelid = ($1 || '.' || $2)::regclass
		    AND NOT t.tgisinternal
		  ORDER BY t.tgname`,
		[schema, table],
	);

	const indexesQ = await query<{
		name: string;
		is_unique: boolean;
		definition: string;
	}>(
		`SELECT i.indexname AS name,
		        idx.indisunique AS is_unique,
		        i.indexdef AS definition
		   FROM pg_indexes i
		   JOIN pg_class c ON c.relname = i.indexname
		   JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
		   JOIN pg_index idx ON idx.indexrelid = c.oid
		  WHERE i.schemaname = $1 AND i.tablename = $2
		  ORDER BY i.indexname`,
		[schema, table],
	);

	return {
		schema,
		table,
		columns: columnsQ.rows,
		check_constraints: checksQ.rows,
		triggers: triggersQ.rows,
		indexes: indexesQ.rows,
		found: true,
	};
}
