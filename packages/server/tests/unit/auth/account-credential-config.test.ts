import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { parseMcpScopes } from '../../../src/bootstrap/config-mcp.js';
import { productionEnv } from '../../support/http-security-config-env.js';

function testEs256Jwk(kid = 'acct-cred-test-kid'): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return JSON.stringify({ ...jwk, kid, kty: 'EC', crv: 'P-256' });
}

const FEATURE_ON = {
  KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
  AUTOMATION_CURSOR_HMAC_KEY: Buffer.alloc(32, 13).toString('base64url'),
  AUTOMATION_ES256_PRIVATE_JWK: testEs256Jwk(),
};

test('account credentials default off and do not require automation secrets', () => {
  const config = loadConfig(productionEnv());
  assert.equal(config.accountCredentials.enabled, false);
  assert.equal(config.accountCredentials.exposeAutomationIdentity, false);
  assert.equal(config.accountCredentials.cursorHmacKey, null);
  assert.equal(config.accountCredentials.es256PrivateJwk, null);
  assert.deepEqual(config.accountCredentials.es256PreviousPublicJwks, []);
  assert.equal(config.accountCredentials.tokenTtlSeconds, 300);
  assert.equal(config.accountCredentials.clockSkewSeconds, 30);
});

test('malformed account-credential flags fail startup', () => {
  assert.throws(
    () => loadConfig(productionEnv({ KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'yes' })),
    /KNOWN_FEATURE_ACCOUNT_CREDENTIALS must be true or false/u,
  );
  assert.throws(
    () => loadConfig(productionEnv({ EXPOSE_AUTOMATION_IDENTITY: '1' })),
    /EXPOSE_AUTOMATION_IDENTITY must be true or false/u,
  );
});

test('malformed previous public JWKS fails startup when the feature is on', () => {
  assert.throws(
    () => loadConfig(productionEnv({
      ...FEATURE_ON,
      AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS: '{',
    })),
    /AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS/u,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      ...FEATURE_ON,
      AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', kid: 'x' }] }),
    })),
    /AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS/u,
  );
});

test('feature-off does not require previous JWKS or consume a signer', () => {
  const config = loadConfig(productionEnv({ AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS: '{' }));
  assert.equal(config.accountCredentials.enabled, false);
  assert.equal(config.accountCredentials.es256PrivateJwk, null);
  assert.deepEqual(config.accountCredentials.es256PreviousPublicJwks, []);
});

test('MCP_OAUTH_SCOPES accepts 32 unique scopes including product read/write', () => {
  const scopes = [
    ...Array.from({ length: 30 }, (_, index) => `scope${index}:read`),
    'product:read',
    'product:write',
  ];
  assert.equal(parseMcpScopes(scopes.join(',')).length, 32);
  assert.throws(() => parseMcpScopes([...scopes, 'too:many'].join(',')), /at most 32 scopes/u);
});

test('enabling the feature requires the cursor HMAC key and a configured ES256 JWK', () => {
  assert.throws(
    () => loadConfig(productionEnv({ KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true' })),
    /AUTOMATION_CURSOR_HMAC_KEY is required/u,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: Buffer.alloc(32, 13).toString('base64url'),
    })),
    /AUTOMATION_ES256_PRIVATE_JWK is required/u,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: Buffer.alloc(16, 1).toString('base64url'),
      AUTOMATION_ES256_PRIVATE_JWK: testEs256Jwk(),
    })),
    /AUTOMATION_CURSOR_HMAC_KEY/u,
  );
  const previous = JSON.parse(testEs256Jwk('previous-kid')) as {
    kid: string; kty: string; crv: string; x: string; y: string; d: string;
  };
  const enabled = loadConfig(productionEnv({
    ...FEATURE_ON,
    AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({
      keys: [{ kid: previous.kid, kty: previous.kty, crv: previous.crv, x: previous.x, y: previous.y }],
    }),
  }));
  assert.equal(enabled.accountCredentials.enabled, true);
  assert.equal(enabled.accountCredentials.cursorHmacKey?.length, 32);
  assert.equal(enabled.accountCredentials.es256PrivateJwk?.kid, 'acct-cred-test-kid');
  assert.equal(enabled.accountCredentials.es256PreviousPublicJwks.length, 1);
  assert.equal(enabled.accountCredentials.es256PreviousPublicJwks[0]?.kid, 'previous-kid');
  assert.equal('d' in (enabled.accountCredentials.es256PreviousPublicJwks[0] as object), false);
  assert.equal(enabled.accountCredentials.issuanceRate.maxRequests, 20);
  assert.equal(enabled.accountCredentials.issuanceRate.windowMs, 3_600_000);
  assert.equal(enabled.accountCredentials.tokenTtlSeconds, 300);
  assert.equal(enabled.accountCredentials.clockSkewSeconds, 30);
  assert.equal(enabled.accountCredentials.tokenRate.credential.maxRequests, 30);
  assert.equal(enabled.accountCredentials.tokenRate.client.maxRequests, 120);
});
