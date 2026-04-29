/**
 * STATE-47: Agent Knowledge Base & Documentation
 *
 * Centralized knowledge base where agents can search for solutions, patterns, and past decisions.
 * Builds collective intelligence over time.
 *
 * AC#1: Agents can search past solutions by keywords
 * AC#2: Common patterns extracted and indexed
 * AC#3: Decisions and rationales recorded
 * AC#4: Knowledge base accessible via MCP tool
 */

import { query } from "../../infra/postgres/pool.ts";

/** Types of knowledge entries */
export type KnowledgeEntryType =
	| "solution"
	| "pattern"
	| "decision"
	| "obstacle"
	| "learned";

/** A knowledge base entry */
export interface KnowledgeEntry {
	/** Unique identifier */
	id: string;
	/** Entry type */
	type: KnowledgeEntryType;
	/** Title */
	title: string;
	/** Full description/solution text */
	content: string;
	/** Keywords for search */
	keywords: string[];
	/** Related proposal IDs */
	relatedProposals: string[];
	/** Source proposal ID (if derived from a proposal) */
	sourceProposalId?: string;
	/** Author agent */
	author: string;
	/** Confidence level (0-100) */
	confidence: number;
	/** Number of times this entry was helpful (upvotes) */
	helpfulCount: number;
	/** Number of times this entry was referenced */
	referenceCount: number;
	/** Tags for categorization */
	tags: string[];
	/** When created */
	createdAt: string;
	/** When last updated */
	updatedAt: string;
	/** Optional metadata */
	metadata?: Record<string, unknown>;
}

/** Search query for knowledge base */
export interface KnowledgeSearchQuery {
	/** Search keywords (fuzzy match) */
	keywords: string[];
	/** Optional 1536-dim embedding for cosine similarity search (AC#9) */
	embedding?: number[];
	/** Minimum cosine similarity threshold when embedding is provided (default 0.5) */
	similarityThreshold?: number;
	/** Filter by entry type */
	type?: KnowledgeEntryType;
	/** Filter by tags */
	tags?: string[];
	/** Minimum confidence score */
	minConfidence?: number;
	/** Related to specific proposal */
	relatedProposal?: string;
	/** Maximum results */
	limit?: number;
}

/** Result of a knowledge search */
export interface KnowledgeSearchResult {
	/** The matched entry */
	entry: KnowledgeEntry;
	/** Relevance score (0-100) */
	relevanceScore: number;
	/** Matching keywords */
	matchedKeywords: string[];
}

/** Pattern extracted from solutions */
export interface ExtractedPattern {
	/** Pattern identifier */
	id: string;
	/** Pattern name */
	name: string;
	/** Pattern description */
	description: string;
	/** Code example or implementation */
	codeExample?: string;
	/** When this pattern was first observed */
	firstSeenAt: string;
	/** Number of times pattern was used */
	usageCount: number;
	/** Success rate when using this pattern (0-100) */
	successRate: number;
	/** Related entry IDs */
	relatedEntries: string[];
}

/**
 * Knowledge Base for collective agent intelligence.
 * Backed by Postgres — tables are created by a separate migration.
 */
export class KnowledgeBase {
	constructor(private readonly projectRoot: string) {}

