import { getPool } from "../src/infra/postgres/pool.ts";

async function run() {
  const pool = getPool();
  await pool.query(`UPDATE roadmap_proposal.proposal SET maturity = 'mature' WHERE id = 913;`);
  const res = await pool.query(`SELECT status, maturity FROM roadmap_proposal.proposal WHERE id = 913;`);
  console.log(res.rows[0]);
  process.exit(0);
}
run().catch(console.error);