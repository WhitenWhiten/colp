import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../bootstrap/config.js';
import { mintTestAuthorizationCodeFromChallenge } from './auth/oidc-provider.js';

const TEST_IDENTITY_SUBJECT = 'phase1-real-stack-user';

export function registerTestOidcAuthorizeRoute(
  app: FastifyInstance,
  config: AppConfig,
  betterAuthEnabled: boolean,
): void {
  // F2: Better Auth mode registers zero legacy OIDC surface — the in-process
  // test OIDC authorize route is part of the legacy chain and stays absent.
  if (betterAuthEnabled) return;
  if (!config.testIdentityProviderEnabled) return;
  if (config.nodeEnv !== 'test' || !config.oidc.allowTestProvider) {
    throw new Error('test OIDC authorize route refused outside explicit test-provider mode');
  }

  app.get('/__test__/oidc/authorize', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const redirectUri = query.redirect_uri;
    const state = query.state;
    const nonce = query.nonce;
    const challenge = query.code_challenge;
    if (
      query.response_type !== 'code'
      || query.client_id !== config.oidc.clientId
      || redirectUri !== config.oidc.redirectUri
      || query.code_challenge_method !== 'S256'
      || !state
      || !nonce
      || !challenge
      || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    ) {
      return reply.code(400).header('Cache-Control', 'no-store').send({
        error: 'invalid_test_authorization_request',
      });
    }

    const callback = new URL(redirectUri);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', mintTestAuthorizationCodeFromChallenge({
      subject: TEST_IDENTITY_SUBJECT,
      nonce,
      codeChallenge: challenge,
      email: 'phase1-real-stack@example.test',
      emailVerified: true,
      name: 'Phase 1 Real Stack',
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      hmacSecret: config.oidc.testProviderHmacSecret,
    }));
    return reply
      .code(302)
      .header('Cache-Control', 'no-store')
      .header('Location', callback.toString())
      .send();
  });
}

