-- P993: liaison task tracker for typed A2A task protocol
CREATE TABLE IF NOT EXISTS roadmap.liaison_task_tracker (
  task_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id  UUID        NOT NULL,
  proposal_id     TEXT        NOT NULL,
  requestor_id    TEXT        NOT NULL,
  liaison_id      TEXT        NOT NULL,
  dispatch_id     INT,
  worker_identity TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','spawned','in_progress','complete','failed')),
  spawn_count     INT         NOT NULL DEFAULT 0,
  last_status_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS liaison_task_active_proposal
  ON roadmap.liaison_task_tracker (proposal_id)
  WHERE status NOT IN ('complete','failed');
