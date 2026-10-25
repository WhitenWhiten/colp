import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { afterEach, test } from 'vitest';
import {
  parseReplicaHealthReport, ReplicaHealthError, type ReplicaHealthRecorder, type ReplicaHealthReport,
} from '../../../src/modules/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../src/modules/identity/index.js';
import {
  EXTENSION_REPLICA_HEALTH_PATH, registerExtensionReplicaHealthRoutes,
} from '../../../src/transport/colp-sync/extension-replica-health-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer replica-health-fixture';

function report(overrides: Record<string, unknown> = {}) {
  return { replicaId: 'replica-1', revision: 1_760_000_000_000, state: 'stopped', code: 'create_placement_unproven',
    since: '2026-10-17T10:00:00.000Z', issues: { total: 1, items: [{ issueId: 'issue-1',
      code: 'create_placement_unproven', direction: 'local', title: 'Recipes', count: 1,
      firstSeenAt: '2026-10-17T10:00:00Z', lastSeenAt: '2026-10-17T10:05:00+02:00', actions: ['retry', 'rebuild'] }] },
    extensionVersion: '0.2.0', ...overrides };
}

test('a replica report is a closed, bounded document', () => {
  const parsed = parseReplicaHealthReport(report());
  assert.equal(parsed.state, 'stopped');
  // Times are normalized to UTC; the issue keeps its display title.
  assert.equal(parsed.issues.items[0]!.lastSeenAt, '2026-10-17T08:05:00.000Z');
  assert.equal(parsed.issues.items[0]!.title, 'Recipes');
  const item = report().issues.items[0]!;
  for (const invalid of [
    report({ extra: true }), report({ code: undefined }), report({ state: 'broken' }), report({ code: 'Bad-Code' }),
    report({ revision: 0 }), report({ since: 'yesterday' }), report({ replicaId: 'has space' }),
    report({ issues: { total: 0, items: [item] } }),
    report({ issues: { total: 51, items: Array.from({ length: 51 }, (_, index) => ({ ...item, issueId: `i-${index}` })) } }),
    report({ issues: { total: 2, items: [item, item] } }),
    report({ issues: { total: 1, items: [{ ...item, actions: ['retry', 'retry'] }] } }),
    report({ issues: { total: 1, items: [{ ...item, actions: ['format_disk'] }] } }),
    report({ issues: { total: 1, items: [{ ...item, direction: 'sideways' }] } }),
    report({ issues: { total: 1, items: [{ ...item, nativeId: '42' }] } }),
    report({ issues: { total: 1, items: [{ ...item, title: 'x'.repeat(257) }] } }),
  ]) {
    assert.throws(() => parseReplicaHealthReport(invalid), (error: unknown) =>
      error instanceof ReplicaHealthError && error.code === 'invalid_document', JSON.stringify(invalid).slice(0, 120));
  }
  // Whole-replica actions and command results are bounded and closed too.
  const result = { commandId: 'cmd_1', outcome: 'done' };
  for (const invalid of [report({ actions: ['use_server'] }), report({ actions: ['retry', 'retry'] }),
    report({ commandResults: [{ ...result, outcome: 'maybe' }] }), report({ commandResults: [result, result] }),
    report({ commandResults: [{ ...result, code: 'Not A Code' }] }), report({ commandResults: [{ ...result, data: 1 }] }),
    report({ commandResults: Array.from({ length: 17 }, (_, index) => ({ ...result, commandId: `cmd_${index}` })) })]) {
    assert.throws(() => parseReplicaHealthReport(invalid), ReplicaHealthError, JSON.stringify(invalid).slice(0, 120));
  }
  const withResults = parseReplicaHealthReport(report({ actions: ['retry', 'rebuild'],
    commandResults: [result, { commandId: 'cmd_2', outcome: 'failed', code: 'rebuild_not_required' }] }));
  assert.deepEqual(withResults.actions, ['retry', 'rebuild']);
  assert.deepEqual(withResults.commandResults[1], { commandId: 'cmd_2', outcome: 'failed', code: 'rebuild_not_required' });
  assert.deepEqual(parseReplicaHealthReport(report()).actions, []);
  // A stop needs a reason; other states may omit it.
  assert.equal(parseReplicaHealthReport(report({ state: 'syncing', code: undefined })).code, undefined);
  // Display text that carries a credential or a native id is dropped, not stored.
  for (const title of ['Bearer abcdefghijklmnop12', 'Authorization: Basic dXNlcjpwYXNz', 'password: hunter2', 'my token=abc123xyz',
    'https://user:pass@example.test/a', 'https://example.test/cb?access_token=abcdef123456', 'native id 12',
    'javascript:alert(1)', 'sk_live_abcdefghijklmnop1234', '   ']) {
    const parsed = parseReplicaHealthReport(report({ issues: { total: 1, items: [{ ...item, title }] } }));
    assert.equal(parsed.issues.items[0]!.title, undefined, title);
  }
});

