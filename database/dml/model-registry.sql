-- model-registry.sql
-- Seed data: LLM model catalog for the multi-LLM router
-- Run once after DDL init. Safe to re-run (skips existing rows).
-- Costs as of 2026-04 in USD per 1k tokens (6dp for sub-cent precision).

INSERT INTO roadmap.model_metadata
  (model_name, provider, cost_per_1k_input, cost_per_1k_output,
   max_tokens, context_window, capabilities, rating, is_active)
SELECT v.model_name, v.provider, v.cost_in, v.cost_out,
       v.max_tokens, v.ctx, v.capabilities::jsonb, v.rating, true
FROM (VALUES
  -- ── Anthropic ──────────────────────────────────────────────────────────────
  ('claude-opus-4-6',    'anthropic', 0.015000, 0.075000, 32768,  200000,
   '{"vision":true,"tool_use":true,"cache":true,"json_mode":true}', 5),
  ('claude-sonnet-4-6',  'anthropic', 0.003000, 0.015000, 64000,  200000,
   '{"vision":true,"tool_use":true,"cache":true,"json_mode":true}', 4),
  ('claude-haiku-4-5',   'anthropic', 0.000250, 0.001250, 8192,   200000,
   '{"vision":true,"tool_use":true,"cache":true,"json_mode":true}', 3),
  -- ── OpenAI ─────────────────────────────────────────────────────────────────
  ('gpt-4o',             'openai',    0.002500, 0.010000, 16384,  128000,
   '{"vision":true,"tool_use":true,"json_mode":true}', 4),
  ('gpt-4o-mini',        'openai',    0.000150, 0.000600, 16384,  128000,
   '{"vision":true,"tool_use":true,"json_mode":true}', 3),
  ('o3',                 'openai',    0.010000, 0.040000, 100000, 200000,
   '{"tool_use":true,"json_mode":true,"reasoning":true}', 5),
  ('o4-mini',            'openai',    0.001100, 0.004400, 65536,  200000,
   '{"tool_use":true,"json_mode":true,"reasoning":true}', 4),
  -- ── Google ─────────────────────────────────────────────────────────────────
  ('gemini-2.5-pro',     'google',    0.001250, 0.010000, 65536,  1048576,
   '{"vision":true,"tool_use":true,"cache":true,"json_mode":true,"reasoning":true}', 5),
  ('gemini-2.0-flash',   'google',    0.000100, 0.000400, 8192,   1048576,
   '{"vision":true,"tool_use":true,"cache":true,"json_mode":true}', 3),
  ('gemini-2.0-flash-lite', 'google', 0.000075, 0.000300, 8192,   1048576,
   '{"vision":true,"tool_use":true,"json_mode":true}', 2)
) AS v(model_name, provider, cost_in, cost_out, max_tokens, ctx, capabilities, rating)
WHERE NOT EXISTS (
  SELECT 1 FROM roadmap.model_metadata WHERE model_name = v.model_name
);
