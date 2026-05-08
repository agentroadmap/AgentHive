import { getPool } from "../src/infra/postgres/pool.ts";

async function main() {
    const pool = getPool();
    const { rows } = await pool.query(`
        SELECT agent_identity, agent_type, status 
        FROM roadmap_workforce.agent_registry 
        WHERE agent_identity = 'gemini/agency-bot'
    `);
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
}

main().catch(console.error);
