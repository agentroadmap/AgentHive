-- 005-populate-body-markdown.sql
-- Populate body_markdown from local roadmap files
-- Generated: 2026-04-04 21:42 EDT
-- Run BEFORE this: populate body_markdown from md files

-- This is a helper script - actual body content is populated via Node.js script
-- because PostgreSQL cannot read filesystem directly.

-- After running the Node script, verify:
-- SELECT display_id, char_length(body_markdown) as body_len FROM proposal WHERE body_markdown IS NOT NULL ORDER BY display_id;
