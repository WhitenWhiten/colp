import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import {
  ExtensionAuthError,
  createExtensionCredentialEvidenceVerifier,
  isVerifiedExtensionCredential,
  createPkceAuthorizationFlow,
  parseExtensionAuthConfig,
  parseSingleBearerAuthorization,
  pollDeviceAuthorizationGrant,
  verifyPkceIdToken,
  type ExtensionAuthConfig,
  type ExtensionJwksProvider,
  type DevicePollResponse,
} from '../../../src/modules/identity/extension-auth.js';

const FIXTURE_PATH = resolve('tests/fixtures/phase3/extension-auth.json');
const MV3_PATH = resolve('tests/fixtures/phase3/mv3-extension');
const NOW = new Date('2026-07-25T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
}

async function config(): Promise<ExtensionAuthConfig> {
  return parseExtensionAuthConfig(await fixture());
}

async function expectReason(run: () => unknown | Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(async () => run(), (error: unknown) => {
    assert.ok(error instanceof ExtensionAuthError);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe('P3-01 strict public-client configuration', () => {
  test('accepts the fixed extension ID, exact redirect origin, issuer and asymmetric algorithm', async () => {
    const parsed = await config();
    assert.equal(parsed.flow, 'authorization_code_pkce');
    assert.equal(parsed.redirectUri, 'https://pplpnpegpnghcddhmpgkbfkdfadjiaen.chromiumapp.org/oauth2');
    assert.deepEqual(parsed.allowedExtensionIds, ['pplpnpegpnghcddhmpgkbfkdfadjiaen']);
    assert.deepEqual(parsed.allowedRedirectOrigins, ['https://pplpnpegpnghcddhmpgkbfkdfadjiaen.chromiumapp.org']);
    assert.deepEqual(parsed.allowedAlgorithms, ['RS256']);
    assert.equal('deviceAuthorizationEndpoint' in parsed, false);
  });

  test('rejects client secrets, wildcard origins, non-HTTPS issuer and mismatched extension identity', async () => {
    await expectReason(
      async () => parseExtensionAuthConfig({ ...await fixture(), clientSecret: 'x' }),
      'client_secret_forbidden',
    );
    await expectReason(
      async () => parseExtensionAuthConfig({ ...await fixture(), redirectUrI: 'typo-must-fail' }),
      'invalid_config',
    );
    await expectReason(
      async () => parseExtensionAuthConfig({ ...await fixture(), redirectOrigins: ['*'] }),
      'invalid_config',
    );
    await expectReason(
      async () => parseExtensionAuthConfig({ ...await fixture(), issuer: 'http://issuer.example.test/' }),
      'invalid_config',
    );
    await expectReason(
      async () => parseExtensionAuthConfig({ ...await fixture(), evidenceTtlSeconds: 61 }),
      'invalid_config',
    );
    await expectReason(
      async () => parseExtensionAuthConfig({ ...await fixture(), extensionIds: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] }),
      'redirect_not_allowed',
    );
    await expectReason(
      async () => parseExtensionAuthConfig({
        ...await fixture(), tokenEndpoint: 'https://token.evil.example/oauth2/token',
      }),
      'invalid_config',
    );
  });
});

describe('P3-01 Authorization Code + PKCE transaction', () => {
  test('uses S256, high-entropy verifier, one-time state/nonce, exact redirect and no secret', async () => {
    const cfg = await config();
    const flow = createPkceAuthorizationFlow(cfg);
    const first = await flow.begin();
    const second = await flow.begin();
    assert.notEqual(first.state, second.state);
    assert.notEqual(first.nonce, second.nonce);
    assert.equal(first.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(first.authorizationUrl.searchParams.get('redirect_uri'), cfg.redirectUri);
    assert.equal(first.authorizationUrl.searchParams.has('client_secret'), false);

    const completed = await flow.complete({
      transactionId: first.transactionId,
      redirectUrl: `${cfg.redirectUri}?code=fixed-code&state=${first.state}`,
    });
    assert.equal(completed.authorizationCode, 'fixed-code');
    assert.match(completed.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(
      createHash('sha256').update(completed.codeVerifier).digest('base64url'),
      first.authorizationUrl.searchParams.get('code_challenge'),
    );
    assert.equal(completed.expectedNonce, first.nonce);
    await expectReason(() => flow.complete({
      transactionId: first.transactionId,
      redirectUrl: `${cfg.redirectUri}?code=replay&state=${first.state}`,
    }), 'transaction_consumed');
  });

  test('fails closed for state mismatch, redirect mismatch and user cancellation', async () => {
    const cfg = await config();
    const flow = createPkceAuthorizationFlow(cfg);
    const wrongState = await flow.begin();
    await expectReason(() => flow.complete({
      transactionId: wrongState.transactionId,
      redirectUrl: `${cfg.redirectUri}?code=fixed&state=wrong`,
    }), 'state_mismatch');

    const wrongRedirect = await flow.begin();
    await expectReason(() => flow.complete({
      transactionId: wrongRedirect.transactionId,
      redirectUrl: `https://evil.example/oauth2?code=fixed&state=${wrongRedirect.state}`,
    }), 'redirect_mismatch');

    const cancelled = await flow.begin();
    flow.cancel(cancelled.transactionId);
    await expectReason(() => flow.complete({
      transactionId: cancelled.transactionId,
      redirectUrl: `${cfg.redirectUri}?code=fixed&state=${cancelled.state}`,
    }), 'login_cancelled');
  });

  test('verifies the ID token nonce and rejects a mismatched nonce', async () => {
    const cfg = await config();
    const keys = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    Object.assign(jwk, { kid: 'id-token', alg: 'RS256', use: 'sig' });
    const jwks: ExtensionJwksProvider = { async getKeySet() { return { keys: [jwk] }; } };
    const mint = (nonce: string) => new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'id-token' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.clientId).setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 300).sign(keys.privateKey);

    const verified = await verifyPkceIdToken({
      token: await mint('expected-nonce'), config: cfg, expectedNonce: 'expected-nonce', jwks, now: NOW,
    });
    assert.equal(verified.subject, 'account-subject');
    assert.equal(verified.nonce, 'expected-nonce');
    const mismatchedNonceToken = await mint('wrong-nonce');
    await expectReason(() => verifyPkceIdToken({
      token: mismatchedNonceToken, config: cfg, expectedNonce: 'expected-nonce', jwks, now: NOW,
    }), 'wrong_nonce');
  });
});

describe('P3-01 Authorization header and verified credential evidence', () => {
  test('accepts exactly one Bearer field and rejects repeated/combined headers', () => {
    assert.equal(parseSingleBearerAuthorization('Bearer opaque-token'), 'opaque-token');
    assert.equal(
      parseSingleBearerAuthorization('Bearer baSessionToken.dGVzdHNpZw%3D%3D'),
      'baSessionToken.dGVzdHNpZw==',
    );
    assert.equal(
      parseSingleBearerAuthorization('Bearer abc.def%2Bghi%2Fjk=='),
      'abc.def+ghi/jk==',
    );
    assert.equal(
      parseSingleBearerAuthorization('Bearer __Host-known_session=baSessionToken.dGVzdHNpZw=='),
      'baSessionToken.dGVzdHNpZw==',
    );
    assert.throws(() => parseSingleBearerAuthorization(['Bearer one', 'Bearer two']), ExtensionAuthError);
    assert.throws(() => parseSingleBearerAuthorization('Bearer one, Bearer two'), ExtensionAuthError);
    assert.throws(() => parseSingleBearerAuthorization('Basic abc'), ExtensionAuthError);
  });

  test('verifies signature, issuer, audience, scope, expiry, revocation and key rotation', async () => {
    const cfg = await config();
    const oldKeys = await generateKeyPair('RS256', { extractable: true });
    const newKeys = await generateKeyPair('RS256', { extractable: true });
    const oldJwk = await exportJWK(oldKeys.publicKey);
    const newJwk = await exportJWK(newKeys.publicKey);
    Object.assign(oldJwk, { kid: 'old', alg: 'RS256', use: 'sig' });
    Object.assign(newJwk, { kid: 'new', alg: 'RS256', use: 'sig' });
    const calls: boolean[] = [];
    const jwks: ExtensionJwksProvider = {
      async getKeySet(options = {}): Promise<JSONWebKeySet> {
        calls.push(options.forceRefresh === true);
        return options.forceRefresh ? { keys: [oldJwk, newJwk] } : { keys: [oldJwk] };
      },
    };
    const token = await new SignJWT({ scope: 'openid known.sync profile', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' })
      .setIssuer(cfg.issuer)
      .setSubject('account-subject')
      .setAudience(cfg.audience)
      .setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 300)
      .setJti('access-token-1')
      .sign(newKeys.privateKey);

    const verifier = createExtensionCredentialEvidenceVerifier({
      config: cfg,
      jwks,
      requiredScopes: ['known.sync'],
      isRevoked: async () => false,
      now: () => NOW,
    });
    const evidence = await verifier.verify({ authorization: `Bearer ${token}` });
    assert.equal(isVerifiedExtensionCredential(evidence), true);
    assert.equal(isVerifiedExtensionCredential({ ...evidence }), false);
    assert.equal(isVerifiedExtensionCredential({ kind: 'verified_extension_credential' }), false);
    assert.equal(evidence.kind, 'verified_extension_credential');
    assert.equal(evidence.subject, 'account-subject');
    assert.deepEqual(evidence.scopes, ['known.sync', 'openid', 'profile']);
    assert.equal(evidence.credentialId, 'access-token-1');
    assert.match(evidence.credentialDigest, /^[A-Za-z0-9_-]{43}$/);
    assert.equal('token' in evidence, false);
    assert.equal(evidence.evidenceExpiresAt.getTime() - NOW.getTime(), 60_000);
    assert.deepEqual(calls, [false, true]);

    const noExplicitScopeVerifier = createExtensionCredentialEvidenceVerifier({
      config: cfg, jwks, requiredScopes: [], isRevoked: async () => false, now: () => NOW,
    });
    const profileOnlyToken = await new SignJWT({ scope: 'profile', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 300).setJti('profile-only').sign(newKeys.privateKey);
    await expectReason(
      () => noExplicitScopeVerifier.verify({ authorization: `Bearer ${profileOnlyToken}` }),
      'missing_scope',
    );
    assert.throws(() => createExtensionCredentialEvidenceVerifier({
      config: cfg, jwks, requiredScopes: ['keys:write'], isRevoked: async () => false, now: () => NOW,
    }), (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_config');

    const overScopedToken = await new SignJWT({
      scope: 'known.sync keys:write', client_id: cfg.clientId,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 300).setJti('over-scoped').sign(newKeys.privateKey);
    await expectReason(
      () => verifier.verify({ authorization: `Bearer ${overScopedToken}` }),
      'invalid_token',
    );

    for (const [claims, reason] of [
      [{ iss: 'https://evil.example/', aud: cfg.audience, scope: 'known.sync' }, 'wrong_issuer'],
      [{ iss: cfg.issuer, aud: 'wrong-api', scope: 'known.sync' }, 'wrong_audience'],
      [{ iss: cfg.issuer, aud: cfg.audience, scope: 'profile' }, 'missing_scope'],
    ] as const) {
      const rejected = await new SignJWT({ ...claims, client_id: cfg.clientId })
        .setProtectedHeader({ alg: 'RS256', kid: 'new' })
        .setSubject('account-subject').setIssuedAt(NOW_SECONDS - 10)
        .setExpirationTime(NOW_SECONDS + 300).setJti(`reject-${reason}`).sign(newKeys.privateKey);
      await expectReason(() => verifier.verify({ authorization: `Bearer ${rejected}` }), reason);
    }

    const expired = await new SignJWT({ scope: 'known.sync', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS - 600)
      .setExpirationTime(NOW_SECONDS - 60).setJti('expired').sign(newKeys.privateKey);
    await expectReason(() => verifier.verify({ authorization: `Bearer ${expired}` }), 'expired');

    const expiredWithinSkew = await new SignJWT({ scope: 'known.sync', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS - 600)
      .setExpirationTime(NOW_SECONDS - 10).setJti('expired-within-skew').sign(newKeys.privateKey);
    await expectReason(() => verifier.verify({ authorization: `Bearer ${expiredWithinSkew}` }), 'expired');

    const futureIssued = await new SignJWT({ scope: 'known.sync', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS + 300)
      .setExpirationTime(NOW_SECONDS + 600).setJti('future-issued').sign(newKeys.privateKey);
    await expectReason(() => verifier.verify({ authorization: `Bearer ${futureIssued}` }), 'invalid_token');

    const invalidSignature = await new SignJWT({ scope: 'known.sync', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'RS256', kid: 'new' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 300).setJti('bad-signature').sign(oldKeys.privateKey);
    await expectReason(() => verifier.verify({ authorization: `Bearer ${invalidSignature}` }), 'invalid_signature');

    const symmetricToken = await new SignJWT({ scope: 'known.sync', client_id: cfg.clientId })
      .setProtectedHeader({ alg: 'HS256', kid: 'symmetric' }).setIssuer(cfg.issuer)
      .setSubject('account-subject').setAudience(cfg.audience).setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 300).setJti('symmetric')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    await expectReason(() => verifier.verify({ authorization: `Bearer ${symmetricToken}` }), 'disallowed_algorithm');

    const revokedVerifier = createExtensionCredentialEvidenceVerifier({
      config: cfg, jwks, requiredScopes: ['known.sync'], isRevoked: async () => true, now: () => NOW,
    });
    await expectReason(() => revokedVerifier.verify({ authorization: `Bearer ${token}` }), 'revoked');
  });
});

describe('P3-01 Device Authorization Grant candidate', () => {
  test('honors interval and slow_down then returns an authorized token response', async () => {
    const delays: number[] = [];
    const outcomes = [
      { error: 'authorization_pending' as const },
      { error: 'slow_down' as const },
      { access_token: 'opaque', token_type: 'Bearer' as const, expires_in: 300 },
    ];
    const result = await pollDeviceAuthorizationGrant({
      deviceCode: 'device-code', intervalSeconds: 2, expiresInSeconds: 30,
      poll: async () => outcomes.shift()!, sleep: async (ms) => { delays.push(ms); },
      now: (() => { let ms = 0; return () => { ms += 1_000; return ms; }; })(),
    });
    assert.equal(result.access_token, 'opaque');
    assert.deepEqual(delays, [2_000, 2_000, 7_000]);
  });

  test('stops on expiry and cancellation without an extra poll', async () => {
    let polls = 0;
    await expectReason(() => pollDeviceAuthorizationGrant({
      deviceCode: 'device-code', intervalSeconds: 1, expiresInSeconds: 3,
      poll: async () => { polls += 1; return { error: 'authorization_pending' }; },
      sleep: async () => undefined,
      now: (() => { let ms = 0; return () => { ms += 1_000; return ms; }; })(),
    }), 'device_code_expired');
    assert.equal(polls, 1);

    const controller = new AbortController();
    controller.abort();
    await expectReason(() => pollDeviceAuthorizationGrant({
      deviceCode: 'device-code', intervalSeconds: 1, expiresInSeconds: 30,
      poll: async () => ({ error: 'authorization_pending' }), sleep: async () => undefined,
      signal: controller.signal,
    }), 'login_cancelled');
  });

  test('enforces a finite polling cap and rejects malformed success responses', async () => {
    let cappedPolls = 0;
    await expectReason(() => pollDeviceAuthorizationGrant({
      deviceCode: 'device-code', intervalSeconds: 2, expiresInSeconds: 5,
      poll: async () => { cappedPolls += 1; return { error: 'authorization_pending' }; },
      sleep: async () => undefined,
      now: () => 0,
    }), 'device_code_expired');
    assert.equal(cappedPolls, 3);

    await expectReason(() => pollDeviceAuthorizationGrant({
      deviceCode: 'device-code', intervalSeconds: 1, expiresInSeconds: 5,
      poll: async () => ({ access_token: '', token_type: 'Bearer', expires_in: 0 }) as DevicePollResponse,
      sleep: async () => undefined,
      now: () => 0,
    }), 'device_poll_failed');
  });
});

describe('P3-01 packaged MV3 evidence fixture', () => {
  test('provides an executable popup and chrome.identity redirect entrypoint', async () => {
    const manifest = JSON.parse(await readFile(resolve(MV3_PATH, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const worker = await readFile(resolve(MV3_PATH, 'service-worker.js'), 'utf8');
    const popup = await readFile(resolve(MV3_PATH, 'popup.html'), 'utf8');
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['identity', 'storage']);
    assert.match(worker, /chrome\.identity\.getRedirectURL\('oauth2'\)/);
    assert.match(worker, /chrome\.identity\.launchWebAuthFlow/);
    assert.match(popup, /popup\.js/);
    assert.doesNotMatch(worker + popup, /client_secret/i);
    assert.doesNotMatch(worker, /respond\(\{ outcome: 'redirect', redirectUrl \}\)/);
  });
});
