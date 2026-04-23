#!/usr/bin/env node
import('./agenthive.cjs.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
