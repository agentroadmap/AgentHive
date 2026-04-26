-- Example DDL migration for P524 testing
-- env: dev

CREATE TABLE IF NOT EXISTS roadmap.example_table (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_example_table_name ON roadmap.example_table(name);
