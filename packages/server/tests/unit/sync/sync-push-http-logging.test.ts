import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Problem } from '@know-n/colp/types';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { registerSyncPushRoutes, SyncPushHttpError } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { syncPushAdmissionRequest } from '../../fixtures/phase3/sync-push-admission.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'push-unit-secret-token-marker';
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

type CapturedError = { readonly bindings: Record<string, unknown>; readonly message: string };

function start(admit: () => Promise<never>, captured: CapturedError[]) {
  const app = Fastify({ logger: false });
  registerSyncPushRoutes(app, {
    path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN],
    logger: { error(bindings: Record<string, unknown>, message: string) {
      captured.push({ bindings, message });
    } },
    credentialVerifier: { async verify() {
      return mintVerifiedExtensionCredentialFixture({
        issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
        subject: 'push-subject', credentialId: 'push-credential',
      });
    } },
    application: {
      runtimeOwnership: { operationIdReservationOwner: 'sequence', usesPushCoordinator: false,
        maxBatchOperations: 1, evaluator: 'canonical_node_create' },
      admit,
    },
    rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
    allowInsecureLoopback: true,
  });
  apps.push(app);
  return app;
}

describe('P3-11 sync push unexpected-failure logging', () => {
  test('logs unexpected push failures as a bounded cause chain without request data', async () => {
    const captured: CapturedError[] = [];
    const app = start(async (): Promise<never> => {
      throw new TypeError('Sequence receipt was not persisted by the adapter',
        { cause: new TypeError('Adapter returned a terminal receipt at the expected Sequence') });
    }, captured);
    const response = await app.inject({
      method: 'POST', url: '/private-entry/operation-ingress',
      headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN,
        'content-type': 'application/json', 'idempotency-key': 'push-key-1' },
      payload: syncPushAdmissionRequest({ replicaId: 'REPLICA-SECRET', opId: 'OP-SECRET' }),
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json<Problem>().code, 'internal_error');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.message, 'unexpected sync push failure');
    const chain = captured[0]!.bindings.error as Array<Record<string, unknown>>;
    assert.equal(chain[0]?.name, 'TypeError');
    assert.match(String(chain[0]?.message), /receipt was not persisted/u);
    assert.equal(chain[1]?.name, 'TypeError');
    const serialized = JSON.stringify(captured[0]!.bindings);
    assert.doesNotMatch(serialized, /push-unit-secret|REPLICA-SECRET|OP-SECRET|Bearer/u);
  });

  test('logs internal_error folds that carry an unrecognized cause and skips stable outcomes', async () => {
    const captured: CapturedError[] = [];
    const failures: unknown[] = [
      new SyncPushHttpError('internal_error', undefined, undefined,
        { cause: new TypeError('Sequence lane state was not persisted by the adapter') }),
      new SyncPushHttpError('internal_error'),
      new SyncPushHttpError('unsupported_operation'),
      new SyncPushHttpError('sequence_gap', undefined, 1),
      new DatabaseOperationError('unavailable', new Error('db down')),
    ];
    const app = start(async (): Promise<never> => { throw failures.shift() ?? new Error('exhausted'); },
      captured);
    const expected = [500, 500, 422, 409, 503];
    for (const status of expected) {
      const response = await app.inject({
        method: 'POST', url: '/private-entry/operation-ingress',
        headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN,
          'content-type': 'application/json', 'idempotency-key': 'push-key-1' },
        payload: syncPushAdmissionRequest(),
      });
      assert.equal(response.statusCode, status);
    }
    // The folded internal_error carries its unrecognized cause in the chain; a
    // bare internal_error still records its throw-site stack; stable protocol
    // outcomes and database errors keep their quiet stable mapping.
    assert.equal(captured.length, 2);
    const folded = captured[0]!.bindings.error as Array<Record<string, unknown>>;
    assert.equal(folded[0]?.name, 'SyncPushHttpError');
    assert.equal(folded[1]?.name, 'TypeError');
    assert.match(String(folded[1]?.message), /lane state was not persisted/u);
    assert.equal(captured[1]!.bindings.error instanceof Array, true);
  });
});
