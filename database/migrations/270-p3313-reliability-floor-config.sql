-- Migration 270: P3313 AC-3 — reliability_floor config table + conservative seeds
-- Per-(task_class) minimum reliability score. Downshift across a floor is BLOCKED.
-- Seeded conservatively: high-stakes classes require near-frontier reliability.

CREATE TABLE IF NOT EXISTS roadmap_workforce.reliability_floor (
  task_class   TEXT         NOT NULL PRIMARY KEY,
  min_score    NUMERIC(4,3) NOT NULL
    CHECK (min_score >= 0 AND min_score <= 1),
  notes        TEXT,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by   TEXT
);

COMMENT ON TABLE roadmap_workforce.reliability_floor IS
  'P3313: per-task-class minimum reliability score. Downshift below this floor is BLOCKED + alerted.';

-- Seeds: conservative defaults.
-- High-stakes gate/merge/architecture must be routed to a reliable model regardless of cost.
INSERT INTO roadmap_workforce.reliability_floor (task_class, min_score, notes, updated_by) VALUES
  ('gate_review',  0.85, 'gate decisions must not be routed to unreliable models', 'system'),
  ('merge',        0.85, 'merge execution must not be routed to unreliable models', 'system'),
  ('architecture', 0.85, 'architecture proposals require high-reliability routing', 'system'),
  ('code_dev',     0.70, 'development tasks need mid-tier reliability minimum', 'system'),
  ('mcp_protocol', 0.75, 'MCP multi-step tool use fails on low-reliability models (Haiku incident)', 'system'),
  ('enhance',      0.60, 'enhancement tasks tolerate mid-tier reliability', 'system'),
  ('research',     0.55, 'research tasks tolerate some unreliability; outputs are reviewed', 'system'),
  ('triage',       0.40, 'triage tasks are low-stakes; cheap models acceptable', 'system'),
  ('mechanical',   0.30, 'mechanical tasks (grep, count, format) tolerate low reliability', 'system')
ON CONFLICT (task_class) DO NOTHING;
