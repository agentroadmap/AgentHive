import { getPool } from "../src/infra/postgres/pool.ts";

async function main() {
    const pool = getPool();
    await pool.query(`
        UPDATE roadmap.model_routes 
        SET is_enabled = true 
        WHERE agent_provider = 'gemini' AND model_name = 'gemini-2.0-flash'
    `);
    console.log("Enabled gemini-2.0-flash route.");
    process.exit(0);
}

main().catch(console.error);
