import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditDependencies } from './audit-dependencies.mjs';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const PICOMATCH_ID = 'GHSA-fc5q-39xc-vjpf';
const ALLOWED_ENTRY = {
  id: PICOMATCH_ID,
  package: 'picomatch',
  reason: 'no patched release; dev-only glob matcher',
  owner: 'colp-security',
  expires: '2026-12-31',
};

const allowlistDirectory = await mkdtemp(join(tmpdir(), 'colp-audit-allowlist-'));
const allowlistPath = join(allowlistDirectory, 'allowlist.json');
await writeFile(allowlistPath, JSON.stringify([ALLOWED_ENTRY]));
after(() => rm(allowlistDirectory, { recursive: true, force: true }));

const clean = { status: 0, stdout: JSON.stringify({
  vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } },
}) };
const unavailable = { status: 1, stdout: JSON.stringify({
  statusCode: 503, message: '503 Service Unavailable',
}) };

function fixture(results, options = {}) {
  const calls = [];
  const delays = [];
  const output = [];
  const stream = { write: (text) => output.push(text) };
  return {
    calls, delays, output,
    options: {
      allowlistPath,
      now: NOW,
      ...options,
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

function counts(vulnerabilities) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const vulnerability of Object.values(vulnerabilities)) {
    counts[vulnerability.severity] = (counts[vulnerability.severity] ?? 0) + 1;
  }
  return { ...counts, total: Object.keys(vulnerabilities).length };
}

function auditReport(vulnerabilities, status = 1) {
  return {
    status,
    stdout: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities,
      metadata: { vulnerabilities: counts(vulnerabilities) },
    }),
  };
}

function vuln(severity, via) {
  return { severity, via };
}

function advisory(overrides = {}) {
  return {
    source: 1247710,
    name: 'picomatch',
    dependency: 'picomatch',
    title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
    url: `https://github.com/advisories/${PICOMATCH_ID}`,
    severity: 'high',
    range: '<=4.0.7',
    ...overrides,
  };
}

