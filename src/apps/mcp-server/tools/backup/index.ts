// src/apps/mcp-server/tools/backup/index.ts
//
// P895 — Backup tool registration for MCP router.

import { Router } from 'express';
import { PgBackupHandlers } from './pg-handlers';

export function registerBackupTools(handlers: PgBackupHandlers) {
  const tools = [
    {
      name: 'backup_take',
      description: 'Initiate a backup (full DB or per-project schema)',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'Project ID (required for schema backups, omit for full DB backup)',
          },
          kind: {
            type: 'string',
            enum: ['full', 'schema'],
            description: 'Backup kind: "full" for entire DB, "schema" for per-project',
          },
        },
        required: [],
      },
      handler: async (args: any) => {
        try {
          const result = handlers.takeBackup(args);
          return { success: true, data: result };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: 'backup_verify',
      description: 'Check verification status of a backup',
      inputSchema: {
        type: 'object',
        properties: {
          backup_id: {
            type: 'string',
            description: 'UUID of the backup to verify',
          },
        },
        required: ['backup_id'],
      },
      handler: async (args: any) => {
        try {
          const result = handlers.verifyBackup(args);
          return { success: true, data: result };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: 'backup_list',
      description: 'List backups with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'Filter by project ID',
          },
          verified_only: {
            type: 'boolean',
            description: 'Return only verified backups',
          },
          limit: {
            type: 'number',
            description: 'Maximum results (default 50)',
          },
          offset: {
            type: 'number',
            description: 'Pagination offset (default 0)',
          },
        },
        required: [],
      },
      handler: async (args: any) => {
        try {
          const result = handlers.listBackups(args);
          return { success: true, data: result };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: 'backup_policy',
      description: 'Get backup policy for a project',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'Project ID',
          },
        },
        required: ['project_id'],
      },
      handler: async (args: any) => {
        try {
          const result = handlers.getBackupPolicy(args);
          return { success: true, data: result };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
  ];

  return tools;
}
