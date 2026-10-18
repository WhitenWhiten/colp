import 'fake-indexeddb/auto';
import { MemoryStorageArea } from '../src/credential-store.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';
import { fitReplicaHealthBody } from '../src/sw/replica-health-report.js';
import { REPLICA_HEALTH_MAX_BODY_BYTES, REPLICA_HEALTH_MAX_ITEMS } from '../src/generated/replica-health-limits.js';

test('both reporters and server limits are generated from the same checked source', () => {
  execFileSync(process.execPath, ['../../scripts/generate-replica-health-limits.mjs', '--check']);
});
for (const title of ['中'.repeat(200), '😀'.repeat(128), '\\"\n\t'.repeat(64)]) {
  test(`complete UTF-8 report fits with titles ${JSON.stringify(title.slice(0, 4))}, long IDs and all command results`, () => {
    const body = { replicaId: 'r'.repeat(128), revision: 1, state: 'stopped', code: 'record_too_large',
      since: new Date(0).toISOString(), actions: ['rebuild'], extensionVersion: '1'.repeat(32),
      commandResults: Array.from({ length: 16 }, (_, n) => ({ commandId: `${n}`.padEnd(128, 'c'),
        outcome: 'done', code: 'c'.repeat(64) })),
      issues: { total: 200, items: Array.from({ length: 50 }, (_, n) => ({ issueId: `${n}`.padEnd(128, 'i'),
        nodeId: `${n}`.padEnd(128, 'n'), opId: `${n}`.padEnd(128, 'o'), code: 'c'.repeat(64), direction: 'pull', title,
        count: 1, firstSeenAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(), actions: [] })) } };
    const result = fitReplicaHealthBody(body);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REPLICA_HEALTH_MAX_BODY_BYTES);
    assert.ok(result.issues.items.length <= REPLICA_HEALTH_MAX_ITEMS);
    assert.ok(result.issues.items.length < 50);
    assert.equal(result.issues.total, 200);
    assert.deepEqual(result.commandResults, body.commandResults);
    assert.deepEqual(result.actions, ['rebuild']);
    assert.deepEqual(result.issues.items, body.issues.items.slice(0, result.issues.items.length));
    assert.deepEqual(fitReplicaHealthBody(body), result);
    const oneMore = { ...result, issues: { ...result.issues, items: body.issues.items.slice(0, result.issues.items.length + 1) } };
    assert.ok(Buffer.byteLength(JSON.stringify(oneMore)) > REPLICA_HEALTH_MAX_BODY_BYTES);
  });
}

installKns05IndexedDb();
test('review: fifty legal Unicode item titles must fit the server health body budget', async () => {
  const f = await setup();
  try {
    let body = '';
    await sendReplicaHealthReport({ scope, store: { ...f.store, listPullIssues: async () =>
      Array.from({ length: 50 }, (_, n) => ({ nodeId: `node-${n}`, code: 'record_too_large', eventId: `event-${n}`,
        title: '中'.repeat(200), count: 1, firstSeenAt: 1, lastSeenAt: 1 })) },
      mode: async () => 'enabled', credential: async () => ({ accessToken: 'token', serverOrigin: scope.serverOrigin }),
      storage: new MemoryStorageArea(), origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', now: () => 1000,
      fetch: async (_url, init) => { body = String(init?.body); return new Response('{}', { status: 200 }); } });
    assert.ok(Buffer.byteLength(body, 'utf8') <= 32_768, `actual bytes: ${Buffer.byteLength(body, 'utf8')}`);
  } finally { f.store.close(); }
});

