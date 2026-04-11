---
id: RFC-20260401-DATA-MODEL
display_id: RFC-20260401-DATA-MODEL
proposal_type: TECHNICAL
category: RESEARCH
domain_id: ENGINE
maturity: 0
title: "Data Model Schema v2.1"
status: Draft
assignee: []
created_date: "2026-04-01 20:08"
updated_date: "2026-04-01 20:08"
labels: ["data-model", "schema", "spacetimedb"]
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This is the **"Day Zero" Manifest**. Since you are deleting all tables and starting fresh, this single document serves as your entire blueprint—combining the physical folder hierarchy with the logical **SpacetimeDB** schema.
<!-- SECTION:DESCRIPTION:END -->

## 📂 Part 1: The Project Folder Structure
This design minimizes merge conflicts by separating the **Live Mind** (Database) from the **Static Assets** (Attachments) and the **Read-Only Mirrors** (Markdown).

```text
agentRoadmap/
├── product/                 # THE BRAIN: Strategic & Business Layer
│   ├── proposals/           # Read-only MD mirrors (Directives, RFCs, Caps)
│   └── attachments/         # STABLE BINARIES: Photos & Diagrams (Git LFS)
│       └── [Proposal_ID]/   # Sub-folder per Entity (e.g., RFC-101/)
│           ├── mockup.png
│           └── process_v1.pdf
├── infrastructure/          # THE BODY: Technical & Execution Layer
│   ├── src/                 # SpacetimeDB Rust modules (Reducers & Logic)
│   └── src/test/            # Rust-based Unit and Integration tests
├── ops/                     # THE EXHAUST: Maintenance & Log files
└── .gitignore               # Configured to track attachments/ via LFS
```

---

## 🛠️ Part 2: The Master DDL (Unified Entity Model v2.5)
This schema treats every element of your enterprise as a **Universal Proposal**. It includes the 9-stage lifecycle, Git-style versioning, Zero-Trust security, and multimedia support.

### **Execution Strategy**
1.  **Nuke the DB:** Run `spacetime delete [database_name]` and re-initialize.
2.  **Rust Migration:** Implement the above tables as `#[spacetimedb(table)]` structs in your `infrastructure/src/lib.rs`.
3.  **Mirror Sync:** Configure your background service to monitor the `proposal_version` table. Every time an entry is made, it should update the corresponding file in `product/proposals/[display_id].md`.
4.  **Attachment Protocol:** Always save images to `product/attachments/[display_id]/` first, then record the URI in SDB.

This gives you a conflict-free, version-controlled, multimedia-ready enterprise.

---

## 📝 3. Decision Log (The ADR)
* **Human Feedback:** `[Inputs from TUI/WebSash]`
* **Final Consensus:** `[Approved/Rejected reasoning]`
* **Snapshot Hash:** `[Git commit SHA or SDB log ID]`
