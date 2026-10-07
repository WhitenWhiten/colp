import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, test } from 'vitest';
import {
  registerTestAuthMailboxRoute,
  toAuthMailboxQueryEntry,
} from '../../../src/bootstrap/api-auth-mailbox.js';
import { loadConfig } from '../../support/test-config.js';
import type { InProcessMailboxSink } from '../../../src/infrastructure/email/index.js';
import { testEnv } from '../../support/http-security-config-env.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function mailboxSink(): InProcessMailboxSink {
  return {
    provider: { async send() { throw new Error('mailbox query must not send'); } },
    sentCount: 2,
    entries: [
      {
        idempotencyKey: 'mail-key-1',
        to: 'owner@example.test',
        subject: 'Your Know-N sign-in code',
        textBody: 'Your code is 123456',
        receivedAt: '2026-09-01T10:00:00.000Z',
      },
      {
        idempotencyKey: 'mail-key-2',
        to: 'owner@example.test',
        subject: 'Reset your Know-N password',
        textBody: 'Open https://app.example.test/reset?token=abc',
        receivedAt: '2026-09-01T10:01:00.000Z',
      },
    ],
  } as InProcessMailboxSink;
}

function appWithMailbox(config: ReturnType<typeof loadConfig>, sink?: InProcessMailboxSink): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerTestAuthMailboxRoute(app, config, sink);
  return app;
}

describe('test-only auth mailbox projection and route gates', () => {
  test('projects OTP expiry, link URLs, stable purposes, and unknown subjects', () => {
    assert.deepEqual(toAuthMailboxQueryEntry(mailboxSink().entries[0]!, 0, 600), {
      id: 'mail-1',
      to: 'owner@example.test',
      purpose: 'sign-in-otp',
      otp: '123456',
      url: null,
      receivedAt: '2026-09-01T10:00:00.000Z',
      expiresAt: '2026-09-01T10:10:00.000Z',
      idempotencyKey: 'mail-key-1',
    });
    const link = toAuthMailboxQueryEntry(mailboxSink().entries[1]!, 1, 600);
    assert.equal(link.id, 'mail-2');
    assert.equal(link.purpose, 'password-reset');
    assert.equal(link.otp, null);
    assert.equal(link.url, 'https://app.example.test/reset?token=abc');
    assert.equal(link.expiresAt, null);
    assert.equal(toAuthMailboxQueryEntry({
      idempotencyKey: 'mail-key-3',
      to: 'owner@example.test',
      subject: 'Unknown test subject',
      textBody: '',
      receivedAt: '2026-09-01T10:02:00.000Z',
    }, 2, 600).purpose, 'other');
  });

  test('NODE_ENV and explicit flag keep the route absent by default', async () => {
    assert.throws(
      () => loadConfig(testEnv({
        NODE_ENV: 'development',
        OIDC_ALLOW_TEST_PROVIDER: 'false',
        KNOWN_AUTH_MAILBOX_HTTP: 'true',
        KNOWN_AUTH_MAILBOX_HTTP_TOKEN: 'mailbox-test-token',
      })),
      /KNOWN_AUTH_MAILBOX_HTTP requires NODE_ENV=test/u,
    );
    const app = appWithMailbox(loadConfig(testEnv()), mailboxSink());
    const response = await app.inject({ method: 'GET', url: '/__test__/auth-mailbox' });
    assert.equal(response.statusCode, 404);
  });

  test('bearer token is the final gate and every response is non-cacheable', async () => {
    const token = 'mailbox-test-token';
    const app = appWithMailbox(loadConfig(testEnv({
      KNOWN_AUTH_MAILBOX_HTTP: 'true',
      KNOWN_AUTH_MAILBOX_HTTP_TOKEN: token,
    })), mailboxSink());
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const response = await app.inject({
        method: 'GET',
        url: '/__test__/auth-mailbox',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), { error: 'not_found' });
    }
    const accepted = await app.inject({
      method: 'GET',
      url: '/__test__/auth-mailbox',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.headers['cache-control'], 'no-store');
    const payload = accepted.json<{ entries: Array<Record<string, unknown>> }>();
    assert.equal(payload.entries.length, 2);
    assert.equal(payload.entries[0]?.otp, '123456');
    assert.equal(payload.entries[1]?.url, 'https://app.example.test/reset?token=abc');
  });
});
