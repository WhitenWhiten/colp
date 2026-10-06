#!/usr/bin/env node

/**
 * Local helper for optional Stryker domain selection.
 * GitHub Actions does not run mutation testing; this is not a workflow matrix.
 * `npm run test:mutation:critical` uses the full MCP config, not these three shards.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const criticalMutationDomains = Object.freeze([
  'core',
  'mcp-change-plan',
  'mcp-write',
  'mcp-read',
  'security',
  'sync',
]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments, received ${JSON.stringify(argv)}.`);
    }
    values.set(option.slice(2), value);
  }
  return values;
}

function booleanValue(value, name) {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  throw new Error(`${name} must be "true" or "false".`);
}

export function selectMutationDomains(selection) {
  if (selection.full) return [...criticalMutationDomains];

  const domains = [];
  if (selection.core) domains.push('core');
  if (selection.mcp) domains.push('mcp-change-plan', 'mcp-write', 'mcp-read');
  if (selection.security) domains.push('security');
  if (selection.sync) domains.push('sync');
  return domains;
}

function run(argv) {
  const values = parseArguments(argv);
  const full = booleanValue(values.get('full') ?? '', 'full');
  const domains = selectMutationDomains({
    full,
    core: full ? false : booleanValue(values.get('core') ?? '', 'core'),
    mcp: full ? false : booleanValue(values.get('mcp') ?? '', 'mcp'),
    security: full ? false : booleanValue(values.get('security') ?? '', 'security'),
    sync: full ? false : booleanValue(values.get('sync') ?? '', 'sync'),
  });
  process.stdout.write(JSON.stringify(domains));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2));
}
