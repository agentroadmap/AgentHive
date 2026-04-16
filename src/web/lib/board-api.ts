/**
 * Board API - serves board data from Postgres
 * Mount as Express routes or MCP resources
 */

import { Router } from 'express';

export function createBoardApi(dbQuery: (sql: string) => any[]): Router {
  const router = Router();

  // GET /api/board/proposals
  router.get('/proposals', (req: any, res: any) => {
    const proposals = dbQuery(
      'SELECT id, display_id, title, status, priority, labels, created_at, updated_at FROM roadmap_proposal.proposal ORDER BY id',
    );
    res.json({ proposals });
  });

  // GET /api/board/proposals/:id/notes - Discussion notes for a proposal
  router.get('/proposals/:id/notes', (req: any, res: any) => {
    try {
      const stepId = req.params.id;
      const noteType = req.query.type as string | undefined;
      let query = `SELECT id, proposal_id, agent_identity, body_markdown, note_type, created_at FROM roadmap_proposal.proposal_discussions WHERE proposal_id = '${stepId}'`;
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
    const proposals = dbQuery(`SELECT * FROM roadmap_proposal.proposal WHERE id = '${req.params.id}' OR display_id = '${req.params.id}'`);
    if (proposals.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ proposal: proposals[0] });
  });

  // GET /api/board/channels
  router.get('/channels', (req: any, res: any) => {
    const channels = dbQuery('SELECT DISTINCT channel AS name FROM roadmap.channel_subscription ORDER BY channel');
    res.json({ channels });
  });

  // GET /api/board/messages/:channel
  router.get('/messages/:channel', (req: any, res: any) => {
    const messages = dbQuery(`SELECT id, from_agent, body, created_at FROM roadmap.message_ledger WHERE channel = '${req.params.channel}' ORDER BY created_at DESC`);
    res.json({ messages });
  });

  // GET /api/board/agents
  router.get('/agents', (req: any, res: any) => {
    const agents = dbQuery('SELECT agent_identity, role, status FROM roadmap_workforce.agent_registry ORDER BY agent_identity');
    res.json({ agents });
  });

  // GET /api/board/cubics
  router.get('/cubics', (req: any, res: any) => {
    const cubics = dbQuery('SELECT dispatch_id, proposal_id, squad_id, dispatch_status, created_at FROM roadmap_workforce.squad_dispatch ORDER BY created_at DESC');
    res.json({ cubics: cubics || [] });
  });

  return router;
}
