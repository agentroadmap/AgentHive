# Dashboard E2E Tests

Playwright tests for the AgentHive web dashboard at `http://10.0.0.77:6420/board` and sibling routes.

## Quick run

From repo root on a host where `node_modules` are installed and Chromium is cached (i.e. `bot`):

```bash
# One-time setup
npm install --save-dev @playwright/test
npx playwright install chromium

# Run the whole suite
npx playwright test --config tests/dashboard-e2e/playwright.config.ts

# Single spec
npx playwright test --config tests/dashboard-e2e/playwright.config.ts tests/dashboard-e2e/02-board.spec.ts

# Headed (watch it run)
npx playwright test --config tests/dashboard-e2e/playwright.config.ts --headed

# Debug a single test
npx playwright test --config tests/dashboard-e2e/playwright.config.ts -g "B-1" --debug
```

## Environment override

The base URL defaults to `http://10.0.0.77:6420`. Override:

```bash
DASHBOARD_BASE_URL=http://localhost:6420 npx playwright test --config tests/dashboard-e2e/playwright.config.ts
```

## Output

- HTML report: `tests/dashboard-e2e/.playwright-report/index.html` (open with `npx playwright show-report tests/dashboard-e2e/.playwright-report`)
- Failure screenshots: `tests/dashboard-e2e/test-results/<test>/`
- Findings (manual notes from runs): `tests/dashboard-e2e/findings/<test-id>.md`

## Plan & scope

The canonical plan with every test ID, expected behavior, requirements anchor, and UX observations lives in [`PLAN.md`](./PLAN.md). Each `.spec.ts` references the test IDs from the plan.

## Test ID convention

| Prefix | Page / area |
|---|---|
| `PF-*` | Pre-flight environment checks |
| `C-NAV-*` | Cross-cutting navigation chrome |
| `C-THM-*` | Cross-cutting theme |
| `C-HLTH-*` | Cross-cutting health indicator |
| `C-SCOPE-*` | Cross-cutting project scope |
| `C-RTE-*` | Cross-cutting routing |
| `D-*` | `/` DashboardPage |
| `B-*` | `/board` BoardPage |
| `PR-*` | `/proposals` |
| `DV-*` | `/directives` |
| `AG-*` | `/agents` |
| `TM-*` | `/teams` |
| `CH-*` | `/channels` |
| `ST-*` | `/statistics` |
| `AC-*` | `/activity` |
| `DP-*` | `/dispatches` |
| `KN-*` | `/knowledge` |
| `DOC-*` | `/documents` |
| `DC-*` | `/decisions` |
| `MP-*` | `/map` |
| `RT-*` | `/routes` |
| `SET-*` | `/settings` |
| `AV-*` | `/achievements` |
| `NF-*` | NotFoundPage |
| `WS-*` | WebSocket protocol |

## Findings policy

When a test fails or surfaces a UX issue:

1. Capture the screenshot via Playwright (auto-saved on failure).
2. Write a `findings/<test-id>.md` with: failure mode, environment, repro steps, suggested fix.
3. File an AgentHive proposal via MCP: `mcp_proposal create` with type=`issue` (bug) or `feature` (UX/feature gap).
4. Reference the proposal display_id in the findings note.

See `PLAN.md` §23 for cross-posting policy.
