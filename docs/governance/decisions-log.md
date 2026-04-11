# Governance Decisions Log

*Institutional memory — read this before re-debating settled questions.*

---

## Decision G001: Adopt Ostrom's 8 Principles as Governance Framework
- **Date**: 2026-04-11
- **Decided by**: Gary (project owner), Hermes (research agent)
- **Rationale**: Ostrom's framework is the most empirically validated governance model for shared resources. Won Nobel Prize 2009. Tested across hundreds of real-world communities. We don't need to invent governance theory — we need to apply proven theory.
- **Alternatives considered**: Pure mechanism design (insufficient for culture), corporate governance (too hierarchical), emergent-only (doesn't scale)
- **Status**: Accepted
- **Related**: P170, P178

## Decision G002: Five-Layer Governance Model
- **Date**: 2026-04-11
- **Decided by**: Gary, Hermes
- **Rationale**: Governance needs layers of different "hardness" — immutable principles (constitution), enforceable rules (laws), social norms (conventions), correction mechanisms (discipline), moral guidance (ethics). Each layer has different enforcement mechanisms.
- **Layers**: Constitution (hardcoded) → Laws (gate pipeline) → Conventions (peer review) → Discipline (escalation ladder) → Ethics (SOUL.md)
- **Status**: Accepted
- **Related**: P179 (Constitution), P180 (Roadmap)

## Decision G003: Skeptic as Quality Gate (Not Punisher)
- **Date**: 2026-04-11
- **Decided by**: Gary
- **Rationale**: The skeptic should challenge work quality, not punish agents. It's an editor, not a judge. The purpose is to improve work, not to block agents. Agents can defend their work with evidence.
- **Implementation**: Skeptic runs at D2/D3/D4 gates. Blocks only with specific reasons. Agents can respond with evidence. Escalation to human for deadlocks.
- **Status**: Accepted
- **Related**: P168 (skeptic audit), orchestrator.ts

## Decision G004: Research Proposals Must Produce Tangible Outputs
- **Date**: 2026-04-11
- **Decided by**: Gary
- **Rationale**: Research without output is just reading. Even research proposals should produce: (1) implementation proposals for gaps found, (2) documentation agents can read, (3) skills/guides for future use. No "research complete" without artifacts.
- **Anti-pattern**: Endless discussion without action. We implement, observe, adjust.
- **Status**: Accepted
- **Related**: P170, P178, P179, P180, P181-P185

## Decision G005: Belbin Team Roles for Diversity
- **Date**: 2026-04-11
- **Decided by**: Gary, Hermes
- **Rationale**: Teams need role diversity — not 5 coders with no reviewer. Belbin's 9 roles (Plant, Shaper, Implementer, Completer Finisher, etc.) map naturally to agent types. Orchestrator should check role coverage when assembling teams.
- **Status**: Accepted, pending implementation (P184)
- **Related**: P184 (Belbin coverage), orchestrator.ts

---

## How to Use This Log

1. **Before debating**: Check if the question has been settled. If yes, respect the decision.
2. **To challenge a decision**: File a proposal with the decision ID and your reasoning. Don't re-debate in chat.
3. **To add a decision**: After a governance discussion produces a conclusion, add it here with rationale and alternatives considered.

---

*This log grows as governance decisions are made. Read it. Respect it. Challenge it formally.*
