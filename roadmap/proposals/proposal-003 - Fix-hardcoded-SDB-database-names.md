---
id: PROPOSAL-003
title: Fix hardcoded SDB database names
status: New
assignee: []
created_date: '2026-04-02 00:41'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Problem: SDB database name hardcoded in multiple places. Config has sdb_database but code doesn't read it yet. Solution: Update all hardcoded database names to read from config.
<!-- SECTION:DESCRIPTION:END -->
