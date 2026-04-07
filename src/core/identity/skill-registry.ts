/**
 * STATE-40: Skill Registry & Auto-Discovery
 *
 * Centralized registry where agents publish and discover capabilities.
 * Agents register their skills, tools, and availability. Other agents
 * can search for the right specialist to collaborate with.
 *
 * AC#1: Agents can register skills via MCP 'skill_register' tool
 * AC#2: Agent profiles list all registered skills
 * AC#3: Other agents can query and filter by skill
 * AC#4: Skills persist across sessions in SQLite
 * AC#5: Skill match scoring ranks agents by capability fit
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// SQLite removed

/** A single skill that an agent can perform */
export interface Skill {
	/** Unique skill identifier (e.g., "typescript", "react", "testing") */
	id: string;
	/** Human-readable skill name */
	name: string;
	/** Skill category (e.g., "language", "framework", "tool", "domain") */
	category: SkillCategory;
	/** Proficiency level */
	level: SkillLevel;
	/** Optional description */
	description?: string;
	/** Related skill IDs */
	relatedSkills?: string[];
}

export type SkillCategory =
	| "language"
	| "framework"
	| "tool"
	| "domain"
	| "testing"
	| "infrastructure"
	| "design"
	| "other";

export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

/** Agent capability profile */
export interface AgentProfile {
	/** Agent identifier */
	agentId: string;
	/** Agent display name */
	name: string;
	/** Registered skills with proficiency levels */
	skills: Skill[];
	/** Tools the agent can use */
	tools: string[];
	/** Whether agent is available for work */
	available: boolean;
	/** When the profile was created */
	createdAt: string;
	/** When the profile was last updated */
	updatedAt: string;
	/** Optional metadata */
	metadata?: Record<string, unknown>;
}

/** Search query for finding agents by skill */
export interface SkillSearchQuery {
	/** Required skill IDs */
	requiredSkills?: string[];
	/** Minimum skill level required */
	minLevel?: SkillLevel;
	/** Skill categories to filter by */
	categories?: SkillCategory[];
	/** Only search available agents */
	availableOnly?: boolean;
	/** Maximum results */
	limit?: number;
}

/** Result of a skill match search */
export interface SkillMatch {
	/** The matched agent */
	profile: AgentProfile;
	/** Match score (0-100) */
	score: number;
	/** Skills that matched */
	matchedSkills: Skill[];
	/** Required skills that were missing */
	missingSkills: string[];
}

const DB_FILENAME = "skill-registry.db";

/**
 * Skill Registry for agent capability management and discovery.
 */
