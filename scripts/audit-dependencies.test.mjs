import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditDependencies } from './audit-dependencies.mjs';

const clean = { status: 0, stdout: JSON.stringify({
  vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } },
}) };
const unavailable = { status: 1, stdout: JSON.stringify({
  statusCode: 503, message: '503 Service Unavailable',
}) };

function fixture(results) {
  const calls = [];
  const delays = [];
  const output = [];
  const stream = { write: (text) => output.push(text) };
  return {
    calls, delays, output,
    options: {
      run: (...args) => {
        calls.push(args);
        assert.ok(results.length, 'unexpected additional audit');
        return results.shift();
      },
      wait: async (delay) => { delays.push(delay); },
      stdout: stream,
      stderr: stream,
    },
  };
}

test('a successful audit preserves the requested dependency scope and bounds npm waits', async () => {
  const f = fixture([clean]);
  const args = ['--omit=dev', '--omit=peer', '--audit-level=high', '--prefix', 'runtime'];
  assert.equal(await auditDependencies(args, f.options), 0);
  const [command, actualArgs, options] = f.calls[0];
  assert.equal(command, 'npm');
  assert.deepEqual(actualArgs, [
    'audit', ...args, '--json', '--audit=true', '--fetch-retries=0', '--fetch-timeout=30000',
  ]);
  assert.equal(options.timeout, 90_000);
  assert.deepEqual(f.delays, []);
});

test('a temporary 503 retries and succeeds when the registry recovers', async () => {
  const f = fixture([unavailable, clean]);
  assert.equal(await auditDependencies([], f.options), 0);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.delays, [5_000]);
  assert.match(f.output.join(''), /Temporary registry failure/u);
});

test('a persistent outage fails after three attempts', async () => {
  const f = fixture([unavailable, unavailable, unavailable]);
  assert.equal(await auditDependencies([], f.options), 1);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.delays, [5_000, 15_000]);
});

test('High findings fail immediately, including after a registry outage', async () => {
  const findings = { status: 1, stdout: JSON.stringify({
    vulnerabilities: { dependency: { severity: 'high' } },
    metadata: { vulnerabilities: { high: 1, critical: 0 } },
  }) };
  for (const results of [[findings], [unavailable, findings]]) {
    const f = fixture(results);
    assert.equal(await auditDependencies([], f.options), 1);
    assert.equal(f.calls.length, f.delays.length + 1);
  }
});

test('timeouts, rate limits and temporary network failures can recover', async () => {
  for (const failure of [
    { status: 1, stdout: JSON.stringify({ statusCode: 429 }) },
    { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    { status: 1, stdout: JSON.stringify({ message: 'request failed: ECONNRESET' }) },
    { status: 1, stdout: JSON.stringify({ error: { code: 'EAI_AGAIN' } }) },
  ]) {
    const f = fixture([failure, clean]);
    assert.equal(await auditDependencies([], f.options), 0);
    assert.equal(f.calls.length, 2);
  }
});

test('authentication, lockfile, malformed output and process failures fail without retrying', async () => {
  for (const failure of [
    { status: 1, stdout: JSON.stringify({ statusCode: 401 }) },
    { status: 1, stdout: JSON.stringify({ error: { code: 'ENOLOCK' } }) },
    { status: 1, stdout: 'not JSON' },
    { status: 0, stdout: '{}' },
    { status: null, signal: 'SIGTERM' },
    { status: null, error: Object.assign(new Error('npm missing'), { code: 'ENOENT' }) },
  ]) {
    const f = fixture([failure]);
    assert.equal(await auditDependencies([], f.options), 1);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.delays, []);
  }
});

test('the CLI recovers from an audit endpoint outage with real npm and install audits disabled', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-audit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    response.writeHead(requests.length <= 2 ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests.length <= 2 ? { error: 'Service Unavailable' } : {}));
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const registry = `http://127.0.0.1:${server.address().port}`;
  const manifest = { name: 'audit-test', version: '1.0.0', dependencies: { 'audit-leaf': '1.0.0' } };
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: {
      '': manifest,
      'node_modules/audit-leaf': { version: '1.0.0', resolved: `${registry}/audit-leaf.tgz` },
    },
  }));
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./audit-dependencies.mjs', import.meta.url)),
    '--omit=dev', '--audit-level=high', `--registry=${registry}`,
  ], {
    cwd: directory,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_update_notifier: 'false',
      npm_config_cache: join(directory, 'cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
  });
  t.after(() => { child.kill(); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, `${JSON.stringify(requests)}\n${output}`);
  assert.deepEqual(requests, [
    '/-/npm/v1/security/advisories/bulk',
    '/-/npm/v1/security/audits/quick',
    '/-/npm/v1/security/advisories/bulk',
  ]);
  assert.match(output, /Temporary registry failure/u);
  assert.match(output, /"high": 0/u);
});
