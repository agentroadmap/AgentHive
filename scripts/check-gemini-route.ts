import { getPool } from "../src/infra/postgres/pool.ts";

async function main() {
    const pool = getPool();
    const { rows } = await pool.query(`
        SELECT agent_provider, model_name, is_enabled 
        FROM roadmap.model_routes 
        WHERE agent_provider = 'gemini'
    `);
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
}

main().catch(console.error);