export class SkillRegistry {
	private db: DatabaseSync | null = null;
	private dbPath: string;
	private projectRoot: string;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		const roadmapDir = join(projectRoot, "roadmap");
		this.dbPath = join(roadmapDir, ".cache", DB_FILENAME);
	}

	/**
	 * Initialize the database connection and schema.
	 */
	private ensureInitialized(): void {
		if (this.db) return;

		const dir = join(this.projectRoot, "roadmap", ".cache");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.db = new DatabaseSync(this.dbPath);
		this.initializeSchema();
	}

	/**
	 * Create database tables if they don't exist.
	 */
	private initializeSchema(): void {
		if (!this.db) return;

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS agents (
				agent_id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				available INTEGER DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				metadata TEXT
			);

			CREATE TABLE IF NOT EXISTS agent_skills (
				agent_id TEXT NOT NULL,
				skill_id TEXT NOT NULL,
				name TEXT NOT NULL,
				category TEXT NOT NULL,
				level TEXT NOT NULL,
				description TEXT,
				related_skills TEXT,
				PRIMARY KEY (agent_id, skill_id),
				FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS agent_tools (
				agent_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				PRIMARY KEY (agent_id, tool_name),
				FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_agent_skills_skill_id ON agent_skills(skill_id);
			CREATE INDEX IF NOT EXISTS idx_agent_skills_category ON agent_skills(category);
			CREATE INDEX IF NOT EXISTS idx_agent_skills_level ON agent_skills(level);
			CREATE INDEX IF NOT EXISTS idx_agents_available ON agents(available);
		`);
	}

	/**
	 * AC#1: Register or update an agent's skills.
	 */
	registerAgent(profile: AgentProfile): void {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const now = new Date().toISOString();

		// Upsert agent
		this.db
			.prepare(`
			INSERT INTO agents (agent_id, name, available, created_at, updated_at, metadata)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(agent_id) DO UPDATE SET
				name = excluded.name,
				available = excluded.available,
				updated_at = excluded.updated_at,
				metadata = excluded.metadata
		`)
			.run(
				profile.agentId,
				profile.name,
				profile.available ? 1 : 0,
				profile.createdAt || now,
				now,
				profile.metadata ? JSON.stringify(profile.metadata) : null,
			);

		// Replace skills
		this.db
			.prepare("DELETE FROM agent_skills WHERE agent_id = ?")
			.run(profile.agentId);

		const insertSkill = this.db.prepare(`
			INSERT INTO agent_skills (agent_id, skill_id, name, category, level, description, related_skills)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

		for (const skill of profile.skills) {
			insertSkill.run(
				profile.agentId,
				skill.id,
				skill.name,
				skill.category,
				skill.level,
				skill.description || null,
				skill.relatedSkills ? JSON.stringify(skill.relatedSkills) : null,
			);
		}

		// Replace tools
		this.db
			.prepare("DELETE FROM agent_tools WHERE agent_id = ?")
			.run(profile.agentId);

		const insertTool = this.db.prepare(
			"INSERT INTO agent_tools (agent_id, tool_name) VALUES (?, ?)",
		);
		for (const tool of profile.tools || []) {
			insertTool.run(profile.agentId, tool);
		}
	}

	/**
	 * AC#2: Get an agent's profile with all registered skills.
	 */
	getAgentProfile(agentId: string): AgentProfile | null {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const agentRow = this.db
			.prepare("SELECT * FROM agents WHERE agent_id = ?")
			.get(agentId) as any;
		if (!agentRow) return null;

		return this.hydrateAgent(agentRow);
	}

	/**
	 * List all registered agent profiles.
	 */
	listAgents(options?: { availableOnly?: boolean }): AgentProfile[] {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const query = options?.availableOnly
			? "SELECT * FROM agents WHERE available = 1"
			: "SELECT * FROM agents";

		const rows = this.db.prepare(query).all() as any[];
		return rows.map((row) => this.hydrateAgent(row));
	}

	/**
	 * Hydrate an agent row into a full profile.
	 */
	private hydrateAgent(row: any): AgentProfile {
		const skillRows = this.db
			?.prepare("SELECT * FROM agent_skills WHERE agent_id = ?")
			.all(row.agent_id) as any[];

		const toolRows = this.db
			?.prepare("SELECT tool_name FROM agent_tools WHERE agent_id = ?")
			.all(row.agent_id) as any[];

		return {
			agentId: row.agent_id,
			name: row.name,
			available: row.available === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			skills: skillRows.map((sr) => ({
				id: sr.skill_id,
				name: sr.name,
				category: sr.category as SkillCategory,
				level: sr.level as SkillLevel,
				description: sr.description || undefined,
				relatedSkills: sr.related_skills
					? JSON.parse(sr.related_skills)
					: undefined,
			})),
			tools: toolRows.map((tr) => tr.tool_name),
		};
	}

	/**
	 * AC#3: Search for agents by skill.
	 */
	searchBySkill(query: SkillSearchQuery): SkillMatch[] {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const levelOrder: Record<SkillLevel, number> = {
			beginner: 1,
			intermediate: 2,
			advanced: 3,
			expert: 4,
		};

		const minLevelNum = query.minLevel ? levelOrder[query.minLevel] : 0;

		// Get candidate agent IDs first
		let agentIds: string[];

		if (query.categories?.length) {
			// Filter by category - get agents who have skills in those categories
			const placeholders = query.categories.map(() => "?").join(",");
			const rows = this.db
				.prepare(`
				SELECT DISTINCT agent_id FROM agent_skills WHERE category IN (${placeholders})
			`)
				.all(...query.categories) as any[];
			agentIds = rows.map((r) => r.agent_id);
		} else {
			// Get all agents
			const rows = this.db
				.prepare("SELECT agent_id FROM agents")
				.all() as any[];
			agentIds = rows.map((r) => r.agent_id);
		}

		// Filter by availability
		if (query.availableOnly) {
			const availableRows = this.db
				.prepare("SELECT agent_id FROM agents WHERE available = 1")
				.all() as any[];
			const availableIds = new Set(availableRows.map((r) => r.agent_id));
			agentIds = agentIds.filter((id) => availableIds.has(id));
		}

		// Hydrate and score candidates
		const matches: SkillMatch[] = [];

		for (const agentId of agentIds) {
			const profile = this.getAgentProfile(agentId);
			if (!profile) continue;

			const matchedSkills: Skill[] = [];
			const missingSkills: string[] = [];
			let score = 0;
			let hasAllRequired = true;

			// Check required skills
			if (query.requiredSkills?.length) {
				for (const reqSkillId of query.requiredSkills) {
					const found = profile.skills.find(
						(s) => s.id === reqSkillId || s.id.includes(reqSkillId),
					);

					if (found) {
						// Check level
						if (levelOrder[found.level] >= minLevelNum) {
							matchedSkills.push(found);
							// Score based on level
							score += levelOrder[found.level] * 25;
						} else {
							missingSkills.push(reqSkillId);
							hasAllRequired = false;
						}
					} else {
						missingSkills.push(reqSkillId);
						hasAllRequired = false;
					}
				}

				// Penalize missing required skills
				score -= missingSkills.length * 30;

				// Skip agents missing required skills (only show if they have at least one match)
				if (!hasAllRequired && matchedSkills.length === 0) {
					continue;
				}
			} else {
				// No specific requirements - score based on total skill level
				for (const skill of profile.skills) {
					score += levelOrder[skill.level] * 10;
				}
			}

			// Bonus for availability
			if (profile.available) {
				score += 10;
			}

			// Normalize to 0-100
			score = Math.max(0, Math.min(100, score));

			matches.push({
				profile,
				score,
				matchedSkills,
				missingSkills,
			});
		}

		// Sort by score descending
		matches.sort((a, b) => b.score - a.score);

		// Apply limit
		if (query.limit) {
			return matches.slice(0, query.limit);
		}

		return matches;
	}

	/**
	 * AC#4: Skills persist in SQLite (already handled by schema).
	 * This method provides a way to check persistence.
	 */
	isPersistent(): boolean {
		return existsSync(this.dbPath);
	}

	/**
	 * Get all unique skill IDs registered in the system.
	 */
	getAllSkills(): Array<{
		skillId: string;
		name: string;
		category: SkillCategory;
		agentCount: number;
	}> {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const rows = this.db
			.prepare(`
			SELECT skill_id, name, category, COUNT(*) as agent_count
			FROM agent_skills
			GROUP BY skill_id, name, category
			ORDER BY agent_count DESC
		`)
			.all() as any[];

		return rows.map((r) => ({
			skillId: r.skill_id,
			name: r.name,
			category: r.category as SkillCategory,
			agentCount: r.agent_count,
		}));
	}

	/**
	 * Remove an agent from the registry.
	 */
	removeAgent(agentId: string): boolean {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const result = this.db
			.prepare("DELETE FROM agents WHERE agent_id = ?")
			.run(agentId);
		return result.changes > 0;
	}

	/**
	 * Update agent availability status.
	 */
	setAvailability(agentId: string, available: boolean): boolean {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const result = this.db
			.prepare(
				"UPDATE agents SET available = ?, updated_at = ? WHERE agent_id = ?",
			)
			.run(available ? 1 : 0, new Date().toISOString(), agentId);

		return result.changes > 0;
	}

	/**
	 * Get statistics about the skill registry.
	 */
	getStats(): {
		totalAgents: number;
		availableAgents: number;
		totalSkills: number;
		uniqueSkillTypes: number;
		averageSkillsPerAgent: number;
	} {
		this.ensureInitialized();
		if (!this.db) throw new Error("Database not initialized");

		const agentCount = (
			this.db.prepare("SELECT COUNT(*) as c FROM agents").get() as any
		).c;
		const availableCount = (
			this.db
				.prepare("SELECT COUNT(*) as c FROM agents WHERE available = 1")
				.get() as any
		).c;
		const skillCount = (
			this.db.prepare("SELECT COUNT(*) as c FROM agent_skills").get() as any
		).c;
		const uniqueSkills = (
			this.db
				.prepare("SELECT COUNT(DISTINCT skill_id) as c FROM agent_skills")
				.get() as any
		).c;

		return {
			totalAgents: agentCount,
			availableAgents: availableCount,
			totalSkills: skillCount,
			uniqueSkillTypes: uniqueSkills,
			averageSkillsPerAgent:
				agentCount > 0 ? Math.round((skillCount / agentCount) * 10) / 10 : 0,
		};
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}

/**
 * Create a skill registry for a project.
 */
export function createSkillRegistry(projectRoot: string): SkillRegistry {
	return new SkillRegistry(projectRoot);
}
