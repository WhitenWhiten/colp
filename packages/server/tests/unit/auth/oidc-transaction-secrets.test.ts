/**
 * Task 05/06: keyed digests, AEAD PKCE, key rotation, tamper detection, log redaction.
 * Materialize is protected-only after contract (no plaintext dual-read).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'vitest';
import { redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';
import {
  createOidcTransactionSecrets,
  createSessionRotationSecrets,
  createTestOidcTransactionSecrets,
  materializeOidcLoginTransactionForUse,
  parseOidcEncryptionKeysEnv,
  type OidcLoginTransaction,
} from '../../../src/modules/identity/index.js';

describe('OIDC transaction secret protection', () => {
  test('session rotation successors require a server-held secret', () => {
    const predecessor = 'stolen-predecessor-cookie-material';
    const sessionId = 'legacy-session-id';
    const firstReplica = createSessionRotationSecrets('shared-server-secret-a');
    const secondReplica = createSessionRotationSecrets('shared-server-secret-a');
    const otherDeployment = createSessionRotationSecrets('different-server-secret-b');

    const successor = firstReplica.deriveSuccessorToken(predecessor, sessionId);
    assert.equal(secondReplica.deriveSuccessorToken(predecessor, sessionId), successor);
    assert.notEqual(otherDeployment.deriveSuccessorToken(predecessor, sessionId), successor);

    const predecessorOnlyGuess = createHmac('sha256', predecessor)
      .update(`known-session-rotation-v1\0${sessionId}`, 'utf8')
      .digest('base64url');
    assert.notEqual(predecessorOnlyGuess, successor);
  });

  test('keyed digests verify correctly and reject wrong values', () => {
    const secrets = createTestOidcTransactionSecrets();
    const state = 'browser-state-value-abcdefghijklmnopqrstuvwxyz';
    const nonce = 'browser-nonce-value-abcdefghijklmnopqrstuvwxyz';
    const stateDigest = secrets.digestState(state);
    const nonceDigest = secrets.digestNonce(nonce);

    assert.equal(stateDigest.length, 64);
    assert.equal(nonceDigest.length, 64);
    assert.notEqual(stateDigest, nonceDigest);
    assert.equal(secrets.verifyStateDigest(state, stateDigest), true);
    assert.equal(secrets.verifyNonceDigest(nonce, nonceDigest), true);
    assert.equal(secrets.verifyStateDigest('wrong-state-value-xxxx', stateDigest), false);
    assert.equal(secrets.verifyNonceDigest(state, nonceDigest), false);
    // Cross-purpose: state digest must not verify as nonce.
    assert.equal(secrets.verifyNonceDigest(state, stateDigest), false);
  });

  test('different HMAC secrets produce different digests', () => {
    const a = createTestOidcTransactionSecrets({ hmacSecret: 'secret-a-for-digest-tests' });
    const b = createTestOidcTransactionSecrets({ hmacSecret: 'secret-b-for-digest-tests' });
    const value = 'shared-browser-state-material-xx';
    assert.notEqual(a.digestState(value), b.digestState(value));
  });

  test('PKCE ciphertext is unique per encrypt and decrypts; tamper is detected', () => {
    const secrets = createTestOidcTransactionSecrets();
    const verifier = 'pkce-code-verifier-abcdefghijklmnopqrstuv';
    const first = secrets.encryptPkceVerifier(verifier);
    const second = secrets.encryptPkceVerifier(verifier);
    assert.notEqual(
      first.ciphertext.toString('base64'),
      second.ciphertext.toString('base64'),
      'identical plaintext must not yield identical ciphertext (random IV)',
    );
    assert.equal(
      secrets.decryptPkceVerifier(first.ciphertext, first.keyId, first.keyVersion),
      verifier,
    );
    assert.equal(
      secrets.decryptPkceVerifier(second.ciphertext, second.keyId, second.keyVersion),
      verifier,
    );

    const tampered = Buffer.from(first.ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(
      () => secrets.decryptPkceVerifier(tampered, first.keyId, first.keyVersion),
      /authentication|tampered|malformed/i,
    );
  });

  test('key rotation: old-key ciphertext decrypts after current key rotates', () => {
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    const writer = createOidcTransactionSecrets({
      hmacSecret: 'rotation-hmac-secret',
      encryptionKeys: [{ id: 'oidc-pkce-v1', version: 1, key: oldKey }],
    });
    const verifier = 'rotating-pkce-verifier-abcdefghijklmnopqrst';
    const sealed = writer.encryptPkceVerifier(verifier);

    const rotated = createOidcTransactionSecrets({
      hmacSecret: 'rotation-hmac-secret',
      encryptionKeys: [
        { id: 'oidc-pkce-v2', version: 2, key: newKey },
        { id: 'oidc-pkce-v1', version: 1, key: oldKey },
      ],
    });
    assert.equal(
      rotated.decryptPkceVerifier(sealed.ciphertext, sealed.keyId, sealed.keyVersion),
      verifier,
    );

    const fresh = rotated.encryptPkceVerifier(verifier);
    assert.equal(fresh.keyId, 'oidc-pkce-v2');
    assert.equal(fresh.keyVersion, 2);
    assert.equal(
      rotated.decryptPkceVerifier(fresh.ciphertext, fresh.keyId, fresh.keyVersion),
      verifier,
    );
  });

  test('parseOidcEncryptionKeysEnv accepts version:id:base64 lists', () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    const parsed = parseOidcEncryptionKeysEnv(`2:current:${key},1:previous:${key}`);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.id, 'current');
    assert.equal(parsed[0]?.version, 2);
    assert.equal(parsed[1]?.id, 'previous');
  });

  test('materialize recovers PKCE for protected rows and rejects state digest mismatch', () => {
    const secrets = createTestOidcTransactionSecrets();
    const browserState = 'materialize-state-abcdefghijklmnopqrst';
    const verifier = 'materialize-verifier-abcdefghijklmnopqrs';
    const sealed = secrets.encryptPkceVerifier(verifier);
    const row: OidcLoginTransaction = {
      state: secrets.digestState(browserState),
      nonce: '',
      codeVerifier: '',
      returnTo: '/',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      codeChallengeMethod: 'S256',
      stateHash: secrets.digestState(browserState),
      nonceHash: secrets.digestNonce('materialize-nonce-abcdefghijklmnopqrst'),
      pkceVerifierCiphertext: sealed.ciphertext,
      encryptionKeyId: sealed.keyId,
      encryptionKeyVersion: sealed.keyVersion,
    };
    const material = materializeOidcLoginTransactionForUse(row, browserState, secrets);
    assert.equal(material.state, browserState);
    assert.equal(material.codeVerifier, verifier);
    assert.throws(
      () => materializeOidcLoginTransactionForUse(row, 'wrong-browser-state-value-xx', secrets),
      /mismatch/i,
    );
  });

  test('log redaction strips OIDC browser secrets from free text', () => {
    const sample =
      'callback failed?state=VerySecretStateValue123&code=AuthorizationCodeValue0123&nonce=VerySecretNonceValue456&code_verifier=pkceSecretVerifierValue789&token=abc';
    const redacted = redactSensitiveText(sample);
    assert.doesNotMatch(redacted, /VerySecretStateValue123/);
    assert.doesNotMatch(redacted, /VerySecretNonceValue456/);
    assert.doesNotMatch(redacted, /pkceSecretVerifierValue789/);
    assert.doesNotMatch(redacted, /AuthorizationCodeValue0123/);
    assert.match(redacted, /state=\[REDACTED\]/i);
    assert.match(redacted, /nonce=\[REDACTED\]/i);
    assert.match(redacted, /code_verifier=\[REDACTED\]/i);
    assert.match(redacted, /code=\[REDACTED\]/i);
  });
});
