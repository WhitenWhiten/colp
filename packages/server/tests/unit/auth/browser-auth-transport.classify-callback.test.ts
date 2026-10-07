import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { IdentityError } from '../../../src/modules/identity/index.js';
import {
  classifyOidcCallbackFailure,
  OidcCallbackStageError,
} from '../../../src/transport/auth/browser-auth-routes.js';
import { OidcExchangeError } from '../../../src/transport/auth/oidc-provider.js';

describe('browser auth transport', () => {
  test('classifyOidcCallbackFailure maps stages to failed vs restart without leaking details', () => {
    const postDb = classifyOidcCallbackFailure(
      new OidcCallbackStageError(
        'post_exchange',
        new DatabaseOperationError('database_failure', new Error('db down')),
      ),
    );
    assert.equal(postDb.redirect, 'restart');
    assert.equal(postDb.class, 'transient_local');
    assert.equal(postDb.reason, 'database_failure');
    assert.doesNotMatch(postDb.reason, /db down/);

    const invalidGrant = classifyOidcCallbackFailure(
      new OidcCallbackStageError('pre_exchange', new OidcExchangeError('invalid_grant')),
    );
    assert.equal(invalidGrant.redirect, 'failed');
    assert.equal(invalidGrant.class, 'terminal');

    const tokenTransient = classifyOidcCallbackFailure(
      new OidcCallbackStageError('pre_exchange', new OidcExchangeError('token_endpoint_error')),
    );
    assert.equal(tokenTransient.redirect, 'restart');

    const replay = classifyOidcCallbackFailure(
      new OidcCallbackStageError(
        'pre_exchange',
        new IdentityError('transaction_consumed', 'already used'),
      ),
    );
    assert.equal(replay.redirect, 'failed');
    assert.equal(replay.class, 'terminal');

    const emailConflict = classifyOidcCallbackFailure(
      new OidcCallbackStageError(
        'post_exchange',
        new IdentityError('email_conflict', 'email taken'),
      ),
    );
    assert.equal(emailConflict.redirect, 'failed');
    assert.equal(emailConflict.class, 'terminal');
  });
});
