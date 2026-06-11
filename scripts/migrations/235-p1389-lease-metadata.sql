-- P1389: proposal_lease.metadata — honor prop_claim's declared `message` param.
-- claimLease() persists {claim_message} here; without this column the INSERT
-- throws and the silent catch in claimLease would break ALL claims.
-- Nullable, no default: zero impact on existing inserters (fn_* primitives,
-- orchestrator paths use explicit column lists).

ALTER TABLE roadmap_proposal.proposal_lease
  ADD COLUMN IF NOT EXISTS metadata jsonb;
