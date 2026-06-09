# @agenthive/scan-rules-secrets

Hardcoding scanner rule pack for secret detection.

## Rules

| Rule ID | Severity | Description |
|---------|----------|-------------|
| credentials.aws-key | critical | AWS access key ID (AKIA prefix) |
| credentials.aws-secret | critical | AWS secret access key |
| credentials.anthropic-api-key | critical | Anthropic API key (sk-ant-*) |
| credentials.openai-api-key | critical | OpenAI API key (sk-*) |
| credentials.github-pat | critical | GitHub Personal Access Token |
| credentials.gcp-service-account | critical | GCP service account JSON |
| credentials.private-key-block | critical | Private key blocks (RSA, OPENSSH, PGP) |
| credentials.bearer-token | critical | Bearer token in code |
| credentials.dotenv-leak | critical | .env files or hardcoded env vars |

## Usage

```bash
npm install @agenthive/scan-core @agenthive/scan-rules-secrets
scan-hardcoding --format jsonl
```

## Philosophy

Secrets should **never** be hardcoded. This rule pack detects common patterns of secret leaks:

- API keys with known prefixes (AWS AKIA, OpenAI sk-, Anthropic sk-ant-)
- Bearer token patterns
- Private key block headers
- .env file references

All rules use high confidence regex patterns to minimize false positives.

## Integration

This is the only rule pack that should be used by **any** project, regardless of technology stack. Add it to your base scanner installation.

For AgentHive projects, combine with:
- @agenthive/scan-rules-multi-tenant
- @agenthive/scan-rules-workflow-states
- @agenthive/scan-rules-agenthive

## License

MIT