async function customAllowlist(t, document) {
  const directory = await mkdtemp(join(tmpdir(), 'colp-audit-allowlist-case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'allowlist.json');
  await writeFile(path, typeof document === 'string' ? document : JSON.stringify(document));
  return path;
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
  const findings = auditReport({ dependency: vuln('high', undefined) });
  for (const results of [[findings], [unavailable, findings]]) {
    const f = fixture(results);
    assert.equal(await auditDependencies([], f.options), 1);
    assert.equal(f.calls.length, f.delays.length + 1);
  }
});

test('a transitive high chain that ends in the allowlisted advisory is suppressed', async () => {
  const f = fixture([auditReport({
    vite: vuln('high', ['tinyglobby']),
    tinyglobby: vuln('high', ['fdir', 'picomatch']),
    fdir: vuln('high', ['picomatch']),
    picomatch: vuln('high', [advisory()]),
  })]);
  assert.equal(await auditDependencies(['--audit-level=high'], f.options), 0);
  const output = f.output.join('');
  assert.match(output, /Suppressed high vulnerability in picomatch/u);
  assert.match(output, /Suppressed high vulnerability in vite/u);
  assert.match(output, new RegExp(PICOMATCH_ID, 'u'));
  assert.match(output, /2026-12-31/u);
});

test('an unrelated high vulnerability still fails when other high findings are suppressed', async () => {
  const f = fixture([auditReport({
    picomatch: vuln('high', [advisory()]),
    unrelated: vuln('high', [{
      name: 'unrelated',
      dependency: 'unrelated',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      severity: 'high',
    }]),
  })]);
  assert.equal(await auditDependencies(['--audit-level=high'], f.options), 1);
  assert.match(f.output.join(''), /GHSA-AAAA-BBBB-CCCC.*not allowlisted/u);
});

test('an allowlisted advisory id does not suppress a different package', async () => {
  const f = fixture([auditReport({
    other: vuln('high', [advisory({ name: 'other', dependency: 'other' })]),
  })]);
  assert.equal(await auditDependencies(['--audit-level=high'], f.options), 1);
  assert.match(f.output.join(''), /High advisory GHSA-FC5Q-39XC-VJPF for other is not allowlisted/u);
});

test('an unrelated critical vulnerability still fails when high findings are suppressed', async () => {
  const f = fixture([auditReport({
    picomatch: vuln('high', [advisory()]),
    unrelated: vuln('critical', [{
      name: 'unrelated',
      dependency: 'unrelated',
      url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
      severity: 'critical',
    }]),
  })]);
  assert.equal(await auditDependencies(['--audit-level=high'], f.options), 1);
  assert.match(f.output.join(''), /Critical vulnerability in unrelated is never suppressible/u);
});

test('a critical advisory cannot be suppressed even when its id is allowlisted', async () => {
  const f = fixture([auditReport({
    picomatch: vuln('high', [advisory({ severity: 'critical' })]),
  })]);
  assert.equal(await auditDependencies(['--audit-level=high'], f.options), 1);
  assert.match(f.output.join(''), /Critical advisory GHSA-FC5Q-39XC-VJPF.*never suppressible/u);
});

test('an expired allowlist entry fails closed with its advisory id and expiry', async (t) => {
  const expiredPath = await customAllowlist(t, [{ ...ALLOWED_ENTRY, expires: '2026-01-01' }]);
  const f = fixture([auditReport({ picomatch: vuln('high', [advisory()]) })], {
    allowlistPath: expiredPath,
  });
  assert.equal(await auditDependencies(['--audit-level=high'], f.options), 1);
  const output = f.output.join('');
  assert.match(output, new RegExp(PICOMATCH_ID, 'u'));
  assert.match(output, /expired 2026-01-01/u);
  assert.match(output, /refusing to suppress/u);
});

test('a missing allowlist fails closed before any audit runs', async () => {
  const f = fixture([clean], {
    allowlistPath: join(tmpdir(), 'colp-missing-audit-allowlist', 'does-not-exist.json'),
  });
  assert.equal(await auditDependencies([], f.options), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.output.join(''), /unable to load dependency-audit advisory allowlist/u);
});

test('a malformed allowlist fails closed before any audit runs', async (t) => {
  for (const document of [
    '{ not json',
    { advisories: [ALLOWED_ENTRY] },
    [{ ...ALLOWED_ENTRY, owner: '' }],
    [{ ...ALLOWED_ENTRY, expires: '2026-02-30' }],
    [{ ...ALLOWED_ENTRY, unknown: true }],
  ]) {
    const malformedPath = await customAllowlist(t, document);
    const f = fixture([clean], { allowlistPath: malformedPath });
    assert.equal(await auditDependencies([], f.options), 1);
    assert.equal(f.calls.length, 0);
    assert.match(f.output.join(''), /invalid dependency-audit advisory allowlist|unable to load/u);
  }
});

test('PR-style npm exit 1 with all high findings suppressed returns 0', async () => {
  const f = fixture([auditReport({
    '@typescript-eslint/typescript-estree': vuln('high', ['minimatch', 'tinyglobby']),
    minimatch: vuln('moderate', [{
      name: 'minimatch',
      dependency: 'minimatch',
      url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
      severity: 'moderate',
    }]),
    tinyglobby: vuln('high', ['fdir', 'picomatch']),
    fdir: vuln('high', ['picomatch']),
    picomatch: vuln('high', [advisory()]),
    vite: vuln('high', ['picomatch', 'tinyglobby']),
    vitest: vuln('high', ['@vitest/coverage-v8', 'picomatch', 'tinyglobby']),
    '@vitest/coverage-v8': vuln('high', ['vitest']),
  })]);
  assert.equal(await auditDependencies(['--omit=dev', '--audit-level=high'], f.options), 0);
  const output = f.output.join('');
  assert.match(output, /Suppressed high vulnerability in @typescript-eslint\/typescript-estree/u);
  assert.match(output, /Suppressed high vulnerability in vitest/u);
  assert.doesNotMatch(output, /moderate advisory.*suppressed/iu);
});

test('moderate and low findings are never suppressed', async () => {
  const report = auditReport({
    moderate: vuln('moderate', [{
      name: 'moderate',
      dependency: 'moderate',
      url: 'https://github.com/advisories/GHSA-mmmm-mmmm-mmmm',
      severity: 'moderate',
    }]),
    low: vuln('low', [{
      name: 'low',
      dependency: 'low',
      url: 'https://github.com/advisories/GHSA-llll-llll-llll',
      severity: 'low',
    }]),
  });
  const f = fixture([report]);
  assert.equal(await auditDependencies(['--audit-level=moderate'], f.options), 1);
  assert.doesNotMatch(f.output.join(''), /Suppressed/u);
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
  // npm 10 asks the bulk endpoint and then the quick endpoint; some npm
  // versions answer the empty bulk result without a quick call. Both are the
  // same recovery path, so assert the endpoints and the retry rather than one
  // npm release's exact request count.
  assert.ok(requests.length >= 3, JSON.stringify(requests));
  assert.ok(requests.every((url) => url === '/-/npm/v1/security/advisories/bulk'
    || url === '/-/npm/v1/security/audits/quick'), JSON.stringify(requests));
  assert.ok(requests.filter((url) => url === '/-/npm/v1/security/advisories/bulk').length >= 2,
    JSON.stringify(requests));
  assert.match(output, /Temporary registry failure/u);
  assert.match(output, /"high": 0/u);
});
