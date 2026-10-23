import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { test } from 'vitest';
import { inspectColpContractEvidence } from '../../../src/infrastructure/colp/contract-evidence.js';
import { createLogger, redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';

test('COLP evidence uses only public conformance exports and claims no deployment profile', () => {
  const evidence = inspectColpContractEvidence();
  assert.equal(evidence.evidence, 'colp_public_contract');
  assert.equal(evidence.publicEntrypoint, '@know-n/colp/conformance');
  assert.ok(evidence.bundledEvidenceAvailable);
  assert.ok(evidence.requirementCount > 0);
  assert.ok(evidence.deploymentProbeCount > 0);
  assert.deepEqual(evidence.claimedProfiles, []);
});

test('structured logs redact credentials and raw request secrets', () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  createLogger('info', stream).info({
    req: { headers: { authorization: 'Bearer should-not-appear', cookie: 'session=hidden' } },
    databaseUrl: 'postgres://user:password@host/db',
    token: 'secret-token', // secret-scan: allow 'secret-token' -- intentional redaction sentinel
    rawHeaderPairs: [
      ['Authorization', 'Bearer raw-auth-value'],
      ['Cookie', 'session=raw-cookie-value'],
      ['X-CSRF-Token', 'raw-csrf-value'],
      ['Origin', 'https://known.example'],
    ],
  }, 'probe');
  const line = Buffer.concat(chunks).toString('utf8');
  assert.doesNotMatch(line, /should-not-appear|session=hidden|postgres:\/\/user:password|secret-token|raw-auth-value|raw-cookie-value|raw-csrf-value/);
  assert.match(line, /https:\/\/known\.example/);
  assert.ok((line.match(/\[REDACTED\]/g) ?? []).length >= 3);
});

test('Fastify request logs omit OIDC callback query secrets', async () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const app = Fastify({
    loggerInstance: createLogger('info', stream) as FastifyBaseLogger,
  });
  app.get('/api/v1/auth/oidc/callback', async () => ({ ok: true }));

  await app.inject({
    method: 'GET',
    url: '/api/v1/auth/oidc/callback?state=raw-state-secret&code=raw-authorization-code',
  });
  await app.close();

  const output = Buffer.concat(chunks).toString('utf8');
  assert.doesNotMatch(output, /raw-state-secret|raw-authorization-code/);
  assert.match(output, /"url":"\/api\/v1\/auth\/oidc\/callback"/);
  assert.doesNotMatch(output, /"url":"[^"]*\?/);
});

test('handler error text redaction covers credentials before logging or persistence', () => {
  const cause = Object.assign(new Error(
    'postgres://known:db-password@localhost/known Authorization=Bearer handler-token',
  ), { code: 'ECONNREFUSED' });
  const redacted = redactSensitiveText(new TypeError('fetch failed', { cause }));
  assert.doesNotMatch(redacted, /db-password|handler-token/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /TypeError: fetch failed; cause: Error \[ECONNREFUSED\]/);
});

