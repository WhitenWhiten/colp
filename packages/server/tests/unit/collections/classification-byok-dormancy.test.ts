import { expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { classificationSecretProtector } from '../../../src/infrastructure/collections/classification-services.js';

const secretKeys = [{ id: 'ring-1', version: 1, key: randomBytes(32) }];
const fingerprintKey = randomBytes(32);

/**
 * D4: with KNOWN_FEATURE_CLASSIFICATION_BYOK=false (the default) the secret
 * envelope protector must not be constructed at all, so no code path can reach
 * envelope decryption even when a keyring is still present in the environment.
 */
test('the secret protector is only constructed behind the BYOK gate', () => {
  expect(classificationSecretProtector({ byokEnabled: false, secretKeys, fingerprintKey })).toBeNull();
  expect(classificationSecretProtector({ secretKeys, fingerprintKey })).toBeNull();
  // A keyring without the fingerprint key is not a usable protector either.
  expect(classificationSecretProtector({ byokEnabled: true, secretKeys })).toBeNull();
  expect(classificationSecretProtector({ byokEnabled: true, fingerprintKey })).toBeNull();
  expect(classificationSecretProtector({ byokEnabled: true, secretKeys: [], fingerprintKey })).toBeNull();

  const protector = classificationSecretProtector({ byokEnabled: true, secretKeys, fingerprintKey });
  expect(protector).not.toBeNull();
  // The gate is not a shape check: the real protector encrypts for its binding.
  const envelope = protector!.protect('provider-secret', { ownerSubjectId: 'owner', profileId: 'profile' });
  return expect(protector!.withSecret(envelope, { ownerSubjectId: 'owner', profileId: 'profile' }, async secret => secret))
    .resolves.toBe('provider-secret');
});
