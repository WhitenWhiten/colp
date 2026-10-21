import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Kysely } from 'kysely';

import { createPostgresIdentityUnitOfWork, resolveIdentitySessionRotationSecrets } from '../../../src/infrastructure/identity/unit-of-work.js';
import { createPostgresIdentityPorts } from '../../../src/infrastructure/identity/repositories.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';

const predecessor = 'predecessor-cookie-material';
const sessionId = 'legacy-session-id';

test('two identity units with the same configured secret rebuild one successor', () => {
  const first = resolveIdentitySessionRotationSecrets({ sessionRotationSecrets: 'shared-rotation-secret' });
  const second = resolveIdentitySessionRotationSecrets({ sessionRotationSecrets: 'shared-rotation-secret' });
  assert.equal(
    first.deriveSuccessorToken(predecessor, sessionId),
    second.deriveSuccessorToken(predecessor, sessionId),
  );
});

test('legacy OIDC hmacSecret remains a stable rotation key when no explicit secret is set', () => {
  const oidc = {
    hmacSecret: 'stable-oidc-hmac-secret',
    encryptionKeys: [],
  };
  const first = resolveIdentitySessionRotationSecrets({ oidcTransactionSecrets: oidc });
  const second = resolveIdentitySessionRotationSecrets({ oidcTransactionSecrets: oidc });
  assert.equal(
    first.deriveSuccessorToken(predecessor, sessionId),
    second.deriveSuccessorToken(predecessor, sessionId),
  );
});

test('missing rotation material fails only when a successor is derived', () => {
  const db = {} as Kysely<DatabaseSchema>;
  assert.doesNotThrow(() => createPostgresIdentityUnitOfWork(db));
  const missing = resolveIdentitySessionRotationSecrets({});
  assert.throws(
    () => missing.deriveSuccessorToken(predecessor, sessionId),
    /sessionRotationSecrets is required/u,
  );
  const ports = createPostgresIdentityPorts({} as DatabaseTransaction, {
    digestState: () => 'unused',
    digestNonce: () => 'unused',
    verifyStateDigest: () => false,
    verifyNonceDigest: () => false,
    encryptPkceVerifier: () => { throw new Error('unused'); },
    decryptPkceVerifier: () => { throw new Error('unused'); },
  });
  assert.equal(typeof ports.accounts.findById, 'function');
  assert.throws(
    () => ports.sessionRotationSecrets.deriveSuccessorToken(predecessor, sessionId),
    /sessionRotationSecrets is required/u,
  );
});
