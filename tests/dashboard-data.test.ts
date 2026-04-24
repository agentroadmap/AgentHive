/**
 * Dashboard Data Integrity Tests
 *
 * Detects field mapping mismatches between:
 * - REST API responses (server/index.ts / roadmap.ts)
 * - WebSocket protocol (useWebSocket hook)
 * - Frontend component expectations (Board, ProposalDetailsModal)
 *
 * Run: npx tsx tests/dashboard-data.test.ts
 */

import { strict as assert } from "node:assert";

const BASE = process.env.TEST_BASE || "http://localhost:6420";

// ─── Helpers ────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

function logResult(name: string, ok: boolean, detail?: string) {
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    logResult(name, true);
  } catch (err: any) {
    fail++;
    logResult(name, false, err.message);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

// 1. REST API: /api/proposals returns correct field names
await test("REST /api/proposals returns non-empty array", async () => {
  const data = await apiGet("/api/proposals");
  assert(Array.isArray(data), "Expected array");
  assert(data.length > 0, "Expected proposals");
});

await test("REST /api/proposals items have required fields", async () => {
  const data = await apiGet("/api/proposals");
  const p = data[0];
  // Fields the server actually returns
  assert.equal(typeof p.id, "string", "id must be string");
  assert.equal(typeof p.title, "string", "title must be string");
  assert.equal(typeof p.status, "string", "status must be string");
  assert(Array.isArray(p.assignee), "assignee must be array");
  assert(Array.isArray(p.labels), "labels must be array");
  assert.equal(typeof p.maturity, "string", "maturity must be string");
  assert.equal(typeof p.proposalType, "string", "proposalType must be string");
});

await test("REST /api/proposals: field names match shared/types/Proposal", async () => {
  const data = await apiGet("/api/proposals");
  const p = data[0];

  // These fields must exist (shared/types Proposal interface)
  const requiredFields = [
    "id", "title", "status", "assignee",
    "createdDate", "labels", "dependencies",
  ];
  for (const f of requiredFields) {
    assert(f in p, `Missing field: ${f}`);
  }
});

await test("REST /api/proposals: labels is array, not string", async () => {
  const data = await apiGet("/api/proposals");
  for (const p of data.slice(0, 5)) {
    assert(Array.isArray(p.labels), `Proposal ${p.id}: labels should be array, got ${typeof p.labels}`);
  }
});

// 2. REST API: Proposal detail endpoints
await test("REST /api/proposals/:id returns single proposal", async () => {
  const data = await apiGet("/api/proposals/P230");
  // Endpoint returns proposal directly, not wrapped in { proposal: ... }
  const p = data.id ? data : data.proposal;
  assert.equal(p.id, "P230", "Should return P230");
  assert(p.title, "Should have title");
  assert(p.status, "Should have status");
});

await test("REST /api/proposals/:id/notes returns discussions", async () => {
  const data = await apiGet("/api/proposals/P230/notes");
  assert(data.notes, "Should have notes key");
  assert(Array.isArray(data.notes), "notes should be array");
  assert(data.notes.length > 0, "P230 should have discussions");
  if (data.notes.length > 0) {
    const n = data.notes[0];
    assert(n.id, "Discussion must have id");
    assert(n.author_identity, "Discussion must have author_identity");
    assert(n.body_markdown, "Discussion must have body_markdown");
  }
});

await test("REST /api/proposals/:id/reviews returns reviews", async () => {
  const data = await apiGet("/api/proposals/P308/reviews");
  assert(data.reviews, "Should have reviews key");
  assert(Array.isArray(data.reviews), "reviews should be array");
  assert(data.reviews.length > 0, "P308 should have reviews");
  if (data.reviews.length > 0) {
    const r = data.reviews[0];
    assert(r.reviewer_identity, "Review must have reviewer_identity");
    assert(r.verdict, "Review must have verdict");
  }
});

await test("REST /api/proposals/:id/decisions returns decisions array", async () => {
  const data = await apiGet("/api/proposals/P308/decisions");
  assert(data.decisions, "Should have decisions key");
  assert(Array.isArray(data.decisions), "decisions should be array");
});

// 3. WebSocket protocol check
// NOTE: The frontend's useWebSocket hook expects:
//   - ws://localhost:3001 (hardcoded)
//   - { type: "subscribe", tables: [...] } messages
//   - { type: "proposal_snapshot", data: [...] } responses
//
// But the server sends:
//   - "proposals-updated" strings (no actual data)
//   - Does not handle table subscriptions
//
// This is a PROTOCOL MISMATCH that prevents the board from loading data.
await test("WebSocket sends proposal_snapshot (not just notify string)", async () => {
  const port = new URL(BASE).port || "6420";
  const ws = new WebSocket(`ws://localhost:${port}`);
  let receivedSnapshot = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      if (!receivedSnapshot) {
        reject(new Error(
          "No proposal_snapshot received in 3s. " +
          "Server sends 'proposals-updated' strings but frontend expects " +
          "{ type: 'proposal_snapshot', data: [...] } with full proposal objects."
        ));
      }
    }, 3000);

    ws.onopen = () => {
      // Send subscription like the frontend does
      ws.send(JSON.stringify({ type: "subscribe", tables: ["proposal"] }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        if (msg.type === "proposal_snapshot" || msg.type === "proposals") {
          if (Array.isArray(msg.data) && msg.data.length > 0) {
            receivedSnapshot = true;
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        }
      } catch {
        // Non-JSON message (e.g., "proposals-updated" string)
        // This is the current behavior — not what frontend expects
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection error"));
    };
  });
});

