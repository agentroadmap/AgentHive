/**
 * Board API - serves board data from Postgres
 * Mount as Express routes or MCP resources
 */

import { Router } from 'express';

export interface DbQuery {
  (sql: string, params?: unknown[]): any[];
}

export function createBoardApi(dbQuery: DbQuery): Router {
  const router = Router();

  // GET /api/board/proposals
  router.get('/proposals', (_req: any, res: any) => {
    try {
      const proposals = dbQuery(
        'SELECT id, display_id, title, type, status, priority, tags, maturity, created_at, modified_at FROM roadmap_proposal.proposal ORDER BY id',
      );
      res.json({ proposals });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/proposals/:id
  router.get('/proposals/:id', (req: any, res: any) => {
    try {
      const id = req.params.id;
      if (!id || id.length === 0) {
        return res.status(400).json({ error: 'Invalid proposal ID' });
      }
      const isNumeric = /^\d+$/.test(id);
      const proposals = dbQuery(
        isNumeric
          ? 'SELECT * FROM roadmap_proposal.proposal WHERE id = $1'
          : 'SELECT * FROM roadmap_proposal.proposal WHERE display_id = $1',
        [isNumeric ? parseInt(id, 10) : id],
      );
      if (proposals.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ proposal: proposals[0] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/proposals/:id/notes
  router.get('/proposals/:id/notes', (req: any, res: any) => {
    try {
      const proposalId = req.params.id;
      const noteType = req.query.type as string | undefined;
      let sql = 'SELECT id, proposal_id, author_identity, context_prefix, body_markdown, created_at FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1';
      const params: unknown[] = [proposalId];
      if (noteType) {
        sql += ' AND context_prefix = $2';
        params.push(noteType);
      }
      sql += ' ORDER BY created_at DESC';
      const notes = dbQuery(sql, params);
      res.json({ notes: notes || [] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/proposals/:id/decisions
  router.get('/proposals/:id/decisions', (req: any, res: any) => {
    try {
      const proposalId = req.params.id;
      if (!proposalId || proposalId.length === 0) {
        return res.status(400).json({ error: 'Invalid proposal ID' });
      }
      const isNumeric = /^\d+$/.test(proposalId);

      let sql: string;
      let params: unknown[];

      if (isNumeric) {
        sql = `SELECT id, decision, authority, rationale, binding, decided_at
               FROM roadmap_proposal.proposal_decision
               WHERE proposal_id = $1
               ORDER BY decided_at DESC`;
        params = [parseInt(proposalId, 10)];
      } else {
        sql = `SELECT id, decision, authority, rationale, binding, decided_at
               FROM roadmap_proposal.proposal_decision
               WHERE proposal_id = (SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)
               ORDER BY decided_at DESC`;
        params = [proposalId];
      }

      const decisions = dbQuery(sql, params);
      res.json({ decisions: decisions || [] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/proposals/:id/reviews
  router.get('/proposals/:id/reviews', (req: any, res: any) => {
    try {
      const proposalId = req.params.id;
      if (!proposalId || proposalId.length === 0) {
        return res.status(400).json({ error: 'Invalid proposal ID' });
      }
      const isNumeric = /^\d+$/.test(proposalId);

      let sql: string;
      let params: unknown[];

      if (isNumeric) {
        sql = `SELECT id, reviewer_identity, verdict, notes, findings, is_blocking, reviewed_at
               FROM roadmap_proposal.proposal_reviews
               WHERE proposal_id = $1
               ORDER BY reviewed_at DESC`;
        params = [parseInt(proposalId, 10)];
      } else {
        sql = `SELECT id, reviewer_identity, verdict, notes, findings, is_blocking, reviewed_at
               FROM roadmap_proposal.proposal_reviews
               WHERE proposal_id = (SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)
               ORDER BY reviewed_at DESC`;
        params = [proposalId];
      }

      const reviews = dbQuery(sql, params);
      res.json({ reviews: reviews || [] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/channels
  router.get('/channels', (_req: any, res: any) => {
    try {
      const channels = dbQuery('SELECT DISTINCT channel AS name FROM roadmap.channel_subscription ORDER BY channel');
      res.json({ channels });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/messages/:channel
  router.get('/messages/:channel', (req: any, res: any) => {
    try {
      const channel = req.params.channel;
      if (!channel || channel.length === 0) {
        return res.status(400).json({ error: 'Invalid channel' });
      }
      const messages = dbQuery(
        'SELECT id, from_agent, to_agent, message_content, channel, message_type, created_at FROM roadmap.message_ledger WHERE channel = $1 ORDER BY created_at DESC',
        [channel],
      );
      res.json({ messages });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/agents
  router.get('/agents', (_req: any, res: any) => {
    try {
      const agents = dbQuery(
        'SELECT id, agent_identity, agent_type, role, skills, status, trust_tier, agency_id FROM roadmap_workforce.agent_registry ORDER BY agent_identity',
      );
      res.json({ agents });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/dispatches — P281 offer/claim/lease dispatches
  router.get('/dispatches', (_req: any, res: any) => {
    try {
      const dispatches = dbQuery(
        `SELECT id, proposal_id, agent_identity, worker_identity, squad_name, dispatch_role,
                dispatch_status, offer_status, claim_expires_at, assigned_at, completed_at,
                reissue_count, max_reissues, required_capabilities, metadata
         FROM roadmap_workforce.squad_dispatch
         ORDER BY assigned_at DESC
         LIMIT 100`,
      );
      res.json({ dispatches: dispatches || [] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/routes — model routing table
  router.get('/routes', (_req: any, res: any) => {
    try {
      const routes = dbQuery(
        `SELECT id, model_name, route_provider, agent_provider, agent_cli, fallback_cli,
                is_enabled, priority, api_spec, base_url,
                cost_per_million_input, cost_per_million_output,
                cost_per_million_cache_write, cost_per_million_cache_hit,
                plan_type, notes, created_at
         FROM roadmap.model_routes
         ORDER BY is_enabled DESC, priority DESC, model_name`,
      );
      res.json({ routes: routes || [] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