	/**
	 * Generate a unique entry ID.
	 */
	private generateId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).substring(2, 8);
		return `KB-${timestamp}-${random}`;
	}

	/**
	 * AC#1: Add a knowledge entry (solution, pattern, decision, etc.)
	 */
	async addEntry(
		entry: Omit<
			KnowledgeEntry,
			"id" | "createdAt" | "updatedAt" | "helpfulCount" | "referenceCount"
		>,
	): Promise<KnowledgeEntry> {
		const now = new Date().toISOString();
		const id = this.generateId();

		const fullEntry: KnowledgeEntry = {
			...entry,
			id,
			createdAt: now,
			updatedAt: now,
			helpfulCount: 0,
			referenceCount: 0,
		};

		await query(
			`INSERT INTO knowledge_entries
				(id, type, title, content, keywords, related_proposals, source_proposal_id, author,
				 confidence, helpful_count, reference_count, tags, created_at, updated_at, metadata)
			VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15::jsonb)`,
			[
				fullEntry.id,
				fullEntry.type,
				fullEntry.title,
				fullEntry.content,
				JSON.stringify(fullEntry.keywords),
				JSON.stringify(fullEntry.relatedProposals),
				fullEntry.sourceProposalId ?? null,
				fullEntry.author,
				fullEntry.confidence,
				fullEntry.helpfulCount,
				fullEntry.referenceCount,
				JSON.stringify(fullEntry.tags),
				fullEntry.createdAt,
				fullEntry.updatedAt,
				fullEntry.metadata ? JSON.stringify(fullEntry.metadata) : null,
			],
		);

		return fullEntry;
	}

	/**
	 * AC#1 + AC#9: Search knowledge base by keywords and/or embedding vector.
	 *
	 * When `embedding` is provided, performs cosine-similarity ranking against
	 * `knowledge_entries.embedding` (added by migration 060). Falls back to
	 * ILIKE text search when no embedding is supplied.
	 */
	async search(
		searchQuery: KnowledgeSearchQuery,
	): Promise<KnowledgeSearchResult[]> {
		const limit = searchQuery.limit ?? 20;

		// AC#9: vector path — cosine similarity when caller supplies an embedding
		if (searchQuery.embedding && searchQuery.embedding.length === 1536) {
			const threshold = searchQuery.similarityThreshold ?? 0.5;
			let paramIndex = 1;
			const params: unknown[] = [];

			const vecIdx = paramIndex++;
			params.push(JSON.stringify(searchQuery.embedding));

			const conditions: string[] = [
				`embedding IS NOT NULL`,
				`1 - (embedding <=> $${vecIdx}::vector(1536)) >= ${threshold}`,
			];

			if (searchQuery.type) {
				conditions.push(`type = $${paramIndex++}`);
				params.push(searchQuery.type);
			}
			if (searchQuery.minConfidence !== undefined) {
				conditions.push(`confidence >= $${paramIndex++}`);
				params.push(searchQuery.minConfidence);
			}
			if (searchQuery.relatedProposal) {
				conditions.push(`related_proposals::text ILIKE $${paramIndex++}`);
				params.push(`%${searchQuery.relatedProposal}%`);
			}

			params.push(limit);
			const sql = `SELECT *, 1 - (embedding <=> $1::vector(1536)) AS _similarity
			             FROM knowledge_entries
			             WHERE ${conditions.join(" AND ")}
			             ORDER BY _similarity DESC
			             LIMIT $${paramIndex}`;

			const result = await query(sql, params);
			return result.rows.map((row: any) => {
				const entry = this.hydrateEntry(row);
				const matchedKeywords = searchQuery.keywords.filter(
					(k) =>
						entry.keywords.some((ek) =>
							ek.toLowerCase().includes(k.toLowerCase()),
						) ||
						entry.title.toLowerCase().includes(k.toLowerCase()) ||
						entry.content.toLowerCase().includes(k.toLowerCase()),
				);
				const similarity = Number(row._similarity ?? 0);
				const relevanceScore = Math.min(
					100,
					Math.round(similarity * 50 + matchedKeywords.length * 10 + entry.confidence / 5),
				);
				return { entry, relevanceScore, matchedKeywords };
			});
		}

		// Keyword / ILIKE text path
		const likeTerms = searchQuery.keywords.map((k) => `%${k}%`);
		const likeClause = likeTerms
			.map(
				(_, i) =>
					`(title ILIKE $${i + 1} OR content ILIKE $${i + 1} OR keywords::text ILIKE $${i + 1})`,
			)
			.join(" OR ");

		let paramIndex = likeTerms.length + 1;
		const params: unknown[] = [...likeTerms];

		let sql = `SELECT * FROM knowledge_entries WHERE (${likeClause})`;

		if (searchQuery.type) {
			sql += ` AND type = $${paramIndex++}`;
			params.push(searchQuery.type);
		}

		if (searchQuery.minConfidence !== undefined) {
			sql += ` AND confidence >= $${paramIndex++}`;
			params.push(searchQuery.minConfidence);
		}

		if (searchQuery.relatedProposal) {
			sql += ` AND related_proposals::text ILIKE $${paramIndex++}`;
			params.push(`%${searchQuery.relatedProposal}%`);
		}

		sql += ` ORDER BY confidence DESC, helpful_count DESC`;
		sql += ` LIMIT $${paramIndex++}`;
		params.push(limit);

		const result = await query(sql, params);

		return result.rows.map((row: any) => {
			const entry = this.hydrateEntry(row);
			const matchedKeywords = searchQuery.keywords.filter(
				(k) =>
					entry.keywords.some((ek) =>
						ek.toLowerCase().includes(k.toLowerCase()),
					) ||
					entry.title.toLowerCase().includes(k.toLowerCase()) ||
					entry.content.toLowerCase().includes(k.toLowerCase()),
			);

			const relevanceScore = Math.min(
				100,
				Math.max(0, 50 + matchedKeywords.length * 10 + entry.confidence / 5),
			);

			return { entry, relevanceScore, matchedKeywords };
		});
	}

	/**
	 * AC#2: Extract and store a pattern from successful solutions.
	 */
	async addPattern(
		pattern: Omit<ExtractedPattern, "id" | "usageCount" | "successRate">,
	): Promise<ExtractedPattern> {
		const id = `PAT-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;

		const fullPattern: ExtractedPattern = {
			...pattern,
			id,
			usageCount: 0,
			successRate: 0,
		};

		await query(
			`INSERT INTO extracted_patterns
				(id, name, description, code_example, first_seen_at, usage_count, success_rate, related_entries)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
			[
				fullPattern.id,
				fullPattern.name,
				fullPattern.description,
				fullPattern.codeExample ?? null,
				fullPattern.firstSeenAt,
				fullPattern.usageCount,
				fullPattern.successRate,
				JSON.stringify(fullPattern.relatedEntries),
			],
		);

		return fullPattern;
	}

	/**
	 * Alias for addPattern — kept so callers using the old name still work.
	 */
	async extractPattern(
		pattern: Omit<ExtractedPattern, "id" | "usageCount" | "successRate">,
	): Promise<ExtractedPattern> {
		return this.addPattern(pattern);
	}

	/**
	 * AC#2: Get all extracted patterns.
	 */
	async getPatterns(options?: {
		minUsageCount?: number;
		minSuccessRate?: number;
	}): Promise<ExtractedPattern[]> {
		let paramIndex = 1;
		const params: unknown[] = [];
		let sql = `SELECT * FROM extracted_patterns WHERE 1=1`;

		if (options?.minUsageCount !== undefined) {
			sql += ` AND usage_count >= $${paramIndex++}`;
			params.push(options.minUsageCount);
		}

		if (options?.minSuccessRate !== undefined) {
			sql += ` AND success_rate >= $${paramIndex++}`;
			params.push(options.minSuccessRate);
		}

		sql += ` ORDER BY usage_count DESC, success_rate DESC`;

		const result = await query(sql, params);
		return result.rows.map((row: any) => this.hydratePattern(row));
	}

	/**
	 * AC#3: Record a decision with rationale.
	 */
	async recordDecision(decision: {
		title: string;
		content: string;
		rationale: string;
		alternatives: string[];
		author: string;
		relatedProposalId?: string;
		tags?: string[];
	}): Promise<KnowledgeEntry> {
		return this.addEntry({
			type: "decision",
			title: decision.title,
			content: `## Rationale\n${decision.rationale}\n\n## Decision\n${decision.content}\n\n## Alternatives Considered\n${decision.alternatives.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
			keywords: [
				decision.title.toLowerCase(),
				...decision.title.split(/\s+/).map((w) => w.toLowerCase()),
			],
			relatedProposals: decision.relatedProposalId
				? [decision.relatedProposalId]
				: [],
			sourceProposalId: decision.relatedProposalId,
			author: decision.author,
			confidence: 80,
			tags: ["decision", ...(decision.tags || [])],
		});
	}

	/**
	 * AC#3: Get all decisions.
	 */
	async getDecisions(options?: {
		relatedProposal?: string;
	}): Promise<KnowledgeEntry[]> {
		let paramIndex = 1;
		const params: unknown[] = [];
		let sql = `SELECT * FROM knowledge_entries WHERE type = 'decision'`;

		if (options?.relatedProposal) {
			sql += ` AND related_proposals::text ILIKE $${paramIndex++}`;
			params.push(`%${options.relatedProposal}%`);
		}

		sql += ` ORDER BY created_at DESC`;

		const result = await query(sql, params);
		return result.rows.map((row: any) => this.hydrateEntry(row));
	}

	/**
	 * Mark an entry as helpful (upvote).
	 */
	async markHelpful(entryId: string): Promise<boolean> {
		const result = await query(
			`UPDATE knowledge_entries SET helpful_count = helpful_count + 1, updated_at = $1 WHERE id = $2`,
			[new Date().toISOString(), entryId],
		);
		return (result.rowCount ?? 0) > 0;
	}

	/**
	 * Increment the helpful count for an entry (alias matching required interface).
	 */
	async incrementHelpful(id: string): Promise<void> {
		await this.markHelpful(id);
	}

	/**
	 * Increment reference count when entry is used.
	 */
	async incrementReference(entryId: string): Promise<void> {
		await query(
			`UPDATE knowledge_entries SET reference_count = reference_count + 1, updated_at = $1 WHERE id = $2`,
			[new Date().toISOString(), entryId],
		);
	}

	/**
	 * Update pattern usage stats.
	 */
	async updatePatternUsage(
		patternId: string,
		successful: boolean,
	): Promise<void> {
		const patResult = await query(
			`SELECT * FROM extracted_patterns WHERE id = $1`,
			[patternId],
		);
		if (patResult.rows.length === 0) return;

		const pattern = patResult.rows[0] as any;
		const newUsageCount = pattern.usage_count + 1;
		const currentSuccessTotal =
			(pattern.success_rate * pattern.usage_count) / 100;
		const newSuccessTotal = currentSuccessTotal + (successful ? 1 : 0);
		const newSuccessRate = Math.round((newSuccessTotal / newUsageCount) * 100);

		await query(
			`UPDATE extracted_patterns SET usage_count = $1, success_rate = $2 WHERE id = $3`,
			[newUsageCount, newSuccessRate, patternId],
		);
	}

	/**
	 * Get an entry by ID.
	 */
	async getEntry(entryId: string): Promise<KnowledgeEntry | null> {
		const result = await query(
			`SELECT * FROM knowledge_entries WHERE id = $1`,
			[entryId],
		);
		return result.rows.length > 0 ? this.hydrateEntry(result.rows[0]) : null;
	}

	/**
	 * Update an entry by ID with partial fields.
	 */
	async updateEntry(
		id: string,
		updates: Partial<Omit<KnowledgeEntry, "id" | "createdAt">>,
	): Promise<KnowledgeEntry | null> {
		const existing = await this.getEntry(id);
		if (!existing) return null;

		const merged: KnowledgeEntry = {
			...existing,
			...updates,
			id,
			updatedAt: new Date().toISOString(),
		};

		await query(
			`UPDATE knowledge_entries SET
				type = $1, title = $2, content = $3,
				keywords = $4::jsonb, related_proposals = $5::jsonb,
				source_proposal_id = $6, author = $7, confidence = $8,
				helpful_count = $9, reference_count = $10,
				tags = $11::jsonb, updated_at = $12, metadata = $13::jsonb
			WHERE id = $14`,
			[
				merged.type,
				merged.title,
				merged.content,
				JSON.stringify(merged.keywords),
				JSON.stringify(merged.relatedProposals),
				merged.sourceProposalId ?? null,
				merged.author,
				merged.confidence,
				merged.helpfulCount,
				merged.referenceCount,
				JSON.stringify(merged.tags),
				merged.updatedAt,
				merged.metadata ? JSON.stringify(merged.metadata) : null,
				id,
			],
		);

		return merged;
	}

	/**
	 * Get entries by source proposal.
	 */
	async getEntriesByProposal(proposalId: string): Promise<KnowledgeEntry[]> {
		const result = await query(
			`SELECT * FROM knowledge_entries
			WHERE source_proposal_id = $1 OR related_proposals::text ILIKE $2
			ORDER BY created_at DESC`,
			[proposalId, `%${proposalId}%`],
		);
		return result.rows.map((row: any) => this.hydrateEntry(row));
	}

	/**
	 * Get statistics about the knowledge base.
	 * AC#11: Includes low-helpfulness entries (helpful_count=0 AND age > 30 days).
	 */
	async getStats(): Promise<{
		totalEntries: number;
		entriesByType: Record<KnowledgeEntryType, number>;
		totalPatterns: number;
		averageConfidence: number;
		topContributors: Array<{ author: string; count: number }>;
		mostHelpful: Array<{ id: string; title: string; helpfulCount: number }>;
		lowHelpfulness: Array<{ id: string; title: string; ageDays: number }>;
	}> {
		const [totalRes, patternRes, avgRes, typeRes, contribRes, helpfulRes, lowHelpRes] =
			await Promise.all([
				query(`SELECT COUNT(*) AS c FROM knowledge_entries`),
				query(`SELECT COUNT(*) AS c FROM extracted_patterns`),
				query(`SELECT AVG(confidence) AS avg FROM knowledge_entries`),
				query(
					`SELECT type, COUNT(*) AS count FROM knowledge_entries GROUP BY type`,
				),
				query(
					`SELECT author, COUNT(*) AS count FROM knowledge_entries GROUP BY author ORDER BY count DESC LIMIT 5`,
				),
				query(
					`SELECT id, title, helpful_count FROM knowledge_entries ORDER BY helpful_count DESC LIMIT 5`,
				),
				// AC#11: entries with zero upvotes that are at least 30 days old
				query(
					`SELECT id, title,
					        EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS age_days
					 FROM knowledge_entries
					 WHERE helpful_count = 0
					   AND created_at < NOW() - INTERVAL '30 days'
					 ORDER BY created_at ASC
					 LIMIT 10`,
				),
			]);

		const entriesByType: Record<string, number> = {};
		for (const row of typeRes.rows as any[]) {
			entriesByType[row.type] = Number(row.count);
		}

		return {
			totalEntries: Number(totalRes.rows[0].c),
			entriesByType: entriesByType as Record<KnowledgeEntryType, number>,
			totalPatterns: Number(patternRes.rows[0].c),
			averageConfidence: Math.round(Number(avgRes.rows[0].avg) || 0),
			topContributors: (contribRes.rows as any[]).map((r) => ({
				author: r.author,
				count: Number(r.count),
			})),
			mostHelpful: (helpfulRes.rows as any[]).map((r) => ({
				id: r.id,
				title: r.title,
				helpfulCount: Number(r.helpful_count),
			})),
			lowHelpfulness: (lowHelpRes.rows as any[]).map((r) => ({
				id: r.id,
				title: r.title,
				ageDays: Math.round(Number(r.age_days)),
			})),
		};
	}

	/**
	 * Remove all entries and patterns from the knowledge base.
	 */
	async clear(): Promise<void> {
		await query(`DELETE FROM knowledge_entries`);
		await query(`DELETE FROM extracted_patterns`);
	}

	/**
	 * No-op: Postgres connections are managed by the pool.
	 * Kept for interface compatibility.
	 */
	close(): void {
		// nothing to do — pool handles connection lifecycle
	}

	// -------------------------------------------------------------------------
	// Private hydration helpers
	// -------------------------------------------------------------------------

	/**
	 * Hydrate a database row into a KnowledgeEntry.
	 * Handles both raw JSON strings (legacy) and already-parsed values (Postgres jsonb).
	 */
	private hydrateEntry(row: any): KnowledgeEntry {
		return {
			id: row.id,
			type: row.type as KnowledgeEntryType,
			title: row.title,
			content: row.content,
			keywords: this.parseJsonField(row.keywords, []),
			relatedProposals: this.parseJsonField(row.related_proposals, []),
			sourceProposalId: row.source_proposal_id ?? undefined,
			author: row.author,
			confidence: Number(row.confidence),
			helpfulCount: Number(row.helpful_count),
			referenceCount: Number(row.reference_count),
			tags: this.parseJsonField(row.tags, []),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			metadata: row.metadata
				? this.parseJsonField(row.metadata, undefined)
				: undefined,
		};
	}

	/**
	 * Hydrate a database row into an ExtractedPattern.
	 */
	private hydratePattern(row: any): ExtractedPattern {
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			codeExample: row.code_example ?? undefined,
			firstSeenAt: row.first_seen_at,
			usageCount: Number(row.usage_count),
			successRate: Number(row.success_rate),
			relatedEntries: this.parseJsonField(row.related_entries, []),
		};
	}

	/**
	 * Parse a field that may be a JSON string or already parsed (Postgres jsonb returns objects).
	 */
	private parseJsonField<T>(value: unknown, fallback: T): T {
		if (value === null || value === undefined) return fallback;
		if (typeof value === "string") {
			try {
				return JSON.parse(value) as T;
			} catch {
				return fallback;
			}
		}
		// Already parsed by pg driver (jsonb column)
		return value as T;
	}
}

/**
 * Create a knowledge base for a project.
 */
export function createKnowledgeBase(projectRoot: string): KnowledgeBase {
	return new KnowledgeBase(projectRoot);
}
