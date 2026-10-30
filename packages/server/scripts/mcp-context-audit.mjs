#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { auditCatalog, auditTrace, readGeneratedContracts } from './lib/mcp-context-audit.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/mcp-context-audit.mjs [--trace observed-trace.json]\nReports static catalog bytes separately from observed host definitions and provider token usage.');
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--trace')) throw new TypeError('Use --help for supported arguments.');
  const contracts = await readFile(new URL('../src/modules/mcp/automation-tool-contracts.generated.ts', import.meta.url), 'utf8');
  const report = { format: 'colp.mcp-context-audit/v1', catalog: auditCatalog(readGeneratedContracts(contracts)), host: null };
  if (args[0] === '--trace') {
    if ((await stat(args[1])).size > 64 * 1024 * 1024) throw new TypeError('Trace exceeds the 64 MiB offline input limit.');
    report.host = auditTrace(JSON.parse(await readFile(args[1], 'utf8')));
  }
  report.source = fileURLToPath(new URL('../src/modules/mcp/automation-tool-contracts.generated.ts', import.meta.url)).split('/packages/').pop();
  console.log(JSON.stringify(report, null, 2));
}

// JSON.parse and filesystem errors can include raw trace fragments or private
// paths. Keep failure output fixed as well as successful measurement reports.
main().catch(() => {
  console.error('MCP context audit failed. Check the input format, file access, and the 64 MiB trace limit. Use --help for supported arguments.');
  process.exitCode = 1;
});
