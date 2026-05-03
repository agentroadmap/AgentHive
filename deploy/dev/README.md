# dev schema — ephemeral sandbox

The `dev` schema in `agentHive2` is for temporary experimental objects only.

**Rules:**
- Objects here are never referenced by `deploy/` files.
- Drop any object freely — nothing in production depends on it.
- CI lint blocks `dev.` references from entering `deploy/`: `grep -rn 'dev\.' deploy/ && exit 1`

**Do not put here:**
- Tables you intend to keep
- Functions used by application code
- Seed data or reference data

Use it for: scratch queries, temp tables during exploration, prototype functions you haven't decided to promote yet.

When you promote something from `dev` to a real schema, write a proper migration file in `deploy/migrations/`.
