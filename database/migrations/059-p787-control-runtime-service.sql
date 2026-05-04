CREATE TABLE IF NOT EXISTS roadmap.control_runtime_service (
  id          BIGSERIAL PRIMARY KEY,
  service_key TEXT NOT NULL UNIQUE,
  url         TEXT NOT NULL,
  host        TEXT,
  port        INTEGER,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roadmap.control_runtime_service (service_key, url)
VALUES ('mcp', 'http://127.0.0.1:6421/sse'),
       ('daemon', 'http://127.0.0.1:3000')
ON CONFLICT (service_key) DO NOTHING;
