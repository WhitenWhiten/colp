import assert from 'node:assert/strict';
import type { BetterAuthOptions, DBAdapterInstance } from 'better-auth';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const BASE_URL = 'https://app.example.test';
const TOKEN_V1 = 'AaBbCcDdEeFf0123456789AaBbCcDdEe'; // secret-scan: allow 'AaBbCcDdEeFf0123456789AaBbCcDdEe'
const TOKEN_V2 = 'ZzYyXxWwVvUu9876543210ZzYyXxWw';
const LEGACY_TOKEN = 'LegacyToken0123456789LegacyToken01';
const KEY_V1 = Buffer.alloc(32, 31);
const KEY_V2 = Buffer.alloc(32, 32);

function runtimeConfig(input: {
  readonly keys: readonly { readonly version: number; readonly key: Buffer }[];
  readonly legacyPlaintextReadUntil?: Date | null;
}): BetterAuthRuntimeConfig {
  return {
    baseURL: BASE_URL,
    basePath: '/api/v1/auth',
    secret: 'postgres-token-protection-test-secret-0123456789', // secret-scan: allow 'postgres-token-protection-test-secret-0123456789'
    sessionTokenProtection: {
      keys: input.keys,
      legacyPlaintextReadUntil: input.legacyPlaintextReadUntil ?? null,
    },
    trustedOrigins: [BASE_URL],
    cookieName: '__Host-known_session',
    sessionExpiresInSeconds: 86_400,
    sessionUpdateAgeSeconds: 60,
    bodyLimitBytes: 1024,
    emailOtp: null,
    social: null,
    passwordHash: {
      hash: async (password: string) => `test:${password}`,
      verify: async () => false,
    },
  };
}

function adapterFor(
  isolated: IsolatedPostgresRuntime,
  config: BetterAuthRuntimeConfig,
) {
  const options = buildBetterAuthOptions({
    enabled: true,
    config,
    database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
  });
  const factory = options.database as DBAdapterInstance;
  return factory(options as BetterAuthOptions);
}

describeWithPostgres('Better Auth protected session-token adapter PostgreSQL contract', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('auth_session_token_protection', {
      maxConnections: 6,
      applicationName: 'known-auth-session-token-protection-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date();
    await isolated.runtime.db.insertInto('auth_users').values({
      id: 'protected-user',
      name: 'Protected User',
      email: 'protected-user@example.test',
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    }).execute();
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('create/find/update/delete expose plaintext to Better Auth but never store it', async () => {
    const adapter = adapterFor(isolated, runtimeConfig({ keys: [{ version: 1, key: KEY_V1 }] }));
    const now = new Date();
    const created = await adapter.create<{
      id: string;
      token: string;
      expiresAt: Date;
      createdAt: Date;
      updatedAt: Date;
      ipAddress: string;
      userAgent: string;
      userId: string;
    }>({
      model: 'session',
      forceAllowId: true,
      data: {
        id: 'protected-session-v1',
        token: TOKEN_V1,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
        ipAddress: '',
        userAgent: '',
        userId: 'protected-user',
      },
    });
    assert.equal(created.token, TOKEN_V1);

    const stored = await isolated.runtime.pool.query<{
      token: string;
      tokenLookupHash: string | null;
    }>(`select token, "tokenLookupHash" from auth_sessions where id = 'protected-session-v1'`);
    assert.match(stored.rows[0]!.token, /^knst1\.1\./u);
    assert.notEqual(stored.rows[0]!.token, TOKEN_V1);
    assert.match(stored.rows[0]!.tokenLookupHash!, /^knsh1\.1\.[A-Za-z0-9_-]{43}$/u);

    const found = await adapter.findOne<{
      token: string;
      user: { id: string };
    }>({
      model: 'session',
      where: [{ field: 'token', value: TOKEN_V1 }],
      join: { user: true },
    });
    assert.equal(found?.token, TOKEN_V1);
    assert.equal(found?.user.id, 'protected-user');

    const updated = await adapter.update<{ token: string; userAgent: string }>({
      model: 'session',
      where: [{ field: 'token', value: TOKEN_V1 }],
      update: { userAgent: 'updated-agent' },
    });
    assert.equal(updated?.token, TOKEN_V1);
    assert.equal(updated?.userAgent, 'updated-agent');

    await adapter.transaction(async (transaction) => {
      const inside = await transaction.findOne<{ token: string }>({
        model: 'session',
        where: [{ field: 'token', value: TOKEN_V1 }],
      });
      assert.equal(inside?.token, TOKEN_V1);
      await transaction.delete({
        model: 'session',
        where: [{ field: 'token', value: TOKEN_V1 }],
      });
    });
    assert.equal(await adapter.findOne({
      model: 'session',
      where: [{ field: 'token', value: TOKEN_V1 }],
    }), null);
  });

  test('rotation queries retained lookup keys and writes only the active version', async () => {
    const oldAdapter = adapterFor(isolated, runtimeConfig({ keys: [{ version: 1, key: KEY_V1 }] }));
    const now = new Date();
    await oldAdapter.create({
      model: 'session',
      forceAllowId: true,
      data: {
        id: 'rotated-session-v1', token: TOKEN_V1,
        expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now,
        ipAddress: '', userAgent: '', userId: 'protected-user',
      },
    });

    const rotated = adapterFor(isolated, runtimeConfig({
      keys: [{ version: 2, key: KEY_V2 }, { version: 1, key: KEY_V1 }],
    }));
    assert.equal((await rotated.findOne<{ token: string }>({
      model: 'session', where: [{ field: 'token', value: TOKEN_V1 }],
    }))?.token, TOKEN_V1);
    await rotated.create({
      model: 'session',
      forceAllowId: true,
      data: {
        id: 'rotated-session-v2', token: TOKEN_V2,
        expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now,
        ipAddress: '', userAgent: '', userId: 'protected-user',
      },
    });
    const versions = await isolated.runtime.pool.query<{ id: string; token: string }>(
      `select id, token from auth_sessions where id like 'rotated-session-%' order by id`,
    );
    assert.match(versions.rows[0]!.token, /^knst1\.1\./u);
    assert.match(versions.rows[1]!.token, /^knst1\.2\./u);
  });

  test('legacy plaintext dual-read is explicit and expires closed', async () => {
    const now = new Date();
    await isolated.runtime.db.insertInto('auth_sessions').values({
      id: 'legacy-plaintext-session',
      token: LEGACY_TOKEN,
      tokenLookupHash: null,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: '',
      userAgent: '',
      userId: 'protected-user',
    }).execute();
    const bridge = adapterFor(isolated, runtimeConfig({
      keys: [{ version: 1, key: KEY_V1 }],
      legacyPlaintextReadUntil: new Date('2100-01-01T00:00:00.000Z'),
    }));
    assert.equal((await bridge.findOne<{ token: string }>({
      model: 'session', where: [{ field: 'token', value: LEGACY_TOKEN }],
    }))?.token, LEGACY_TOKEN);

    const closed = adapterFor(isolated, runtimeConfig({
      keys: [{ version: 1, key: KEY_V1 }],
      legacyPlaintextReadUntil: null,
    }));
    assert.equal(await closed.findOne({
      model: 'session', where: [{ field: 'token', value: LEGACY_TOKEN }],
    }), null);
    await assert.rejects(
      closed.findOne({ model: 'session', where: [{ field: 'id', value: 'legacy-plaintext-session' }] }),
      /plaintext session token is not accepted/u,
    );
  });
});
