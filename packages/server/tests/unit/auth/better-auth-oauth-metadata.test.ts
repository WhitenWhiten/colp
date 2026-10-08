import assert from 'node:assert/strict';
import { test } from 'vitest';
import { redactDisabledOAuthBackchannelMetadata } from '../../../src/infrastructure/auth/better-auth-runtime.js';

test('OAuth issuer metadata hides the disabled backchannel logout capability', async () => {
  const response = await redactDisabledOAuthBackchannelMetadata(
    new Response(JSON.stringify({
      issuer: 'https://issuer.example.test',
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
    }), { headers: { 'content-type': 'application/json', 'content-length': '123' } }),
    'https://issuer.example.test/.well-known/oauth-authorization-server/api/v1/auth',
    '/api/v1/auth',
  );
  assert.deepEqual(await response.json(), {
    issuer: 'https://issuer.example.test',
    backchannel_logout_supported: false,
    backchannel_logout_session_supported: false,
  });
  assert.equal(response.headers.has('content-length'), false);
});
