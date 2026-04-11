/**
 * Database Schema V2 - Agent-Native Product Platform
 * TypeScript types matching SpacetimeDB tables
 */

// ============= IDENTITY LAYER =============

export interface Agent {
  id: string;              // primary key
  name: string;
  role: 'researcher' | 'developer' | 'tester' | 'pm' | 'architect' | 'designer';
  personality_prompt: string;
  status: 'active' | 'frozen' | 'retired';
  created_at: number;      // unix timestamp ms
  updated_at: number;
}

export interface Team {
  id: string;
  name: string;
  lead_agent_id: string;   // FK → Agent
  created_at: number;
}

export interface TeamMember {
  team_id: string;         // FK → Team
  agent_id: string;        // FK → Agent
  joined_at: number;
}

// ============= WORK LAYER =============

export interface Decision {
  id: string;
  title: string;
  reasoning: string;
  proposer_id: string;     // FK → Agent
  status: 'proposed' | 'approved' | 'rejected' | 'implemented';
  proposal_id?: string;       // FK → Proposal (optional)
  voted_by: string[];      // JSON array of agent IDs
  created_at: number;
  decided_at?: number;
}

export interface Directive {
  id: string;
  content: string;
  issued_by: string;       // human identifier
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'pending' | 'acknowledged' | 'completed';
  related_proposal_id?: string;
  created_at: number;
  completed_at?: number;
}

export interface RFC {
  id: string;
  title: string;
  content: string;         // markdown
  author_id: string;       // FK → Agent
  status: 'drafting' | 'review' | 'debate' | 'approved' | 'rejected';
  decision_id?: string;    // FK → Decision
  created_at: number;
  updated_at: number;
}

// ============= MEMORY LAYER =============

export interface Memory {
  id: string;
  agent_id: string;        // FK → Agent
  content: string;
  embedding: number[];     // float array for vector search
  memory_type: 'working' | 'long_term' | 'episodic' | 'semantic';
  importance: number;      // 0.0 - 1.0
  created_at: number;
  last_accessed_at: number;
  access_count: number;
}

export interface MemoryRelation {
  id: string;
  from_memory_id: string;  // FK → Memory
  to_memory_id: string;    // FK → Memory
  relation_type: 'causes' | 'contradicts' | 'supports' | 'related_to';
  strength: number;        // 0.0 - 1.0
}

// ============= FINANCE LAYER =============

export interface Budget {
  id: string;
  name: string;
  total_usd: number;
  spent_usd: number;
  hard_limit_usd: number;
  status: 'active' | 'frozen' | 'exhausted';
}

export interface TokenLedger {
  id: string;
  agent_id: string;        // FK → Agent
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;   // for 90% savings tracking
  cost_usd: number;
  timestamp: number;
}

export interface BudgetAllocation {
  budget_id: string;       // FK → Budget
  agent_id: string;        // FK → Agent
  allocated_usd: number;
  spent_usd: number;
}

// ============= COMMUNICATION LAYER =============

export interface Channel {
  id: string;
  name: string;
  type: 'project' | 'squad' | 'dm' | 'broadcast';
  created_at: number;
}

export interface Message {
  id: string;
  channel_id: string;      // FK → Channel
  sender_id: string;       // FK → Agent
  content: string;
  message_type: 'text' | 'directive' | 'decision' | 'rfc';
  timestamp: number;
}

export interface Subscription {
  agent_id: string;        // FK → Agent
  channel_id: string;      // FK → Channel
  joined_at: number;
}

// ============= HELPER FUNCTIONS =============

/** Cosine similarity for vector search */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Find top-K similar memories */
export function findSimilarMemories(
  query: number[],
  memories: Memory[],
  topK: number = 5
): Memory[] {
  const scored = memories.map(m => ({
    memory: m,
    score: cosineSimilarity(query, m.embedding)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.memory);
}

/** Generate unique ID */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}
