/**
 * P4A-V4A-05 focused unit contract suite (plan §4 V4A-05):
 *
 *  - pins the machine-readable delivery URL-security deployment contract
 *    (`tests/fixtures/phase4a/delivery-url-security-contract.v1.json`) and
 *    proves the standalone verifier
 *    (`scripts/verify-delivery-url-security-contract.mjs`) fails closed when
 *    ANY scrub/no-log/no-cache/no-referer clause is missing from the contract
 *    or from the deployment runbook;
 *  - pins the response-header contract against the pure delivery policy;
 *  - pins the request-log serializer: only route templates are logged, the
 *    raw-URL fallback scrubs capability path segments, query strings are
 *    stripped and proxy raw-URI fields never enter structured logs;
 *  - pins `redactSensitiveText` coverage for the I10 capability token shapes
 *    (Bearer form and `/d/<token>` URL form, including percent-encoded
 *    variants and error cause chains).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import {
  createLogger,
  redactSensitiveText,
  serializeRequestForLog,
} from '../../../src/infrastructure/telemetry/index.js';
import { deliverySecurityHeaders } from '../../../src/modules/attachments/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const contractPath = resolve(backendRoot, 'tests/fixtures/phase4a/delivery-url-security-contract.v1.json');
const runbookPath = resolve(backendRoot, 'docs/runbooks/attachments-delivery-process-operations.md');
const verifierPath = resolve(backendRoot, 'scripts/verify-delivery-url-security-contract.mjs');

interface UrlSecretDeploymentContract {
  format: string;
  contractVersion: number;
  planTask: string;
  runbook: string;
  capabilityIsBearerSecret: boolean;
  responseHeaders: {
    referrerPolicy: { name: string; value: string };
    cacheControl: { name: string; value: string };
    noSniff: { name: string; value: string };
  };
  headersOnSuccessAndErrorResponses: boolean;
  logScope: string;
  tokenFingerprintDefaultOff: boolean;
  forbidRawPathQueryLogging: boolean;
  forbidPersistingRealPath: boolean;
  deployment: {
    ingress: { forbidRawPathQueryLogging: boolean; forbidCaching: boolean; forbidRefererForwarding: boolean };
    cdnWaf: { forbidRawPathQueryLogging: boolean; forbidCaching: boolean; forbidRefererForwarding: boolean };
    apm: { forbidRawPathQueryLogging: boolean; scrubUrlCaptures: boolean };
  };
}

function runVerifier(extraArgs: string[] = []) {
  return spawnSync(process.execPath, [verifierPath, ...extraArgs], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
}

function readContract(): UrlSecretDeploymentContract {
  return JSON.parse(readFileSync(contractPath, 'utf8')) as UrlSecretDeploymentContract;
}

function mutateContract(mutate: (contract: UrlSecretDeploymentContract) => void): string {
  const contract = readContract();
  mutate(contract);
  const directory = mkdtempSync(join(tmpdir(), 'known-phase4a-url-secret-contract-'));
  const path = join(directory, 'contract.json');
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return path;
}

function mutateRunbook(mutate: (source: string) => string): string {
  const directory = mkdtempSync(join(tmpdir(), 'known-phase4a-url-secret-doc-'));
  const path = join(directory, 'runbook.md');
  writeFileSync(path, mutate(readFileSync(runbookPath, 'utf8')), 'utf8');
  return path;
}

function mutatePackageJson(mutate: (source: string) => string): string {
  const directory = mkdtempSync(join(tmpdir(), 'known-phase4a-url-secret-pkg-'));
  const path = join(directory, 'package.json');
  writeFileSync(path, mutate(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')), 'utf8');
  return path;
}

test('V4A-05 registers the delivery-url-security focused gate', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const gate = packageJson.scripts['test:phase4a:delivery-url-security'] ?? '';
  assert.match(gate, /^node scripts\/with-postgres\.mjs -- /u);
  assert.ok(gate.includes('test:phase4a:delivery-url-security:inner'));
  assert.ok(packageJson.scripts['test:phase4a:delivery-url-security:inner']?.includes(
    'tests/integration/phase4a/phase4a-delivery-url-security-postgres.integration.test.ts',
  ));
  assert.ok(packageJson.scripts['test:phase4a:delivery-url-security:inner']?.includes(
    'tests/unit/phase4a/phase4a-delivery-url-security-contract.test.ts',
  ));
});

test('V4A-05 freezes the URL-secret deployment contract (bearer-secret classification, headers, log scope, ingress/CDN/WAF/APM)', () => {
  const contract = readContract();
  assert.equal(contract.format, 'known.phase4a.delivery-url-security.v1');
  assert.equal(contract.contractVersion, 1);
  assert.equal(contract.planTask, 'V4A-05');
  assert.equal(contract.runbook, 'Known-Backend/docs/runbooks/attachments-delivery-process-operations.md');
  assert.equal(contract.capabilityIsBearerSecret, true);
  assert.equal(contract.responseHeaders.referrerPolicy.name, 'Referrer-Policy');
  assert.equal(contract.responseHeaders.referrerPolicy.value, 'no-referrer');
  assert.equal(contract.responseHeaders.cacheControl.name, 'Cache-Control');
  assert.equal(contract.responseHeaders.cacheControl.value, 'no-store');
  assert.equal(contract.responseHeaders.noSniff.name, 'X-Content-Type-Options');
  assert.equal(contract.responseHeaders.noSniff.value, 'nosniff');
  assert.equal(contract.headersOnSuccessAndErrorResponses, true);
  assert.equal(contract.logScope, 'route-template-or-fixed-token-fingerprint');
  assert.equal(contract.tokenFingerprintDefaultOff, true);
  assert.equal(contract.forbidRawPathQueryLogging, true);
  assert.equal(contract.forbidPersistingRealPath, true);
  assert.deepEqual(contract.deployment.ingress,
    { forbidRawPathQueryLogging: true, forbidCaching: true, forbidRefererForwarding: true });
  assert.deepEqual(contract.deployment.cdnWaf,
    { forbidRawPathQueryLogging: true, forbidCaching: true, forbidRefererForwarding: true });
  assert.deepEqual(contract.deployment.apm,
    { forbidRawPathQueryLogging: true, scrubUrlCaptures: true });
});

test('V4A-05 the pure delivery policy carries the contracted response headers', () => {
  const contract = readContract();
  const headers = deliverySecurityHeaders();
  assert.equal(headers['referrer-policy'], contract.responseHeaders.referrerPolicy.value);
  assert.ok(headers['cache-control']!.includes(contract.responseHeaders.cacheControl.value),
    'Cache-Control must include no-store');
  assert.equal(headers['x-content-type-options'], contract.responseHeaders.noSniff.value);
});

test('V4A-05 verifier accepts the frozen contract with the deployment runbook', () => {
  const result = runVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /delivery URL-security contract verified/u);
});

test('V4A-05 verifier rejects missing scrub/no-log clauses in the deployment contract', () => {
  const mutations: ReadonlyArray<{ name: string; mutate: (contract: UrlSecretDeploymentContract) => void }> = [
    { name: 'ingress raw path/query logging allowed', mutate: (c) => { c.deployment.ingress.forbidRawPathQueryLogging = false; } },
    { name: 'ingress caching allowed', mutate: (c) => { c.deployment.ingress.forbidCaching = false; } },
    { name: 'ingress referer forwarding allowed', mutate: (c) => { c.deployment.ingress.forbidRefererForwarding = false; } },
    { name: 'CDN/WAF raw path/query logging allowed', mutate: (c) => { c.deployment.cdnWaf.forbidRawPathQueryLogging = false; } },
    { name: 'CDN/WAF caching allowed', mutate: (c) => { c.deployment.cdnWaf.forbidCaching = false; } },
    { name: 'CDN/WAF referer forwarding allowed', mutate: (c) => { c.deployment.cdnWaf.forbidRefererForwarding = false; } },
    { name: 'APM raw path/query logging allowed', mutate: (c) => { c.deployment.apm.forbidRawPathQueryLogging = false; } },
    { name: 'APM URL captures unscrubbed', mutate: (c) => { c.deployment.apm.scrubUrlCaptures = false; } },
    { name: 'capability no longer classified as bearer secret', mutate: (c) => { c.capabilityIsBearerSecret = false; } },
    { name: 'raw path logging globally allowed', mutate: (c) => { c.forbidRawPathQueryLogging = false; } },
    { name: 'real paths may be persisted', mutate: (c) => { c.forbidPersistingRealPath = false; } },
    { name: 'missing no-referrer header', mutate: (c) => { c.responseHeaders.referrerPolicy.value = 'strict-origin'; } },
    { name: 'missing no-store header', mutate: (c) => { c.responseHeaders.cacheControl.value = 'public'; } },
    { name: 'fingerprint enabled by default', mutate: (c) => { c.tokenFingerprintDefaultOff = false; } },
  ];
  for (const mutation of mutations) {
    const path = mutateContract(mutation.mutate);
    const result = runVerifier(['--contract', path]);
    assert.notEqual(result.status, 0, mutation.name);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED/u, mutation.name);
  }
});

test('V4A-05 verifier rejects a runbook missing the no-log/no-cache/no-referer clauses', () => {
  const removals: ReadonlyArray<{ name: string; marker: string }> = [
    { name: 'classification clause', marker: 'The capability URL is a bearer secret' },
    { name: 'no-log clause', marker: 'never log the raw path or query' },
    { name: 'no-referer clause', marker: 'must not forward or inject a Referer' },
    { name: 'no-cache clause', marker: 'must not cache' },
    { name: 'fingerprint default-off clause', marker: 'OFF by default' },
  ];
  for (const removal of removals) {
    const path = mutateRunbook((source) => source.replaceAll(removal.marker, ''));
    const result = runVerifier(['--runbook', path]);
    assert.notEqual(result.status, 0, removal.name);
    assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*deployment runbook/iu, removal.name);
  }
});

test('V4A-05 verifier rejects a package.json without the focused gate', () => {
  const path = mutatePackageJson((source) => source.replace(
    '"test:phase4a:delivery-url-security"',
    '"test:phase4a:delivery-url-security:removed"',
  ));
  const result = runVerifier(['--package-json', path]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*test:phase4a:delivery-url-security/u);
});

test('V4A-05 the request serializer only emits route templates and scrubs capability path segments in the raw-URL fallback', () => {
  const marker = 'v4a05-unit-marker-capability';
  const serialized = serializeRequestForLog({
    method: 'GET',
    url: `/d/v1.${marker}.payload.sig?filename=report.txt&x=${marker}`,
    routeOptions: { url: '/d/:token' },
    headers: { host: 'delivery.example' },
  });
  assert.deepEqual(serialized, {
    method: 'GET',
    url: '/d/:token',
    host: 'delivery.example',
    remoteAddress: undefined,
    remotePort: undefined,
  });

  // Unregistered route (no route template): the capability segment is
  // scrubbed and the query is stripped, so a capability URL arriving at a
  // 404 can never reach a log line.
  const fallback = serializeRequestForLog({
    method: 'GET',
    url: `/d/v1.${marker}.payload.sig?filename=${marker}`,
  }) as { url: string };
  assert.equal(fallback.url, '/d/[REDACTED]');
  assert.ok(!fallback.url.includes(marker));

  // Percent-encoded token shapes are scrubbed too.
  const encoded = serializeRequestForLog({
    method: 'GET',
    url: `/d/v1%2E${marker}%2Epayload%2Esig?x=1`,
  }) as { url: string };
  assert.equal(encoded.url, '/d/[REDACTED]');
  assert.ok(!encoded.url.includes(marker));

  // Non-delivery paths are untouched (operator debuggability preserved).
  const opaque = serializeRequestForLog({
    method: 'GET',
    url: `/opaque/${marker}?cursor=${marker}`,
  }) as { url: string };
  assert.equal(opaque.url, `/opaque/${marker}`);

  // Proxy raw-URI fields never enter the serialized log.
  const proxied = serializeRequestForLog({
    method: 'GET',
    url: `/d/v1.${marker}.sig`,
    headers: {
      host: 'delivery.example',
      'x-forwarded-uri': `/d/v1.${marker}.sig?token=${marker}`,
      'x-original-url': `https://delivery.example/d/v1.${marker}.sig`,
    },
  }) as Record<string, unknown>;
  assert.equal(JSON.stringify(proxied).includes(marker), false, 'proxy raw-URI fields must never be serialized');
});

test('V4A-05 pino structured logs never contain a capability marker and only carry the route template', () => {
  const marker = 'v4a05-unit-marker-pino';
  const chunks: string[] = [];
  const destination = new PassThrough();
  destination.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const logger = createLogger('info', destination);
  logger.info({
    req: { method: 'GET', url: `/d/v1.${marker}.payload.sig?filename=x`, routeOptions: { url: '/d/:token' } },
  });
  // The codebase logging discipline: error text passes through
  // redactSensitiveText BEFORE it is handed to the logger (see worker.ts /
  // process-lifecycle.ts), so a capability URL inside an error message can
  // never reach a structured log line.
  logger.error(
    { error: redactSensitiveText(new Error(`upstream failure for /d/v1.${marker}.payload.sig`)) },
    'delivery error',
  );
  const output = chunks.join('');
  assert.ok(output.includes('/d/:token'), 'structured logs carry the route template');
  assert.ok(!output.includes(marker), 'a capability marker must never appear in structured logs');
  assert.ok(!output.includes('v1.'), 'the capability token shape must never appear in structured logs');
});

test('V4A-05 redactSensitiveText covers the capability token shapes (Bearer and URL) without over-redacting ordinary text', () => {
  const marker = 'v4a05-redact-marker-0001';
  // Realistic I10 token shape: `v1.<base64url payload JSON>.<base64url HMAC>`
  // (payload segment ~200 chars, signature exactly 43 chars).
  const capabilityToken = `v1.${marker}${'A'.repeat(180)}.${'B'.repeat(43)}`;
  // Bearer form (pre-existing coverage).
  assert.ok(!redactSensitiveText(`Authorization: Bearer ${capabilityToken}`).includes(marker));
  // URL form: the whole /d/ capability segment is redacted, including
  // percent-encoded tokens; a query string survives but never carries the
  // token (capabilities never go in query parameters).
  const urlForm = redactSensitiveText(`GET https://delivery.example/d/${capabilityToken}?filename=x`);
  assert.ok(urlForm.includes('/d/[REDACTED]'), urlForm);
  assert.ok(!urlForm.includes(marker), urlForm);
  assert.equal(redactSensitiveText(`failed path /d/v1%2E${marker}%2E${'A'.repeat(180)}%2E${'B'.repeat(43)}`),
    'failed path /d/[REDACTED]');
  // A token smuggled into a query parameter is redacted by the key=value rule.
  const queryForm = redactSensitiveText(`GET /d/x?token=${capabilityToken}`);
  assert.ok(!queryForm.includes(marker), queryForm);
  // Error cause chains are serialized through the same redaction.
  const chained = new Error('delivery upstream failure', {
    cause: new Error('nested: /d/v1.abc.def', {
      cause: new Error(`leaf token ${capabilityToken}`),
    }),
  });
  const redactedChain = redactSensitiveText(chained);
  assert.ok(!redactedChain.includes(marker));
  assert.ok(!redactedChain.includes('v1.abc.def'), 'the capability segment must be redacted in every cause level');
  // Short `v1.x.y`-shaped version strings are NOT capability tokens and must
  // not be over-redacted.
  assert.equal(redactSensitiveText('schema v1.0.20 deployed'), 'schema v1.0.20 deployed');
  // Ordinary paths (no /d/ segment) and ordinary words survive.
  assert.equal(redactSensitiveText('check /opaque/path done'), 'check /opaque/path done');
});
