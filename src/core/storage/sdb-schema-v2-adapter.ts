/**
 * TypeScript Adapter for Schema V2 Tables
 * Uses HTTP API to create tables and manage data
 */

import { SDB_CONFIG } from "../../constants/index.ts";

const DB_ID = SDB_CONFIG.DB_ID;
const SDB_URL = SDB_CONFIG.SDB_URL;

// Helper to call SQL
export async function executeSQL(sql: string): Promise<any> {
  const response = await fetch(`${SDB_URL}/v1/database/${DB_ID}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: sql,
  });
  return response.json();
}

// Helper to call reducer
export async function callReducer(name: string, args: any[]): Promise<void> {
  const response = await fetch(`${SDB_URL}/v1/database/${DB_ID}/call/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${name}: ${text}`);
  }
}

// Create tables (using SQL since Rust module doesn't compile)
export async function createV2Tables(): Promise<void> {
  const tables = [
    `CREATE TABLE IF NOT EXISTS agent (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      personality_prompt TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at INTEGER,
      updated_at INTEGER
    )`,
    
    `CREATE TABLE IF NOT EXISTS decision (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      reasoning TEXT DEFAULT '',
      proposer_id TEXT NOT NULL,
      status TEXT DEFAULT 'proposed',
      proposal_id TEXT,
      voted_by TEXT DEFAULT '[]',
      created_at INTEGER,
      decided_at INTEGER
    )`,
    
    `CREATE TABLE IF NOT EXISTS directive (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      issued_by TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      related_proposal_id TEXT,
      created_at INTEGER,
      completed_at INTEGER
    )`,
    
    `CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_type TEXT DEFAULT 'working',
      importance REAL DEFAULT 0.5,
      created_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0
    )`,
    
    `CREATE TABLE IF NOT EXISTS budget (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      total_usd REAL DEFAULT 0,
      spent_usd REAL DEFAULT 0,
      hard_limit_usd REAL DEFAULT 0,
      status TEXT DEFAULT 'active'
    )`,
    
    `CREATE TABLE IF NOT EXISTS token_ledger (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      model_name TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      timestamp INTEGER
    )`,
  ];
  
  for (const sql of tables) {
    try {
      await executeSQL(sql);
      console.log("✅ Created table");
    } catch (e: any) {
      console.log("Table:", e.message?.slice(0, 50));
    }
  }
}

// Insert agent
export async function createAgent(id: string, name: string, role: string): Promise<void> {
  await executeSQL(`INSERT OR REPLACE INTO agent (id, name, role, status, created_at, updated_at) 
    VALUES ('${id}', '${name}', '${role}', 'active', ${Date.now()}, ${Date.now()})`);
}

// Insert decision
export async function createDecision(id: string, title: string, reasoning: string, proposerId: string): Promise<void> {
  await executeSQL(`INSERT OR REPLACE INTO decision (id, title, reasoning, proposer_id, status, created_at) 
    VALUES ('${id}', '${title}', '${reasoning.replace(/'/g, "''")}', '${proposerId}', 'proposed', ${Date.now()})`);
}

// Insert directive
export async function createDirective(id: string, content: string, issuedBy: string, priority: string): Promise<void> {
  await executeSQL(`INSERT OR REPLACE INTO directive (id, content, issued_by, priority, status, created_at) 
    VALUES ('${id}', '${content.replace(/'/g, "''")}', '${issuedBy}', '${priority}', 'pending', ${Date.now()})`);
}

// Query helpers
export async function queryAgents(): Promise<any[]> {
  const result = await executeSQL("SELECT * FROM agent");
  return result.rows || [];
}

export async function queryDecisions(): Promise<any[]> {
  const result = await executeSQL("SELECT * FROM decision");
  return result.rows || [];
}

export async function queryDirectives(): Promise<any[]> {
  const result = await executeSQL("SELECT * FROM directive WHERE status = 'pending'");
  return result.rows || [];
}
