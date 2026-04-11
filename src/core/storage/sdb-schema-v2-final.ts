/**
 * SpacetimeDB Schema V2.5 Master - agentRoadmap
 * Aligned with roadmap/dataModel/schema_v2.1.ddl
 */

export interface Proposal {
    id: number;
    display_id: string;
    parent_id?: number;   // Hierarchy glue (Parent Directive -> Child RFC)
    
    // Discriminators
    proposal_type: string;          // DIRECTIVE, CAPABILITY, TECHNICAL, COMPONENT, OPS_ISSUE
    category: string;               // FEATURE, BUG, RESEARCH, SECURITY, INFRA
    
    // Strategic Context
    domain_id: string;              // Business silo (e.g., 'FINOPS', 'ENGINE')
    title: string;
    status: string;                 // New, Draft, Review, Active, Accepted, Complete, Rejected
    priority: string;               // Strategic, High, Medium, Low
    
    // Content & Logic
    body_markdown?: string;         // The primary text (Idea, RFC Spec, or Issue details)
    process_logic?: string;         // Descriptive business process for Directives
    maturity_level?: number;        // 1-5 (For CAPABILITY and COMPONENT types)
    repository_path?: string;       // Physical Git path (For COMPONENT/SRC types)
    
    // Economics & Search
    budget_limit_usd: number;
    tags?: string;                  // JSON/Comma-separated metadata
    
    created_at: number;
    updated_at: number;
}

export interface ProposalVersion {
    id: number;
    proposal_id: number;
    author_identity: string;
    version_number: number;
    change_summary: string;
    body_delta?: string;
    metadata_delta_json: string;
    git_commit_sha?: string;
    timestamp: number;
}

export interface ProposalCriteria {
    id: number;
    proposal_id: number;
    description: string;
    is_verified: boolean;
}

export interface ProposalDecision {
    id: number;
    proposal_id: number;
    title: string;
    decision_summary: string;
    rationale: string;
    status: string;
    created_at: number;
}

export interface AttachmentRegistry {
    id: number;
    proposal_id: number;
    display_id: string;
    file_name: string;
    relative_path: string;
    file_type: string;
    content_hash: string;
    vision_summary?: string;
    timestamp: number;
}

export interface WorkforceRegistry {
    identity: string;
    agent_id: string;
    role: string;
    is_active: boolean;
}

export interface WorkforcePulse {
    identity: string;
    active_proposal_id?: number;
    last_seen_at: number;
    status_message: string;
    is_zombie: boolean;
}

export interface SpendingCaps {
    agent_identity: string;
    daily_limit_usd: number;
    total_spent_today_usd: number;
    is_frozen: boolean;
}

export interface SpendingLog {
    id: number;
    proposal_id: number;
    agent_identity: string;
    cost_usd: number;
    timestamp: number;
}

export interface SecurityAcl {
    id: number;
    agent_identity: string;
    target_proposal_id: number;
    permission_id: string;
}

export interface SecurityAuditLog {
    id: number;
    actor_identity: string;
    action: string;
    severity: string;
    timestamp: number;
}

export interface AgentMemory {
    id: number;
    agent_identity: string;
    scope_proposal_id: number;
    key: string;
    val: string;
    updated_at: number;
}

export interface MessageLedger {
    id: number;
    channel_name: string;
    sender_identity: string;
    content: string;
    timestamp: number;
}