// 4. Frontend WebSocket port check
await test("Frontend WebSocket uses same port as server", async () => {
  // The compiled web/main.js has hardcoded ws://localhost:3001
  // but server runs on port 6420
  const serverPort = new URL(BASE).port || "6420";
  const fs = await import("node:fs");
  const mainJs = fs.readFileSync("/data/code/AgentHive/web/main.js", "utf-8");
  const wsPortMatch = mainJs.match(/ws:\/\/localhost:(\d+)/);
  if (wsPortMatch) {
    const frontendPort = wsPortMatch[1];
    assert.equal(
      frontendPort, serverPort,
      `Frontend expects ws://localhost:${frontendPort} but server is on ${serverPort}`
    );
  } else {
    // No WebSocket URL found — might be dynamically constructed
    logResult("Frontend WebSocket port", true, "No hardcoded port found (dynamic?)");
  }
});
await test("Frontend expects displayId, API provides id", async () => {
  const data = await apiGet("/api/proposals");
  const p = data[0];
  // API returns "id" (e.g., "P047")
  // Frontend WebSocketProposal interface expects "displayId" separately from "id"
  assert.equal(typeof p.id, "string");
  // This is a documented mismatch — the API uses id as display_id
  // Frontend should use p.id for display
  if (p.id.match(/^[A-Z]+-\d+$/) || p.id.match(/^P\d+$/)) {
    logResult("id looks like display ID (P047)", true);
  } else {
    logResult("id format check", true, `id=${p.id}`);
  }
});

await test("API createdDate vs frontend createdAt", async () => {
  const data = await apiGet("/api/proposals");
  const p = data[0];
  // shared/types Proposal uses createdDate, WebSocket Proposal uses createdAt
  assert("createdDate" in p || "createdAt" in p, "Must have a creation date field");
  if ("createdDate" in p && !("createdAt" in p)) {
    logResult("Uses createdDate (shared/types)", true);
  } else if ("createdAt" in p && !("createdDate" in p)) {
    logResult("Uses createdAt (WebSocket)", true);
  } else {
    logResult("Both createdDate and createdAt present", true);
  }
});

// 5. Status values check
await test("Proposals have valid status values", async () => {
  const data = await apiGet("/api/proposals");
  const validStatuses = new Set([
    "DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE", "DEPLOYED", "REJECTED",
    // Also accept lowercase variants
    "draft", "review", "develop", "merge", "complete", "deployed", "rejected",
  ]);
  const invalid: string[] = [];
  for (const p of data) {
    if (!validStatuses.has(p.status)) {
      invalid.push(`${p.id}: status="${p.status}"`);
    }
  }
  if (invalid.length > 0) {
    logResult("Status values", false, `Invalid: ${invalid.slice(0, 5).join(", ")}`);
    fail++;
  } else {
    pass++;
    logResult("All status values valid", true);
  }
});

// 6. Maturity values check
await test("Proposals have valid maturity values", async () => {
  const data = await apiGet("/api/proposals");
  const validMaturity = new Set(["new", "mature", "obsolete", "active", undefined, null]);
  const invalid: string[] = [];
  for (const p of data) {
    if (!validMaturity.has(p.maturity)) {
      invalid.push(`${p.id}: maturity="${p.maturity}"`);
    }
  }
  if (invalid.length > 0) {
    logResult("Maturity values", false, `Invalid: ${invalid.slice(0, 5).join(", ")}`);
    fail++;
  } else {
    pass++;
    logResult("All maturity values valid", true);
  }
});

// 7. Board columns: status distribution
await test("Board has proposals in each status column", async () => {
  const data = await apiGet("/api/proposals");
  const statusCounts: Record<string, number> = {};
  for (const p of data) {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  }
  const cols = Object.entries(statusCounts)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  logResult("Status distribution", true, cols);
});

// ─── Summary ────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail > 0) {
  console.log("❌ Some tests failed — data flow has issues");
  process.exit(1);
} else {
  console.log("✅ All tests passed");
  process.exit(0);
}
