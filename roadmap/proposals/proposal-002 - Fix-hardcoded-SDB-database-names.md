---
id: PROPOSAL-002
title: Fix hardcoded SDB database names
status: New
assignee: []
created_date: '2026-04-02 00:41'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem\n\nThe SDB database name is hardcoded in multiple places:\n-  → \n-  →  (with env var override)\n-  → \n\nThe config file has  but the code doesn't read it yet.\n\n## Solution\n\nUpdate all hardcoded database names to read from config or use a single source of truth.\n\n## Impact\n\n- MCP health shows wrong database name\n- Different parts of code use different database names\n- Makes multi-project support impossible\n\n## Priority\n\nHigh - blocks proper MCP server operation
<!-- SECTION:DESCRIPTION:END -->
