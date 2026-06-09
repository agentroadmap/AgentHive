# @agenthive/scan-rules-multi-tenant

Hardcoding scanner rule pack for multi-tenant patterns (paths, identities, endpoints).

## Rules

| Rule ID | Severity | Description |
|---------|----------|-------------|
| paths.agenthive-worktree-root | high | Hardcoded /data/code/worktree paths |
| paths.agenthive-project-root | high | Hardcoded /data/code/AgentHive paths |
| paths.legacy-worktree-prefix | high | Old worktree prefix patterns |
| paths.gitconfig-root | medium | Hardcoded ~/.gitconfig references |
| paths.home-xiaomi | high | Hardcoded /home/xiaomi paths |
| paths.absolute-home-hardcode | high | Hardcoded ~ or $HOME expansion |
| paths.docs-tmp-write | medium | Hardcoded /tmp writes in docs |
| paths.docs-ship-write | medium | Hardcoded /ship writes in docs |
| identity.pguser-fallback-xiaomi | high | Hardcoded PGUSER fallback to xiaomi |
| identity.bare-xiaomi-literal | high | Bare "xiaomi" user ID string |
| identity.pgdatabase-fallback-agenthive | medium | Hardcoded PGDATABASE defaults |
| identity.psql-shell-user | medium | User-hardcoded psql commands |
| identity.shell-pgpassword-set | critical | PGPASSWORD set in scripts |
| identity.systemd-user-hardcode | high | Hardcoded User= in systemd units |
| endpoints.mcp-url | critical | Hardcoded MCP server URL |
| endpoints.daemon-url | critical | Hardcoded daemon endpoint |
| endpoints.ws-url | high | Hardcoded WebSocket URLs |
| endpoints.pg-host | high | Hardcoded PostgreSQL host |
| endpoints.discord-api-url | medium | Hardcoded Discord API base URL |
| endpoints.bare-port-numbers | medium | Hardcoded port numbers in strings |

## Philosophy

Multi-tenant systems must avoid hardcoding:

- **Paths**: Use runtime path resolvers; no `/data/code/*` or `/home/*` literals
- **Identities**: No user/username/role names in code; use config or environment
- **Endpoints**: No hardcoded URLs; use configuration or service discovery

These patterns are **generic** and apply to any multi-tenant system, not just AgentHive.

## Usage

```bash
npm install @agenthive/scan-core @agenthive/scan-rules-multi-tenant
scan-hardcoding --format jsonl
```

Combine with @agenthive/scan-rules-secrets for basic security + multi-tenant scanning.

## Integration

Useful for:
- Saas platforms with per-tenant data isolation
- Microservice architectures with service discovery
- Development environments that must not leak to prod

## License

MIT
