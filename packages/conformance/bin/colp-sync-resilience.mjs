#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatReport, runSyncResilienceConformance, sanitizeTerminalText } from '../src/index.mjs';

let adapter;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: colp-sync-resilience [--json] <local-adapter.mjs>\nRuns isolated, opt-in Sync scenarios; the adapter may write disposable client/server state.');
  } else {
    if (positionals.length !== 1) throw new TypeError('Expected one local adapter module.');
    adapter = await import(pathToFileURL(resolve(positionals[0])).href);
    if (typeof adapter.runScenario !== 'function') throw new TypeError('Adapter must export runScenario(id).');
    const report = await runSyncResilienceConformance(adapter);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exitCode = report.summary.fail > 0 || report.summary.skip > 0 ? 1 : 0;
  }
} catch (error) {
  console.error(`colp-sync-resilience: ${sanitizeTerminalText(error.message)}`); process.exitCode = 2;
} finally {
  await adapter?.close?.();
}
