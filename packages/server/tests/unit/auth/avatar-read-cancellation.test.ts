import assert from 'node:assert/strict';
import { get } from 'node:http';
import Fastify from 'fastify';
import { test } from 'vitest';
import { registerAvatarRoutes } from '../../../src/transport/auth/browser-auth-handlers.js';
import { createR2AvatarStore } from '../../../src/infrastructure/identity/avatar-r2-adapter.js';
import { loadConfig } from '../../support/test-config.js';
import { startFaultServer } from '../../support/phase4a-i06-fault-server.js';

test('public avatar client disconnect cancels the real upstream body socket', async () => {
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const fault = await startFaultServer(() => {
    started();
    return { status: 200, headers: { 'content-type': 'image/png', 'content-length': '16' },
      chunks: [{ data: Buffer.from('89504e470d0a1a0a', 'hex') }], holdOpen: true };
  });
  const store = createR2AvatarStore({ endpoint: fault.url, region: 'auto', bucket: 'avatars', prefix: 'avatar/',
    rwCredential: { accessKeyId: 'writer', secretAccessKey: 'writer-secret' },
    roCredential: { accessKeyId: 'reader', secretAccessKey: 'reader-secret' } });
  const app = Fastify();
  try {
  registerAvatarRoutes(app, { config: loadConfig({ DATABASE_URL: 'postgres://localhost/test',
    PRODUCT_ORIGIN: 'https://app.example.test', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-secret-not-production' }), avatarStore: store,
    identityUnitOfWork: { execute: async () => { throw new Error('public GET must not open an identity transaction'); } } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = get(`${address}/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000`);
    client.on('error', () => {});
    await reading; client.destroy();
    assert.ok(await fault.waitForPrematureClose(1000) >= 1, 'disconnect must destroy upstream before the 5 second deadline');
  } finally { await app.close(); await store.close?.(); await fault.close(); }
});
