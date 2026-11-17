#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { formatReport, runConformance, sanitizeTerminalText } from '../src/index.mjs';

const usage = `Usage: colp-conformance [options] <server-or-manifest-url>

Runs anonymous, read-only black-box checks for the COLP core + publication
profiles against a live server, starting from its Manifest.

Options:
  --json                  Print the report as JSON
  --allow-empty           Permit a schema-only run with no public Collections
  --max-collections <n>   Collections to inspect from the Directory (default 3)
  --max-pages <n>         Snapshot pages to follow per Collection (default 50)
  --max-snapshot-bytes <n> Cumulative Snapshot response bytes (default 67108864)
  --max-snapshot-members <n> Cumulative Snapshot resource members (default 100000)
  --max-snapshot-objects <n> Cumulative Snapshot objects (default 100000)
  --max-requests <n>      Total request budget (default 200)
  --timeout <ms>          Per-request timeout (default 10000)
  -h, --help              Show this help

Exit status: 0 when every observable MUST check passes, 1 when a MUST check
fails or cannot be observed, 2 on usage errors. A publication run with no
publication mount or an empty anonymous Directory fails unless --allow-empty
is given.`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      'allow-empty': { type: 'boolean' },
      'max-collections': { type: 'string' },
      'max-pages': { type: 'string' },
      'max-snapshot-bytes': { type: 'string' },
      'max-snapshot-members': { type: 'string' },
      'max-snapshot-objects': { type: 'string' },
      'max-requests': { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  fail(error.message);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (positionals.length !== 1) fail('Expected exactly one server or Manifest URL.');

const report = await runConformance(positionals[0], {
  allowEmpty: values['allow-empty'],
  maxCollections: count(values['max-collections'], 'max-collections'),
  maxPages: count(values['max-pages'], 'max-pages'),
  maxSnapshotBytes: count(values['max-snapshot-bytes'], 'max-snapshot-bytes'),
  maxSnapshotMembers: count(values['max-snapshot-members'], 'max-snapshot-members'),
  maxSnapshotObjects: count(values['max-snapshot-objects'], 'max-snapshot-objects'),
  maxRequests: count(values['max-requests'], 'max-requests'),
  timeoutMs: count(values.timeout, 'timeout'),
}).catch((error) => fail(error.message));

console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exitCode = report.summary.fail > 0 ? 1 : 0;

function count(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(`--${name} must be a positive integer.`);
  return number;
}

function fail(message) {
  console.error(`colp-conformance: ${sanitizeTerminalText(message)}\n\n${usage}`);
  process.exit(2);
}