test('C-11: ordinary titles that merely contain a sensitive-sounding word or an address are kept', () => {
  const item = report().issues.items[0]!;
  for (const title of ['https://example.com/a', 'OAuth 2.0 Authorization Code Flow', 'Secret Santa 2026', 'Chrome: tips',
    'Bearer of good news', 'JavaScript: The Good Parts', 'Password manager comparison 2026', 'Token bucket algorithm',
    'How to rotate secrets in Vault', 'https://github.com/user/repo/issues/12?tab=readme', 'Native ID cards',
    'a-very-long-url-slug-for-an-article-about-bookmark-syncing-2026']) {
    const parsed = parseReplicaHealthReport(report({ issues: { total: 1, items: [{ ...item, title }] } }));
    assert.equal(parsed.issues.items[0]!.title, title);
  }
  // The purpose stays: a credential is recognised by its shape, wherever it sits.
  for (const title of ['https://example.com/#id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP',
    'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit']) {
    assert.equal(parseReplicaHealthReport(report({ issues: { total: 1, items: [{ ...item, title }] } })).issues.items[0]!.title,
      undefined, title);
  }
});

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function harness(record: ReplicaHealthRecorder['record']) {
  const credential = await mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example.test',
    audience: 'known-api', clientId: 'known-extension', subject: 'subject-1', credentialId: 'replica-health-credential' });
  const calls: Array<{ credential: VerifiedExtensionCredential; report: ReplicaHealthReport }> = [];
  const app = Fastify({ logger: false }); apps.push(app);
  registerExtensionReplicaHealthRoutes(app, {
    credentialVerifier: { async verify({ authorization }) {
      if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
      return credential;
    } },
    recorder: { async record(input) { calls.push(input); return record(input); }, async recordAckWarnings() {} },
    allowedOrigins: [ORIGIN],
  });
  const post = (body: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST',
    url: EXTENSION_REPLICA_HEALTH_PATH, payload: body as Record<string, unknown>,
    headers: { origin: ORIGIN, authorization: AUTHORIZATION, 'content-type': 'application/json', ...headers } });
  return { post, calls, credential };
}

test('the route needs the extension origin and a Sync credential, and maps recorder outcomes', async () => {
  let next: ReplicaHealthError | undefined;
  const { post, calls, credential } = await harness(async ({ report: input }) => {
    if (next) throw next;
    return { accepted: true, revision: input.revision, commands: [{ commandId: 'cmd_1', action: 'retry' }] };
  });
  const accepted = await post(report());
  assert.equal(accepted.statusCode, 200, accepted.body);
  // The response hands over what the owner asked of this browser.
  assert.deepEqual(accepted.json(), { replicaId: 'replica-1', revision: 1_760_000_000_000, accepted: true,
    commands: [{ commandId: 'cmd_1', action: 'retry' }] });
  assert.equal(calls[0]!.credential, credential);
  assert.equal((await post(report(), { origin: 'https://evil.example.test' })).statusCode, 403);
  assert.equal((await post(report(), { authorization: 'Bearer other' })).statusCode, 401);
  const invalid = await post(report({ state: 'stopped', code: undefined }));
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'invalid_document');
  for (const [code, status] of [['invalid_token', 401], ['resource_not_found', 404], ['replica_retired', 410]] as const) {
    next = new ReplicaHealthError(code);
    const denied = await post(report());
    assert.equal(denied.statusCode, status); assert.equal(denied.json().error.code, code);
  }
  assert.equal(calls.length, 4);
});

test('the route enforces the shared UTF-8 budget even without the product transport plugin', async () => {
  const { post, calls } = await harness(async ({ report }) => ({ accepted: true, revision: report.revision, commands: [] }));
  const item = report().issues.items[0]!;
  const oversized = report({ issues: { total: 50, items: Array.from({ length: 50 }, (_, n) => ({
    ...item, issueId: `issue-${n}`, nodeId: 'n'.repeat(128), opId: 'o'.repeat(128), title: '中'.repeat(200) })) } });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 32768);
  assert.equal((await post(oversized)).statusCode, 413);
  assert.throws(() => parseReplicaHealthReport(oversized), ReplicaHealthError);
  assert.equal(calls.length, 0);
});

test('retirement receipts require an explicit client capability negotiation', async () => {
  const { post, calls } = await harness(async ({ report, supportsFencedRebuild }) => ({ accepted: true,
    revision: report.revision, commands: [{ commandId: 'reset', action: 'rebuild',
      ...(supportsFencedRebuild ? { replicaRetired: true as const } : {}) }] }));
  assert.deepEqual((await post(report())).json().commands, [{ commandId: 'reset', action: 'rebuild' }]);
  assert.equal(calls[0]!.supportsFencedRebuild, false);
  const response = await post(report(), { 'known-sync-rebuild': 'retire' });
  assert.equal(calls[1]!.supportsFencedRebuild, true);
  assert.deepEqual(response.json().commands, [{ commandId: 'reset', action: 'rebuild', replicaRetired: true }]);
});
