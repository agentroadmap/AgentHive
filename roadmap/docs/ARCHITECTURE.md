# AgentRoadmap Architecture

## Overview
AgentRoadmap is a "Digital Nervous System" for autonomous AI agent teams. It coordinates work across 100+ agents by separating real-time coordination (Soul), semantic memory (Memory), and physical artifacts (Body).

## Core Pillars
1. **The Soul (SpacetimeDB)**: 
   - Primary source of truth for personalities, budgets, real-time coordination, and expert registries.
   - Provides ACID transactions and serializable isolation to prevent agent race conditions.
2. **The Memory (Vector + Graph)**:
   - Stores research, past discussions, and decision-making context.
   - Provides high-speed retrieval for agent context.
3. **The Body (Git + Filesystem)**:
   - Source of truth for product artifacts (code, designs, documentation).
   - "Git-as-a-Database" pattern ensures auditability and point-in-time recovery.

## Component Domains
- **Identity**: Registry of agents, skills, and unique identities.
- **State**: Lifecycle management of tasks and milestones.
- **Orchestration**: Resource allocation, agent pool management, and reporting.
- **Storage**: Hybrid adapters for SpacetimeDB and local filesystem export.
- **Messaging**: Event-driven communication protocol between agents.

## New Baseline (2026-03-31)
- Transitioned from pure file-based operations to SpacetimeDB-native architecture.
- Modularized `src/core` into specialized domain managers.
- Established `roadmap/` as the canonical metadata and documentation home.
