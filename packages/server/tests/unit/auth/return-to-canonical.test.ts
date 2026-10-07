import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { betterAuth } from 'better-auth';
import Fastify from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { mountBetterAuthAllowlist } from '../../../src/infrastructure/auth/better-auth-fastify-bridge.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { resolveAllowlistedCallbackUrl } from '../../../src/modules/auth/index.js';
import {
  assertSafeRelativeReturnTo,
  canonicalizeSafeReturnTo,
  isSafeRelativeReturnTo,
} from '../../../src/modules/identity/index.js';
import { resolveBrowserReturnTo } from '../../../src/transport/auth/origin-csrf.js';

const ORIGIN = 'https://app.example.test';
const FALLBACK = '/safe-fallback';

describe('returnTo canonicalization agrees across helpers', () => {
  const legal = [
    '/c/reading?view=list#top',
    '/settings?tab=security#security',
    `${ORIGIN}/settings?tab=security#security`,
    `${ORIGIN}/c/reading?view=list#top`,
  ] as const;
  const rejected = [
    '/.//evil.example',
    '/.//evil.example?x=1#h',
    '//evil.example',
    '//evil.example/steal',
    `${ORIGIN}//evil.example`,
    `${ORIGIN}/.//evil.example`,
    '/%2e//evil.example',
    '/%2e%2e//evil.example',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/\\evil.example',
    `${ORIGIN}/\\evil.example`,
    'https://user:pw@app.example.test/settings',
    '/steal\u0000x',
    '/%00evil',
    'https://evil.example/phish',
  ] as const;

  test('legal query and hash combinations, including same-origin absolute URLs, match', () => {
    for (const raw of legal) {
      const canonical = canonicalizeSafeReturnTo(raw, ORIGIN);
      assert.equal(canonical, raw.startsWith('/') ? raw : raw.slice(ORIGIN.length), raw);
      assert.equal(resolveAllowlistedCallbackUrl(raw, ORIGIN), canonical, raw);
      assert.equal(resolveBrowserReturnTo(raw, ORIGIN, FALLBACK), canonical, raw);
      if (raw.startsWith('/')) {
        assert.equal(isSafeRelativeReturnTo(raw), true, raw);
        assert.equal(assertSafeRelativeReturnTo(raw), canonical, raw);
      } else {
        assert.equal(isSafeRelativeReturnTo(raw), false, raw);
      }
    }
  });

  test('/.//, a double slash, and escapes are rejected by every helper', () => {
    for (const raw of rejected) {
      assert.equal(canonicalizeSafeReturnTo(raw, ORIGIN), null, raw);
      assert.equal(resolveAllowlistedCallbackUrl(raw, ORIGIN), null, raw);
      assert.equal(resolveBrowserReturnTo(raw, ORIGIN, FALLBACK), FALLBACK, raw);
      assert.equal(isSafeRelativeReturnTo(raw), false, raw);
      assert.throws(() => assertSafeRelativeReturnTo(raw), raw);
    }
  });
});

describe('Better Auth bridge callback canonicalization (stub handler, not Better Auth)', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  function bridgeConfig() {
    const config = buildBetterAuthConfig(loadConfig({
      DATABASE_URL: 'postgres://unused.invalid/never',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: 'fixture-better-auth-secret-0123456789abcdef',
    }).betterAuth);
    assert.ok(config);
    return config;
  }

  test('BA-on start rejects a dangerous canonical result and forwards a safe body unchanged', async () => {
    const config = bridgeConfig();
    const seen: string[] = [];
    const lengths: Array<string | null> = [];
    const auth = {
      handler: async (request: Request) => {
        lengths.push(request.headers.get('content-length'));
        seen.push(await request.text());
        return Response.json({ ok: true });
      },
    } as unknown as ReturnType<typeof betterAuth>;
    const app = Fastify({ logger: false });
    apps.push(app);
    mountBetterAuthAllowlist(app, auth, { ...config, oauthIssuer: null });

    const dangerous = [
      { callbackURL: '/.//evil.example', errorCallbackURL: '/error' },
      { callbackURL: '/dashboard', errorCallbackURL: '//evil.example/steal' },
      { callbackURL: '/%2e//evil.example' },
      { callbackURL: `${ORIGIN}//evil.example` },
      { callbackURL: '/\\evil.example' },
      { newUserCallbackURL: '/.//evil.example', callbackURL: '/dashboard' },
    ];
    for (const body of dangerous) {
      const payload = JSON.stringify(body);
      const response = await app.inject({
        method: 'POST',
        url: `${config.basePath}/sign-in/social`,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
        payload,
      });
      assert.equal(response.statusCode, 400, payload);
      assert.equal(response.json().code, 'INVALID_CALLBACK_URL');
      assert.equal(response.body.includes('evil.example'), false, payload);
    }
    assert.equal(seen.length, 0, 'a dangerous callback must not be handed to the bridge handler');

    const safeBodies = [
      { callbackURL: '/c/reading?view=list#top', errorCallbackURL: '/settings?tab=security#security' },
      { callbackURL: `${ORIGIN}/settings?tab=security#security` },
    ];
    for (const body of safeBodies) {
      const payload = JSON.stringify(body);
      const response = await app.inject({
        method: 'POST',
        url: `${config.basePath}/sign-in/oauth2`,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
        payload,
      });
      assert.equal(response.statusCode, 200, payload);
      assert.equal(seen.at(-1), payload);
      assert.equal(lengths.at(-1), String(Buffer.byteLength(payload)));
    }
  });

  test('BA-on callback replaces an unsafe persisted Location and keeps a safe one', async () => {
    const config = bridgeConfig();
    const locations = [
      '/.//evil.example',
      '//evil.example',
      `${ORIGIN}/.//evil.example`,
      `${ORIGIN}//evil.example`,
      '/%2e//evil.example',
      '/c/reading?view=list#top',
      `${ORIGIN}/settings?tab=security#security`,
    ];
    let nextLocation = locations[0]!;
    const auth = {
      handler: async () => new Response(null, { status: 302, headers: { location: nextLocation } }),
    } as unknown as ReturnType<typeof betterAuth>;
    const app = Fastify({ logger: false });
    apps.push(app);
    mountBetterAuthAllowlist(app, auth, { ...config, oauthIssuer: null });

    for (const path of ['/callback/google', '/oauth2/callback/google'] as const) {
      for (const location of locations) {
        nextLocation = location;
        const response = await app.inject({
          method: 'GET',
          url: `${config.basePath}${path}`,
        });
        const expected = canonicalizeSafeReturnTo(location, ORIGIN) ?? '/';
        assert.equal(response.statusCode, 302, `${path} ${location}`);
        assert.equal(response.headers.location, expected, `${path} ${location}`);
        assert.equal(String(response.headers.location).includes('evil.example'), false);
      }
    }
  });
});
