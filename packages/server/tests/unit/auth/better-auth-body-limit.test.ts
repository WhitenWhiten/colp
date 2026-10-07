import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { mountBetterAuthAllowlist } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildApiApp } from '../../../src/transport/app.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BODY_LIMIT = 1_024;

function env(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_BODY_LIMIT_BYTES: String(BODY_LIMIT),
  };
}

interface HttpResult {
  readonly statusCode: number;
  readonly body: string;
}

async function postChunked(url: URL, chunks: readonly Buffer[]): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: TRUSTED_ORIGIN,
      },
    }, (response) => {
      const body: Buffer[] = [];
      response.on('data', (chunk: Buffer) => body.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(body).toString('utf8'),
      }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

describe('Better Auth bridge body limit', () => {
  const apps: Array<ReturnType<typeof buildApiApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  test('chunked bodies are accepted at the byte limit and rejected one byte over before Better Auth', async () => {
    const config = loadConfig(env());
    const betterAuthConfig = buildBetterAuthConfig(config.betterAuth);
    assert.ok(betterAuthConfig);

    let handlerCalls = 0;
    let acceptedBody: Buffer | null = null;
    let acceptedTransferEncoding: string | null = null;
    const auth = {
      handler: async (request: Request) => {
        handlerCalls += 1;
        acceptedBody = Buffer.from(await request.arrayBuffer());
        acceptedTransferEncoding = request.headers.get('transfer-encoding');
        return Response.json({ accepted: true });
      },
    } as unknown as ReturnType<typeof betterAuth>;
    const app = buildApiApp({
      config,
      betterAuthRuntime: {
        mount: (fastifyApp) => mountBetterAuthAllowlist(fastifyApp, auth, betterAuthConfig),
      },
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = new URL(`http://127.0.0.1:${address.port}/api/v1/auth/sign-up/email`);

    const atLimitChunks = [Buffer.alloc(512, 0x61), Buffer.alloc(512, 0x62)];
    const accepted = await postChunked(endpoint, atLimitChunks);
    assert.equal(accepted.statusCode, 200);
    assert.equal(handlerCalls, 1);
    assert.equal(acceptedTransferEncoding, 'chunked', 'the control request must really use chunked framing');
    assert.deepEqual(acceptedBody, Buffer.concat(atLimitChunks), 'the bridge must preserve exact body bytes');

    const overLimit = await postChunked(endpoint, [Buffer.alloc(BODY_LIMIT), Buffer.alloc(1)]);
    assert.equal(overLimit.statusCode, 413);
    assert.equal((JSON.parse(overLimit.body) as { error?: { code?: string } }).error?.code, 'payload_too_large');
    assert.equal(handlerCalls, 1, 'an oversized chunked body must never reach Better Auth');
  });
});
