# @agenthive/scan-rules-agenthive

Hardcoding scanner rule pack for AgentHive-specific patterns.

## Rules

| Rule ID | Severity | Description |
|---------|----------|-------------|
| models.cli-builders-default-model | high | Hardcoded default model in cli-builders |
| models.hardcoded-anthropic | high | Hardcoded Anthropic model name |
| models.hardcoded-openai | high | Hardcoded OpenAI model name |
| models.hardcoded-xiaomi | high | Hardcoded xiaomi/custom model name |
| models.bare-model-string-in-spawn | high | Bare model string in spawn args |
| agencies.hermes-agency-xiaomi | high | Hardcoded hermes-agency-xiaomi reference |
| agencies.hardcoded-agent-name | high | Hardcoded agent name (e.g., agent-123) |
| agencies.hardcoded-worker-id | medium | Hardcoded worker ID |
| agencies.discord-id-hardcode | low | Hardcoded Discord ID in agency context |
| misc.unqualified-roadmap-table | high | Unqualified roadmap table reference (no schema prefix) |
| misc.console-log-in-handler | high | console.log in request handler (should be logger) |
| misc.todo-without-proposal | high | TODO comment without proposal ID reference |
| misc.fixme-marker | medium | FIXME marker without context |

## Philosophy

This rule pack is **AgentHive-specific** and enforces project conventions:

- **Model names**: Use runtime configuration; no hardcoded model IDs
- **Agency identities**: Use resolved identities from DB/config; no bare names
- **Database references**: Always qualify table names with schema prefix
- **Logging**: Use structured logger, not console.log
- **Technical debt**: All TODO/FIXME must reference a proposal for tracking

These rules reflect AgentHive's internal standards and are less relevant to external projects.

## Usage

Only include this rule pack if you're working on AgentHive:

```bash
npm install @agenthive/scan-core \
  @agenthive/scan-rules-secrets \
  @agenthive/scan-rules-multi-tenant \
  @agenthive/scan-rules-workflow-states \
  @agenthive/scan-rules-agenthive
scan-hardcoding --format jsonl
```

## Integration

These rules are enforced during AgentHive development and gated by CI:

```bash
scan-hardcoding --fail-on high
```

## License

Same as AgentHive project license
