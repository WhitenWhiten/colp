/**
 * P4A-I15 credential rotation: the NEW credential works and the OLD credential
 * is REJECTED by the rotated store, with NO secret material in any output.
 *
 * Proves (with injected secret resolver + store builder):
 *  - rotation_verified for RW, RO, and control refs when the new credential
 *    works against the new store and the old credential is rejected there;
 *  - keeping the old credential (store still accepts it) NEVER yields a pass
 *    (old_credential_still_accepted) — anti-false-positive;
 *  - a new credential that is rejected yields new_credential_rejected;
 *  - provider retryable/timeout/5xx/unknown probe outcomes yield
 *    probe_inconclusive (environment), never a pass;
 *  - the resolver is asked for both the current and the new ref;
 *  - the result + step list + log entries contain no credential value (secret
 *    marker scan);
 *  - verifyOldCredentialRejected (post-revocation check) observes the old
 *    credential actually rejected by the live store.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  rotateAttachmentCredentials,
  verifyOldCredentialRejected,
  type AttachmentCredentialProbe,
  type AttachmentCredentialStoreBuilder,
  type AttachmentRotationLogEntry,
  type AttachmentRotationTarget,
} from '../../../src/modules/attachments/index.js';
import {
  credentialValueKey,
  makeBearerCredential,
  makeS3Credential,
  makeSecretResolver,
} from '../../support/phase4a-i15-test-helpers.js';

function makeStoreBuilder(validKeys: Set<string>): AttachmentCredentialStoreBuilder {
  return {
    build(_role: string, _credential: Parameters<AttachmentCredentialStoreBuilder['build']>[1]): AttachmentCredentialProbe {
      return {
        async probe(_role, candidate) {
          return validKeys.has(credentialValueKey(candidate))
            ? { ok: true, detail: 'ok' }
            : { ok: false, detail: 'denied' };
        },
      };
    },
  };
}

function rotationTarget(role: string, suffix = 'primary'): AttachmentRotationTarget {
  return {
    role: role as AttachmentRotationTarget['role'],
    currentSecretRef: `known/r2/${role}/${suffix}`,
    newSecretRef: `known/r2/${role}/${suffix}-next`,
  };
}

describe('P4A-I15 credential rotation', () => {
  test('rotation is verified for rw/ro/control when the new credential works and the old is rejected', async () => {
    for (const role of ['rw', 'ro', 'control'] as const) {
      const target = rotationTarget(role);
      const newValue = role === 'control'
        ? makeBearerCredential(`new-control-token-${role}`)
        : makeS3Credential(`AK-new-${role}`, `new-secret-${role}`);
      const oldValue = role === 'control'
        ? makeBearerCredential(`old-control-token-${role}`)
        : makeS3Credential(`AK-old-${role}`, `old-secret-${role}`);
      const resolver = makeSecretResolver({
        [target.newSecretRef]: newValue,
        [target.currentSecretRef]: oldValue,
      });
      // The rotated world contains ONLY the new credential.
      const builder = makeStoreBuilder(new Set([credentialValueKey(newValue)]));
      const result = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder });
      assert.equal(result.verdict, 'rotation_verified', role);
      assert.equal(result.newWorks, true, role);
      assert.equal(result.oldRejected, true, role);
      assert.equal(result.steps.length, 3);
      assert.ok(result.steps.every((step) => step.status === 'verified'));
      assert.deepEqual(resolver.resolvedRefs.sort(), [target.currentSecretRef, target.newSecretRef].sort());
    }
  });

  test('keeping the old credential in the store NEVER passes (old_credential_still_accepted)', async () => {
    const target = rotationTarget('rw');
    const newValue = makeS3Credential('AK-new', 'new-secret');
    const oldValue = makeS3Credential('AK-old', 'old-secret');
    const resolver = makeSecretResolver({
      [target.newSecretRef]: newValue,
      [target.currentSecretRef]: oldValue,
    });
    // The rotated world still accepts the OLD credential — rotation was not real.
    const builder = makeStoreBuilder(new Set([credentialValueKey(newValue), credentialValueKey(oldValue)]));
    const result = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder });
    assert.equal(result.verdict, 'old_credential_still_accepted');
    assert.equal(result.newWorks, true);
    assert.equal(result.oldRejected, false, 'the old credential must be observed rejected');
    assert.equal(result.steps.find((step) => step.step === 'verify_old_rejected')?.status, 'failed');
  });

  test('a new credential that is rejected yields new_credential_rejected', async () => {
    const target = rotationTarget('ro');
    const newValue = makeS3Credential('AK-new', 'new-secret');
    const oldValue = makeS3Credential('AK-old', 'old-secret');
    const resolver = makeSecretResolver({
      [target.newSecretRef]: newValue,
      [target.currentSecretRef]: oldValue,
    });
    const builder = makeStoreBuilder(new Set()); // new store accepts neither credential -> the NEW credential is rejected
    const result = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder });
    assert.equal(result.verdict, 'new_credential_rejected');
    assert.equal(result.oldRejected, true);
    assert.equal(result.steps[0]?.status, 'failed');
  });

  test('provider retryable/timeout/5xx/unknown probe outcomes are inconclusive, never a pass', async () => {
    const target = rotationTarget('control');
    const newValue = makeBearerCredential('new-token');
    const oldValue = makeBearerCredential('old-token');
    const resolver = makeSecretResolver({
      [target.newSecretRef]: newValue,
      [target.currentSecretRef]: oldValue,
    });
    const builder: AttachmentCredentialStoreBuilder = {
      build() {
        return {
          async probe() {
            return { ok: false, detail: 'provider_retryable' };
          },
        };
      },
    };
    const result = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder });
    assert.equal(result.verdict, 'probe_inconclusive');
    assert.equal(result.newWorks, false);
  });

  test('the rotation result, steps, and log entries never contain credential material', async () => {
    const marker = `rotation-secret-marker-${Date.now()}`;
    const target = rotationTarget('rw');
    const newValue = makeS3Credential(`AK-${marker}`, marker);
    const oldValue = makeS3Credential('AK-old', 'old-secret');
    const resolver = makeSecretResolver({
      [target.newSecretRef]: newValue,
      [target.currentSecretRef]: oldValue,
    });
    const builder = makeStoreBuilder(new Set([credentialValueKey(newValue)]));
    const logEntries: AttachmentRotationLogEntry[] = [];
    const result = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder, log: (entry) => logEntries.push(entry) });
    assert.equal(result.verdict, 'rotation_verified');
    for (const serialized of [JSON.stringify(result), JSON.stringify(logEntries)]) {
      assert.ok(!serialized.includes(marker), 'rotation outputs must never contain credential material');
      assert.ok(!serialized.includes('secretAccessKey'), 'no secret key field may be serialized');
    }
  });

  test('verifyOldCredentialRejected observes the old credential actually rejected post-revocation', async () => {
    const role = 'rw';
    const oldRef = 'known/r2/rw/primary';
    const oldValue = makeS3Credential('AK-old', 'old-secret');
    const resolver = makeSecretResolver({ [oldRef]: oldValue });
    // Post-revocation world: only the NEW credential exists; the old is rejected.
    const probe = makeStoreBuilder(new Set(['s3:AK-new:new-secret'])).build(role, oldValue);
    const result = await verifyOldCredentialRejected({ role, oldSecretRef: oldRef, resolver, probe });
    assert.equal(result.oldRejected, true);
    assert.equal(result.detail, 'denied');
    // If the old credential is still accepted, the verification must fail closed.
    const stillAccepted = makeStoreBuilder(new Set([credentialValueKey(oldValue)])).build(role, oldValue);
    const accepted = await verifyOldCredentialRejected({ role, oldSecretRef: oldRef, resolver, probe: stillAccepted });
    assert.equal(accepted.oldRejected, false);
  });
});
