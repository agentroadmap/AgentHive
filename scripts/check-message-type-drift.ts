#!/usr/bin/env node

/**
 * P1103: Message type taxonomy drift detection
 *
 * Compares the TypeScript enum (src/infra/messaging/message-types.ts)
 * against the database CHECK constraint on roadmap.message_ledger.message_type.
 *
 * Exits 0 if aligned, 1 if drift detected. Used by pre-commit and CI/CD.
 */

import { execSync } from 'child_process';
import { MESSAGE_TYPES } from '../src/infra/messaging/message-types.js';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = process.env.DB_PORT || '5432';
const DB_USER = process.env.DB_USER || 'admin';
const DB_NAME = process.env.DB_NAME || 'agenthive';

async function main() {
  try {
    // Query the database for the CHECK constraint definition
    const query = `
      SELECT pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = 'roadmap.message_ledger'::regclass
        AND conname = 'message_ledger_type_check';
    `;

    let pgOutput: string;
    try {
      pgOutput = execSync(
        `psql -h ${DB_HOST} -U ${DB_USER} -d ${DB_NAME} -t -c "${query}"`,
        { encoding: 'utf8' }
      );
    } catch (e) {
      console.error('❌ Failed to query database. Ensure agenthive is running.');
      console.error(`   DB: ${DB_HOST}:${DB_PORT}/${DB_NAME}, user: ${DB_USER}`);
      process.exit(1);
    }

    // Extract the value list from the CHECK definition
    // Pattern: CHECK ((message_type = ANY (ARRAY['text'::text, 'task'::text, ...])))
    const match = pgOutput.match(/ARRAY\[(.*?)\]\)/);
    if (!match) {
      console.error('❌ Could not parse CHECK constraint definition.');
      console.error(`   Got: ${pgOutput}`);
      process.exit(1);
    }

    // Parse the array values: split on '::' and extract the quoted value
    const dbValues = match[1]
      .split(',')
      .map((s) => {
        const m = s.match(/'([^']+)'/);
        return m ? m[1] : s.trim();
      })
      .filter((v) => v)
      .sort();

    const tsValues = [...MESSAGE_TYPES].sort();

    // Compare
    if (JSON.stringify(dbValues) === JSON.stringify(tsValues)) {
      console.log('✅ Message type taxonomy aligned.');
      console.log(`   DB: ${dbValues.join(', ')}`);
      process.exit(0);
    } else {
      console.error('❌ Message type drift detected.');
      console.error(`   TypeScript (${tsValues.length}): ${tsValues.join(', ')}`);
      console.error(`   Database (${dbValues.length}):   ${dbValues.join(', ')}`);

      const inTs = tsValues.filter((v) => !dbValues.includes(v));
      const inDb = dbValues.filter((v) => !tsValues.includes(v));

      if (inTs.length > 0) {
        console.error(`   + In TS enum only: ${inTs.join(', ')}`);
      }
      if (inDb.length > 0) {
        console.error(`   + In DB constraint only: ${inDb.join(', ')}`);
      }

      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Unexpected error:', (e as Error).message);
    process.exit(1);
  }
}

main();
