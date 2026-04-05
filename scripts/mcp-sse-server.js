import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const serverModule = await import('../src/mcp/server.ts');
const createMcpServer = serverModule.createMcpServer || serverModule.default?.createMcpServer;

if (!createMcpServer) {
  console.error('[MCP] Failed to load createMcpServer from server module');
  process.exit(1);
}

const app = express();

// Session tracking: sessionId → { server, transport }
const sessions = new Map();

app.get('/sse', async (req, res) => {
  console.log('[MCP] New SSE connection request');
  try {
    const server = await createMcpServer(projectRoot);
    const sseTransport = await server.createSseTransport('/messages', res);
    
    const sessionId = sseTransport.sessionId;
    sessions.set(sessionId, { server, transport: sseTransport });
    console.log(`[MCP] SSE session created: ${sessionId}, active sessions: ${sessions.size}`);
    
    res.on('close', () => {
      console.log(`[MCP] SSE connection closed: ${sessionId}`);
      sessions.delete(sessionId);
      server.stop().catch(() => {});
      console.log(`[MCP] Active sessions: ${sessions.size}`);
    });
  } catch (err) {
    console.error('[MCP] Failed to create SSE session:', err.message);
    if (!res.writableEnded) {
      res.status(500).send('Failed to create SSE session');
    }
  }
});

app.post('/messages', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);
  
  if (!session) {
    res.status(400).send(`No active SSE connection for session: ${sessionId}`);
    return;
  }
  
  try {
    await session.server.handleSseMessage(session.transport, req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[MCP] Error handling message:', err.message);
    res.status(500).send('Internal error');
  }
});

const port = process.env.MCP_PORT || 6421;
const server = app.listen(port, '0.0.0.0', () => {
  console.log('[MCP] Roadmap.md SSE Server listening on port ' + port);
  console.log('[MCP] SSE Endpoint: http://localhost:' + port + '/sse');
  console.log('[MCP] Message Endpoint: http://localhost:' + port + '/messages');
});

// Keepalive: prevent Node from exiting when event loop would otherwise be empty
const keepalive = setInterval(() => {
  // No-op — just keeps the event loop active
  server.getConnections((err, count) => {
    if (!err && count === 0) {
      // No active connections — normal state, keep running
    }
  });
}, 30000); // Every 30 seconds

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[MCP] SIGTERM received, shutting down gracefully');
  clearInterval(keepalive);
  server.close(() => {
    console.log('[MCP] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[MCP] SIGINT received, shutting down gracefully');
  clearInterval(keepalive);
  server.close(() => {
    console.log('[MCP] Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[MCP] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[MCP] Unhandled rejection:', reason);
});
