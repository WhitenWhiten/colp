import { assertPublicObjectPrefixesDoNotOverlap } from '../../../src/bootstrap/config-product.js';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  loadConfig,
} from '../../support/test-config.js';

const AVATAR_PREFIX = 'avatar/';
const FAVICON_PREFIX = 'favicon/';
const LIVE_PREFIX = 'attachments/live/';
const PROBE_PREFIX = 'attachments/probe/';

/** Asserts the production five-way guard rejects a prefix tuple with a RangeError. */
function expectOverlapRejected(
  avatarPrefix: string,
  faviconPrefix: string,
  livePrefix: string,
  probePrefix: string,
): void {
  assert.throws(
    () => assertPublicObjectPrefixesDoNotOverlap(
      avatarPrefix, faviconPrefix, livePrefix, probePrefix,
    ),
    (error: unknown) =>
      error instanceof RangeError && /must not overlap/u.test(error.message),
    `expected overlap rejection for avatar=${JSON.stringify(avatarPrefix)} favicon=${JSON.stringify(faviconPrefix)} live=${JSON.stringify(livePrefix)} probe=${JSON.stringify(probePrefix)}`,
  );
}

function testLoadConfigEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://localhost/favicon_prefix_overlap_test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

describe('assertPublicObjectPrefixesDoNotOverlap', () => {
  test('accepts non-overlapping avatar, favicon, and attachments prefixes', () => {
    const cases = [
      [AVATAR_PREFIX, FAVICON_PREFIX, LIVE_PREFIX, PROBE_PREFIX],
      ['avatars/', 'icons/', 'attachments/live/', 'attachments/probe/'],
      [AVATAR_PREFIX, FAVICON_PREFIX, 'attachments/live', 'attachments/probe'],
      [AVATAR_PREFIX, FAVICON_PREFIX, 'attachments/live/2026/', 'attachments/probe/2026/'],
    ] as const;
    for (const [avatarPrefix, faviconPrefix, livePrefix, probePrefix] of cases) {
      assert.doesNotThrow(
        () => assertPublicObjectPrefixesDoNotOverlap(
          avatarPrefix, faviconPrefix, livePrefix, probePrefix,
        ),
        `expected no overlap for avatar=${JSON.stringify(avatarPrefix)} favicon=${JSON.stringify(faviconPrefix)} live=${JSON.stringify(livePrefix)} probe=${JSON.stringify(probePrefix)}`,
      );
    }
  });

  test('rejects favicon exact equality with avatar, live, or probe', () => {
    expectOverlapRejected(AVATAR_PREFIX, AVATAR_PREFIX, LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, LIVE_PREFIX, LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, PROBE_PREFIX, LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(FAVICON_PREFIX, FAVICON_PREFIX, LIVE_PREFIX, PROBE_PREFIX);
  });

  test('rejects avatar vs favicon string-prefix relations in either direction', () => {
    expectOverlapRejected('favicon', 'favicon/', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected('f', 'favicon/', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, 'a', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, 'avatar', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected('avatar', 'avatar/', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected('favicon/', 'favicon', LIVE_PREFIX, PROBE_PREFIX);
  });

  test('rejects favicon string-prefix relations against live and probe', () => {
    expectOverlapRejected(AVATAR_PREFIX, 'attachments', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, 'favicon', 'favicon/', PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, FAVICON_PREFIX, 'f', PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, 'attachments/probe', LIVE_PREFIX, 'attachments/probe/');
  });

  test('rejects empty prefixes defensively (empty string is a prefix of every key)', () => {
    expectOverlapRejected('', FAVICON_PREFIX, LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, '', LIVE_PREFIX, PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, FAVICON_PREFIX, '', PROBE_PREFIX);
    expectOverlapRejected(AVATAR_PREFIX, FAVICON_PREFIX, LIVE_PREFIX, '');
  });


  test('loadConfig rejects avatar vs favicon overlap when attachments config is absent', () => {
    assert.throws(
      () => loadConfig(testLoadConfigEnv({
        AVATAR_R2_PREFIX: 'avatar/',
        FAVICON_R2_PREFIX: 'avatar/',
      })),
      (error: unknown) => error instanceof RangeError && /must not overlap/u.test(error.message),
    );
    assert.throws(
      () => loadConfig(testLoadConfigEnv({
        AVATAR_R2_PREFIX: 'favicon',
        FAVICON_R2_PREFIX: 'favicon/',
      })),
      (error: unknown) => error instanceof RangeError && /must not overlap/u.test(error.message),
    );
    assert.doesNotThrow(() => loadConfig(testLoadConfigEnv({
      AVATAR_R2_PREFIX: 'avatar/',
      FAVICON_R2_PREFIX: 'favicon/',
    })));
  });


});
