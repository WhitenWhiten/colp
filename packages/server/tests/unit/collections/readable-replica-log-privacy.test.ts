import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ReadableReplicaWorkerLoop } from '../../../src/infrastructure/collections/readable-replica-worker.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';

test('failed extraction logs diagnostics without source or redirect URL credentials', async () => {
  const secrets = ['source-path-secret', 'source-query-secret', 'redirect-path-secret',
    'redirect-token-secret', 'redirect-fragment-secret'];
  const source = `https://source.example/${secrets[0]}?api_key=${secrets[1]}`;
  const redirected = `https://redirect.example/${secrets[2]}?access_token=${secrets[3]}#${secrets[4]}`;
  let output = '';
  let completed = false;
  const worker = new ReadableReplicaWorkerLoop({
    repository: {
      async claimDue() { return [{ nodeId: 'private-node', url: source, leaseOwner: 'privacy-test' }]; },
      async completeExtract(input) {
        assert.equal(input.failureCode, 'not_html');
        completed = true;
        return true;
      },
    },
    logger: createLogger('info', { write(chunk) { output += chunk; } }),
    workerId: 'privacy-test', perHostGapMs: 0,
    resolve: async () => ['1.1.1.1'],
    connect: async (target) => target.url.hostname === 'source.example'
      ? new Response(null, { status: 302, headers: { location: redirected } })
      : new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
  });
  await worker.runOnce();
  assert.equal(completed, true);
  assert.ok(output.length > 0, 'the failure diagnostic must still be logged');
  for (const secret of secrets) assert.equal(output.includes(secret), false, `${secret} must not enter logs`);
  const entry = JSON.parse(output.trim());
  assert.equal(entry.nodeId, 'private-node');
  assert.equal(entry.failureCode, 'not_html');
  assert.equal(entry.hopCount, 2);
  assert.equal(Object.hasOwn(entry, 'hopUrls'), false);
});
