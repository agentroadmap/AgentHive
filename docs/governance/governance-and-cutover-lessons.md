# Governance and Cutover Lessons

This document captures the durable lessons from earlier architecture reviews, security reviews, migration planning, and PM snapshots without preserving the archive as a second source of truth.

## 1. Control-plane lesson

The most important migration lesson is simple: **shared workflow state must have one canonical home**. During cutover, mixed models created drift:

- files looked current while runtime state had already moved
- transition rules existed in prose but were not enforced in code or schema
- queue/order behavior differed depending on which surface was consulted

**Carry forward:** use PostgreSQL as the live control plane, and treat files as durable docs or exports.

## 2. Governance lesson

Policies only matter when the system enforces them.

The archive repeatedly showed the same failure mode:

- lifecycle expectations were described clearly
- but bypasses still existed in implementation
- so agents and humans developed different mental models of what “current” meant

**Carry forward:** critical workflow rules must live in enforced transitions, constraints, leases, ACL checks, and auditable events rather than only in markdown guidance.

## 3. Security lesson

The still-valid security priorities are:

1. explicit authn/authz for mutations
2. rate limiting and anti-loop guardrails
3. audit trails for proposal and non-proposal operations
4. secrets scanning and dependency hygiene
5. clear human escalation for freeze / override / unlock decisions

What should not be carried forward is any security guidance that assumes file-backed state is the real enforcement layer.

## 4. Migration lesson

Most detailed migration plans in the archive are now historical. The durable lessons are:

- avoid long-lived dual-write states
- prefer compatibility shims over silent path breakage
- separate schema source files from general product documentation
- preserve recoverability and rollback thinking even after cutover
- summarize historical decisions before deleting old locations

## 5. Operational lesson

PM snapshots and daily reviews were useful for pattern detection, not as permanent docs.

The repeated patterns worth keeping were:

- governance lag creates more pain than missing features
- formatting/path drift compounds quickly in agent-heavy repos
- ambiguity about canonical locations wastes time
- recurring manual checks should become explicit smoke tests or guardrails

## 6. Current review checklist

When evaluating future restructures or workflow changes, ask:

1. Is there one canonical source of live truth?
2. Are the transition and permission rules enforced, not just documented?
3. Can humans and agents find the current guidance without searching the archive?
4. Is the change observable through build, type, and end-to-end checks?
5. Can the system recover cleanly if a sync/export/lease step fails?
