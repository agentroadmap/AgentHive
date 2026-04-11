/**
 * Board API - serves board data from SpacetimeDB
 * Mount as Express routes or MCP resources
 */

import { Router } from 'express';

export function createBoardApi(dbQuery: (sql: string) => any[]): Router {
  const router = Router();

  // GET /api/board/proposals
  router.get('/proposals', (req: any, res: any) => {
    const proposals = dbQuery('SELECT id, title, status, assignee, priority, labels, createdAt, updatedAt FROM step');
    res.json({ proposals });
  });

  // GET /api/board/proposals/:id/notes - Discussion notes for a proposal
  router.get('/proposals/:id/notes', (req: any, res: any) => {
    try {
      const stepId = req.params.id;
      const noteType = req.query.type as string | undefined;
      let query = `SELECT id, step_id, agent_id, content, note_type, created_at FROM proposal_note WHERE step_id = '${stepId}'`;
      if (noteType) {
        query += ` AND note_type = '${noteType}'`;
      }
      query += ' ORDER BY created_at DESC';
      const notes = dbQuery(query);
      res.json({ notes: notes || [] });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/board/proposals/:id
  router.get('/proposals/:id', (req: any, res: any) => {
    const proposals = dbQuery(`SELECT * FROM step WHERE id = '${req.params.id}'`);
    if (proposals.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ proposal: proposals[0] });
  });

  // GET /api/board/proposals
  // Note: proposals should be in SpacetimeDB 'prop' table
  router.get('/proposals', (req: any, res: any) => {
    const proposals = dbQuery('SELECT propId, title, status, authorId, summary, votes FROM prop');
    res.json({ proposals: proposals || [] });
  });

  // GET /api/board/channels
  router.get('/channels', (req: any, res: any) => {
    const channels = dbQuery('SELECT id, name, type FROM chan');
    res.json({ channels });
  });

  // GET /api/board/messages/:channel
  router.get('/messages/:channel', (req: any, res: any) => {
    const messages = dbQuery(`SELECT msgId, fromAgentId, text, timestamp FROM msg WHERE chanId = '${req.params.channel}'`);
    res.json({ messages });
  });

  // GET /api/board/agents
  router.get('/agents', (req: any, res: any) => {
    const agents = dbQuery('SELECT id, name, role, status FROM agent');
    res.json({ agents });
  });

  // GET /api/board/cubics
  // Note: cubics should be in SpacetimeDB 'sbx' table (sandbox registry)
  router.get('/cubics', (req: any, res: any) => {
    const cubics = dbQuery('SELECT cubicId, name, phase, status, agentCount FROM sbx');
    res.json({ cubics: cubics || [] });
  });

  return router;
}
