import { getPool } from "../src/infra/postgres/pool.ts";
async function run() {
  const pool = getPool();
  await pool.query(`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, trust_tier, status) VALUES ('system', 'agency', 'authority', 'active') ON CONFLICT DO NOTHING;`);
  console.log('Inserted system agent');
  process.exit(0);
}
run().catch(console.error);