import { query } from "../src/infra/postgres/pool.ts";

const reviews = [
  { pid: 178, notes: "Missing summary table mapping principles to mechanisms; document not persisted to roadmap.documents" },
  { pid: 179, notes: "Constitution not persisted to roadmap.documents with type=governance" },
  { pid: 180, notes: "No per-phase owners or testable criteria; P167/P168/P169 dependencies not registered; doc not stored" },
  { pid: 183, notes: "agent-onboarding.md file does not exist; not referenced from CLAUDE.md" },
  { pid: 184, notes: "Design field empty - no implementation specifics, no file/function targets" },
  { pid: 185, notes: "Design field empty - no schema definition, no data model, no query logic" },
  { pid: 199, notes: "Replay attack not in threat model; architecture option A/B/C not selected" },
];

for (const r of reviews) {
  await query(
    `INSERT INTO roadmap_proposal.proposal_reviews (proposal_id, reviewer_identity, verdict, is_blocking, notes, findings)
     VALUES ($1, 'system', 'reject', true, $2, $3::jsonb)
     ON CONFLICT (proposal_id, reviewer_identity) DO UPDATE SET
       verdict = EXCLUDED.verdict, is_blocking = EXCLUDED.is_blocking, notes = EXCLUDED.notes,
       findings = EXCLUDED.findings, reviewed_at = now()`,
    [r.pid, r.notes, JSON.stringify({ reviewer: "skeptic-beta", gate: "D2", method: "automated_ac_check" })]
  );

  const res = await query(
    `UPDATE roadmap_proposal.proposal_acceptance_criteria
     SET status = 'fail', verified_by = 'system', verification_notes = 'Skeptic review: proposal does not meet AC requirements', verified_at = now()
     WHERE proposal_id = $1 AND status = 'pending'`,
    [r.pid]
  );

  console.log(`P${r.pid}: review inserted, ${res.rowCount} ACs marked fail`);
}

console.log("Done");
process.exit(0);
