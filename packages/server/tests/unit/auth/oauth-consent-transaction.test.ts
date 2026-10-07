import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import {
  canonicalizeOAuthQueryParams,
  signedConsentTransactionFields,
  verifySignedOAuthQuery,
} from '../../../src/infrastructure/auth/oauth-consent-transaction.js';

const SECRET = 'test-better-auth-secret-0123456789abcdef'; // secret-scan: allow 'test-better-auth-secret-0123456789abcdef'

async function signQuery(params: URLSearchParams, secret = SECRET): Promise<string> {
  const next = new URLSearchParams(params);
  next.delete('sig');
  const signature = await makeSignature(canonicalizeOAuthQueryParams(next).toString(), secret);
  next.set('sig', signature);
  return next.toString();
}

test('canonicalizeOAuthQueryParams sorts keys and keeps duplicate values', () => {
  const params = new URLSearchParams();
  params.append('b', '2');
  params.append('a', '1');
  params.append('ba_param', 'sig');
  params.append('ba_param', 'exp');
  const canonical = canonicalizeOAuthQueryParams(params);
  assert.equal(canonical.toString(), 'a=1&b=2&ba_param=exp&ba_param=sig');
});

test('verifySignedOAuthQuery accepts a matching HMAC and future exp', async () => {
  const exp = Math.floor(Date.now() / 1_000) + 600;
  const signed = await signQuery(new URLSearchParams({
    client_id: 'https://cimd.example.test/.well-known/oauth-client',
    redirect_uri: 'https://cimd.example.test/callback',
    exp: String(exp),
  }));
  assert.equal(await verifySignedOAuthQuery(signed, SECRET), true);
  const fields = signedConsentTransactionFields(signed);
  assert.equal(fields?.clientId, 'https://cimd.example.test/.well-known/oauth-client');
  assert.equal(fields?.redirectUri, 'https://cimd.example.test/callback');
});

test('verifySignedOAuthQuery fails closed when sig is duplicated', async () => {
  const exp = Math.floor(Date.now() / 1_000) + 600;
  const signed = await signQuery(new URLSearchParams({
    client_id: 'https://cimd.example.test/.well-known/oauth-client',
    redirect_uri: 'https://cimd.example.test/callback',
    exp: String(exp),
  }));
  const duplicated = new URLSearchParams(signed);
  duplicated.append('sig', 'extra-sig');
  assert.equal(duplicated.getAll('sig').length, 2);
  assert.equal(await verifySignedOAuthQuery(duplicated.toString(), SECRET), false);
});

test('verifySignedOAuthQuery fails closed when sig is missing', async () => {
  const exp = Math.floor(Date.now() / 1_000) + 600;
  const unsigned = new URLSearchParams({
    client_id: 'https://cimd.example.test/.well-known/oauth-client',
    redirect_uri: 'https://evil.example/callback',
    exp: String(exp),
  }).toString();
  assert.equal(await verifySignedOAuthQuery(unsigned, SECRET), false);
});

test('verifySignedOAuthQuery fails closed when redirect_uri is mutated without a new sig', async () => {
  const exp = Math.floor(Date.now() / 1_000) + 600;
  const signed = await signQuery(new URLSearchParams({
    client_id: 'https://cimd.example.test/.well-known/oauth-client',
    redirect_uri: 'https://cimd.example.test/callback',
    exp: String(exp),
  }));
  const tampered = new URLSearchParams(signed);
  tampered.set('redirect_uri', 'https://evil.example/callback');
  assert.equal(await verifySignedOAuthQuery(tampered.toString(), SECRET), false);
});

test('verifySignedOAuthQuery fails closed when exp is in the past', async () => {
  const signed = await signQuery(new URLSearchParams({
    client_id: 'https://cimd.example.test/.well-known/oauth-client',
    redirect_uri: 'https://cimd.example.test/callback',
    exp: String(Math.floor(Date.now() / 1_000) - 30),
  }));
  assert.equal(await verifySignedOAuthQuery(signed, SECRET), false);
});

test('signedConsentTransactionFields never treats query client_name as the client id or redirect', () => {
  const fields = signedConsentTransactionFields(new URLSearchParams({
    client_id: 'https://cimd.example.test/.well-known/oauth-client',
    redirect_uri: 'https://cimd.example.test/callback',
    client_name: 'Evil App',
  }).toString());
  assert.equal(fields?.clientId, 'https://cimd.example.test/.well-known/oauth-client');
  assert.equal(fields?.redirectUri, 'https://cimd.example.test/callback');
  assert.equal('client_name' in (fields ?? {}), false);
});
