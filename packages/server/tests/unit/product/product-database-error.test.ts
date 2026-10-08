import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { DatabaseOperationError, classifyDatabaseError } from '../../../src/infrastructure/database/errors.js';
import { buildApiApp, mapFrameworkError } from '../../../src/transport/app.js';

async function injectDatabaseFailure(error: DatabaseOperationError) {
  const app = buildApiApp({
    config: loadConfig({ DATABASE_URL: 'postgres://localhost/known',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
  });
  app.get('/test/database-failure', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async () => {
    throw error;
  });
  try {
    return await app.inject({ method: 'GET', url: '/test/database-failure' });
  } finally {
    await app.close();
  }
}

describe('Product database failure mapping', () => {
  for (const [sqlState, kind] of [
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock'],
    ['55P03', 'lock_timeout'],
  ] as const) {
    test(`maps ${sqlState} to a retryable Product outage`, () => {
      const failure = classifyDatabaseError(Object.assign(new Error('select secret from users'), { code: sqlState }));
      assert.equal(failure.kind, kind);
      const response = mapFrameworkError(failure);
      assert.equal(response.statusCode, 503);
      assert.equal(response.productCode, 'feature_temporarily_unavailable');
      assert.equal(response.sameRequestRetrySafe, true);
      assert.equal(response.retryAfterSeconds, 1);
      assert.deepEqual(response.headers, { 'Retry-After': '1' });
      assert.doesNotMatch(response.message, /secret|users|select/i);
    });
  }

  test('maps transport unavailability without exposing the driver message', () => {
    const failure = classifyDatabaseError(Object.assign(new Error('socket failed for db.internal'), { code: 'ECONNRESET' }));
    const response = mapFrameworkError(failure);
    assert.equal(response.statusCode, 503);
    assert.equal(response.productCode, 'feature_temporarily_unavailable');
    assert.doesNotMatch(response.message, /socket|db\.internal/i);
  });

  test('keeps commit outcome unknown generic and non-replay-safe', () => {
    const failure = new DatabaseOperationError('commit_outcome_unknown', new Error('commit response lost'));
    const response = mapFrameworkError(failure);
    assert.equal(response.statusCode, 500);
    assert.equal(response.productCode, 'internal_error');
    assert.equal(response.sameRequestRetrySafe, false);
    assert.doesNotMatch(response.message, /commit response lost/i);
  });

  test('does not turn unique violations into semantic conflicts', () => {
    const failure = new DatabaseOperationError('unique_violation', new Error('duplicate key value violates unique constraint'));
    const response = mapFrameworkError(failure);
    assert.equal(response.statusCode, 500);
    assert.equal(response.productCode, 'internal_error');
  });

  test('serializes retryable database failures as the complete Product 503 envelope', async () => {
    const response = await injectDatabaseFailure(new DatabaseOperationError(
      'serialization_failure',
      new Error('select secret from users'),
    ));

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '1');
    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    const body = response.json();
    assert.deepEqual(body, {
      error: {
        code: 'feature_temporarily_unavailable',
        message: 'The service is temporarily unavailable. Please retry the request.',
        requestId: body.error.requestId,
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        precondition: null,
        currentEtag: null,
        retryAfterSeconds: 1,
        fieldErrors: [],
      },
    });
    assert.equal(typeof body.error.requestId, 'string');
    assert.doesNotMatch(response.body, /select secret|users/i);
  });

  for (const kind of ['unique_violation', 'commit_outcome_unknown'] as const) {
    test(`serializes ${kind} as a generic Product 500 envelope`, async () => {
      const response = await injectDatabaseFailure(new DatabaseOperationError(
        kind,
        new Error('driver secret: transaction result'),
      ));

      assert.equal(response.statusCode, 500);
      assert.equal(response.headers['retry-after'], undefined);
      const body = response.json();
      assert.deepEqual(body, {
        error: {
          code: 'internal_error',
          message: 'The request could not be completed.',
          requestId: body.error.requestId,
          recovery: 'same_request',
          sameRequestRetrySafe: false,
          precondition: null,
          currentEtag: null,
          retryAfterSeconds: null,
          fieldErrors: [],
        },
      });
      assert.equal(typeof body.error.requestId, 'string');
      assert.doesNotMatch(response.body, /driver secret|transaction result/i);
    });
  }
});
