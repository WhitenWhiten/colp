import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  ACCOUNT_CREDENTIAL_SECRET_PATTERN,
  hashAccountCredentialSecret,
  issueAccountCredentialSecret,
  parseAccountCredentialSecret,
  verifyAccountCredentialSecretHash,
} from '../../../src/modules/auth/application/account-credentials/secret.js';

const CONTRACT_SECRET = /^kn_[pc]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/;

test('parent and child secrets match the frozen 71-character kn_p_/kn_c_ contract', () => {
  const parent = issueAccountCredentialSecret('parent');
  const child = issueAccountCredentialSecret('child');
  assert.equal(parent.secret.length, 71);
  assert.equal(child.secret.length, 71);
  assert.match(parent.secret, CONTRACT_SECRET);
  assert.match(child.secret, CONTRACT_SECRET);
  assert.match(parent.secret, /^kn_p_/u);
  assert.match(child.secret, /^kn_c_/u);
  assert.equal(ACCOUNT_CREDENTIAL_SECRET_PATTERN.source, CONTRACT_SECRET.source);
  assert.equal(parent.prefix.length <= 32, true);
  assert.match(parent.prefix, /^kn_p_[A-Za-z0-9_-]{22}$/u);
  assert.match(child.prefix, /^kn_c_[A-Za-z0-9_-]{22}$/u);
});

test('child secret material is independently random and not derivable from a parent secret', () => {
  const parent = issueAccountCredentialSecret('parent');
  const childA = issueAccountCredentialSecret('child');
  const childB = issueAccountCredentialSecret('child');
  assert.notEqual(parent.secret, childA.secret);
  assert.notEqual(childA.secret, childB.secret);
  assert.notEqual(parent.secretMaterial, childA.secretMaterial);
  assert.notEqual(childA.publicId, childB.publicId);
  assert.notEqual(childA.secret.slice(5, 27), parent.secret.slice(5, 27));
  assert.notEqual(childA.secret.slice(28), parent.secret.slice(28));
});

test('persisted material is a one-way hash; plaintext is not recoverable from the hash', () => {
  const issued = issueAccountCredentialSecret('parent');
  const digest = hashAccountCredentialSecret(issued.secret);
  assert.equal(digest, createHash('sha256').update(issued.secret, 'utf8').digest('hex'));
  assert.equal(digest.length, 64);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(digest.includes(issued.secret), false);
  assert.equal(digest.includes(issued.secretMaterial.toString('base64url')), false);
  assert.equal(verifyAccountCredentialSecretHash(issued.secret, digest), true);
  const mutated = `${issued.secret.slice(0, 70)}${issued.secret.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(verifyAccountCredentialSecretHash(mutated, digest), false);
  const parsed = parseAccountCredentialSecret(issued.secret);
  assert.equal(parsed.kind, 'parent');
  assert.equal(parsed.prefix, issued.prefix);
});

test('AC-F003 the stored hash is keyed HMAC when a deployment key is configured', () => {
  const SECRET = 'kn_c_abcdefghijklmnopqrstuv_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const bare = hashAccountCredentialSecret(SECRET);
  const keyed = hashAccountCredentialSecret(SECRET, 'deployment-hmac-key');
  // Keyed digestion breaks determinism from the bare SHA-256 construction.
  assert.notEqual(keyed, bare);
  assert.match(keyed, /^[0-9a-f]{64}$/u, 'HMAC-SHA256 hex satisfies the secret_hash CHECK');
  // Deterministic per (secret, key): same key -> same digest; wrong key -> miss.
  assert.equal(hashAccountCredentialSecret(SECRET, 'deployment-hmac-key'), keyed);
  assert.notEqual(hashAccountCredentialSecret(SECRET, 'other-key'), keyed);
});
