#!/usr/bin/env node
// npm's audit POST requests are not retried by fetch-retries. Retry temporary
// registry failures here, while keeping vulnerability findings blocking.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const RETRY_DELAYS_MS = [5_000, 15_000];
const TRANSIENT_NETWORK_ERROR = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNECTIONTIMEOUT|EIDLETIMEOUT|ERESPONSETIMEOUT|ETRANSFERTIMEOUT)\b/u;

export async function auditDependencies(args, {
  run = spawnSync,
  wait = sleep,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    stderr.write(`Dependency audit attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}\n`);
    const result = run('npm', [
      'audit', ...args, '--json', '--audit=true', '--fetch-retries=0', '--fetch-timeout=30000',
    ], {
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) stderr.write(`${result.error.message}\n`);

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      // Unknown or malformed output must fail, never count as a clean audit.
    }
    if (report?.vulnerabilities && report?.metadata?.vulnerabilities) {
      return result.status ?? 1;
    }

    const status = report?.statusCode;
    const transient = status === 408 || status === 429 || (status >= 500 && status < 600)
      || TRANSIENT_NETWORK_ERROR.test([
        result.error?.code, report?.error?.code, report?.message, report?.error?.summary,
      ].join(' '));
    const delay = RETRY_DELAYS_MS[attempt];
    if (!transient || delay === undefined) {
      stderr.write('Dependency audit failed without a valid vulnerability report.\n');
      return result.status || 1;
    }
    stderr.write(`Temporary registry failure; retrying in ${delay / 1000}s.\n`);
    await wait(delay);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await auditDependencies(process.argv.slice(2));
}
