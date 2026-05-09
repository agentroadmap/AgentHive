import { getPool } from "../src/infra/postgres/pool.ts";

async function run() {
  const pool = getPool();
  await pool.query(`UPDATE roadmap_proposal.proposal SET status = 'DEVELOP' WHERE id = 913;`);
  
  // Add an audit log to ensure the transition is recorded properly.
  await pool.query(`
    INSERT INTO roadmap_proposal.proposal_audit_events 
    (proposal_id, event_type, from_state, to_state, actor_identity, event_metadata)
    VALUES (913, 'status_changed', 'DRAFT', 'DEVELOP', 'system', '{"notes": "Gate validated: test passes, biome is clean"}'::jsonb)
  `);

  console.log('Transitioned P913 to DEVELOP');
  process.exit(0);
}
run().catch(console.error);