import { query } from "./src/infra/postgres/pool.ts";

async function main() {
  // Check schemas
  console.log("=== DATABASE SCHEMAS ===");
  const schemas = await query(
    `SELECT schema_name FROM information_schema.schemata 
     WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')`
  );
  for (const row of schemas.rows) {
    console.log(`- ${row.schema_name}`);
  }

  // Check tables in metrics schema
  console.log("\n=== METRICS SCHEMA TABLES ===");
  try {
    const tables = await query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'metrics'`
    );
    if (tables.rows.length === 0) {
      console.log("No tables in metrics schema");
    } else {
      for (const row of tables.rows) {
        console.log(`- ${row.table_name}`);
      }
    }
  } catch (e) {
    console.log("Error:", e);
  }

  // Check tables in roadmap schema
  console.log("\n=== ROADMAP SCHEMA TABLES ===");
  const roadmapTables = await query(
    `SELECT table_name FROM information_schema.tables 
     WHERE table_schema = 'roadmap' 
     ORDER BY table_name`
  );
  for (const row of roadmapTables.rows) {
    console.log(`- ${row.table_name}`);
  }

  // Check if token_efficiency exists anywhere
  console.log("\n=== TOKEN EFFICIENCY CHECK ===");
  try {
    const tokenCheck = await query(
      `SELECT COUNT(*) as count FROM metrics.token_efficiency`
    );
    console.log(`Token efficiency rows: ${tokenCheck.rows[0].count}`);
  } catch (e) {
    console.log("Token efficiency table not found");
  }

  // Check if semantic_responses exists anywhere
  console.log("\n=== SEMANTIC RESPONSES CHECK ===");
  try {
    const semanticCheck = await query(
      `SELECT COUNT(*) as count FROM roadmap.semantic_responses`
    );
    console.log(`Semantic responses rows: ${semanticCheck.rows[0].count}`);
  } catch (e) {
    console.log("Semantic responses table not found");
  }
}

main().catch(console.error);
