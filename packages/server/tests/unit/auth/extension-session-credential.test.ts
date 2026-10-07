import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ExtensionAuthError,
  createCompositeExtensionCredentialVerifier,
  createSessionBackedExtensionCredentialVerifier,
  isJoseCompactToken,
  isVerifiedExtensionCredential,
  parseExtensionAuthConfig,
  type ExtensionAuthConfig,
  type ExtensionCredentialEvidencePort,
  type ExtensionSessionActor,
} from '../../../src/modules/identity/extension-auth.js';

const NOW = new Date('2026-08-18T00:00:00.000Z');
const SESSION_COOKIE = 'baSessionToken.dGVzdHNpZw==';
const JOSE_TOKEN = 'header.payload.signature';

function config(): ExtensionAuthConfig {
  return parseExtensionAuthConfig({
    issuer: 'https://issuer.example.test/',
    clientId: 'known-chromium-extension',
    audience: 'known-sync-api',
    authorizationEndpoint: 'https://issuer.example.test/oauth2/authorize',
    tokenEndpoint: 'https://issuer.example.test/oauth2/token',
    jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
    redirectUri: 'https://pplpnpegpnghcddhmpgkbfkdfadjiaen.chromiumapp.org/oauth2',
    extensionIds: ['pplpnpegpnghcddhmpgkbfkdfadjiaen'],
    redirectOrigins: ['https://pplpnpegpnghcddhmpgkbfkdfadjiaen.chromiumapp.org'],
    scopes: ['openid', 'known.sync'],
    algorithms: ['RS256'],
    clockSkewSeconds: 30,
    evidenceTtlSeconds: 60,
  });
}

const liveActor: ExtensionSessionActor = {
  accountId: 'account-1',
  subjectId: 'subject-1',
  sessionId: 'session-1',
  issuedAt: new Date('2026-08-17T23:00:00.000Z'),
  expiresAt: new Date('2026-08-19T00:00:00.000Z'),
};

describe('isJoseCompactToken', () => {
  test('three non-empty segments are JOSE; cookie values are not', () => {
    assert.equal(isJoseCompactToken(JOSE_TOKEN), true);
    assert.equal(isJoseCompactToken(SESSION_COOKIE), false);
    assert.equal(isJoseCompactToken('a.b.'), false);
    assert.equal(isJoseCompactToken('only-one-segment'), false);
  });
});

describe('session-backed extension credential verifier', () => {
  test('accepts a Better Auth cookie value and mints known.sync evidence', async () => {
    const seenCookies: string[] = [];
    const verifier = createSessionBackedExtensionCredentialVerifier({
      config: config(),
      identityIssuer: 'https://app.example.test',
      now: () => NOW,
      sessions: {
        async authenticate(cookieHeader) {
          seenCookies.push(cookieHeader);
          return liveActor;
        },
      },
      identities: {
        async ensure(input) {
          return { issuer: input.issuer, subject: input.subjectId };
        },
      },
    });
    const verified = await verifier.verify({ authorization: `Bearer ${SESSION_COOKIE}` });
    assert.equal(isVerifiedExtensionCredential(verified), true);
    assert.equal(verified.issuer, 'https://app.example.test');
    assert.equal(verified.subject, 'subject-1');
    assert.equal(verified.clientId, 'known-chromium-extension');
    assert.equal(verified.audience, 'known-sync-api');
    assert.deepEqual(verified.scopes, ['known.sync']);
    assert.equal(verified.credentialId, 'session-1');
    assert.equal(seenCookies[0], `__Host-known_session=${encodeURIComponent(SESSION_COOKIE)}`);

    const encoded = await verifier.verify({
      authorization: `Bearer ${encodeURIComponent(SESSION_COOKIE)}`,
    });
    assert.equal(encoded.credentialId, 'session-1');
    assert.equal(seenCookies[1], `__Host-known_session=${encodeURIComponent(SESSION_COOKIE)}`);
  });

  test('reuses an existing identity issuer/subject for migrated accounts', async () => {
    const verifier = createSessionBackedExtensionCredentialVerifier({
      config: config(),
      identityIssuer: 'https://app.example.test',
      now: () => NOW,
      sessions: { authenticate: async () => liveActor },
      identities: {
        async ensure() {
          return { issuer: 'https://issuer.example.test/', subject: 'oidc-sub' };
        },
      },
    });
    const verified = await verifier.verify({ authorization: `Bearer ${SESSION_COOKIE}` });
    assert.equal(verified.issuer, 'https://issuer.example.test/');
    assert.equal(verified.subject, 'oidc-sub');
  });

  test('rejects compact JOSE tokens, missing sessions, and expired actors', async () => {
    const verifier = createSessionBackedExtensionCredentialVerifier({
      config: config(),
      identityIssuer: 'https://app.example.test',
      now: () => NOW,
      sessions: { authenticate: async () => null },
      identities: { ensure: async (input) => ({ issuer: input.issuer, subject: input.subjectId }) },
    });
    await assert.rejects(
      () => verifier.verify({ authorization: `Bearer ${JOSE_TOKEN}` }),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
    );
    await assert.rejects(
      () => verifier.verify({ authorization: `Bearer ${SESSION_COOKIE}` }),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
    );

    const expired = createSessionBackedExtensionCredentialVerifier({
      config: config(),
      identityIssuer: 'https://app.example.test',
      now: () => NOW,
      sessions: {
        authenticate: async () => ({ ...liveActor, expiresAt: new Date('2026-08-17T00:00:00.000Z') }),
      },
      identities: { ensure: async (input) => ({ issuer: input.issuer, subject: input.subjectId }) },
    });
    await assert.rejects(
      () => expired.verify({ authorization: `Bearer ${SESSION_COOKIE}` }),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'expired',
    );
  });
});

describe('composite extension credential verifier', () => {
  test('routes JOSE to the JOSE port and cookies to the session port', async () => {
    const seen: string[] = [];
    const jose: ExtensionCredentialEvidencePort = {
      async verify() {
        seen.push('jose');
        throw new ExtensionAuthError('invalid_token');
      },
    };
    const session: ExtensionCredentialEvidencePort = {
      async verify() {
        seen.push('session');
        throw new ExtensionAuthError('invalid_token');
      },
    };
    const composite = createCompositeExtensionCredentialVerifier(jose, session);
    await assert.rejects(() => composite.verify({ authorization: `Bearer ${JOSE_TOKEN}` }));
    await assert.rejects(() => composite.verify({ authorization: `Bearer ${SESSION_COOKIE}` }));
    assert.deepEqual(seen, ['jose', 'session']);
  });
});
