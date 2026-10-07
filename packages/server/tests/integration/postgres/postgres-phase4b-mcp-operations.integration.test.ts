import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { sql } from 'kysely';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import {
  MCP_OAUTH_DEFAULT_SECURITY_EPOCH,
  createMcpOauthVerifier,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpReadOperations,
  McpOauthVerificationError,
  type McpOauthRevocationStore,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpReadOperations,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import type { JwksProvider } from '../../../src/modules/identity/index.js';
import {
  createPostgresMcpChangeSignalSource,
  type PostgresMcpChangeSignalSource,
} from '../../../src/infrastructure/outbox/index.js';
import { createDatabaseRuntime, createPostgresMcpOauthRevocationStore, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { createMcpTestFetch } from '../../support/phase4b-mcp-transport-scaffold.js';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { waitForRealTime } from '../../support/async-test-helpers.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const mcpFetch = createMcpTestFetch();

function mcpEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    LOG_LEVEL: 'silent',
    OIDC_ISSUER: 'https://issuer.example.test/realms/known',
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  } as Record<string, string>;
}

function emptyResourceProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptySnapshotResourceProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptyNodeResourceProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function modernBody(method: string, id: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'known-r13-postgres-test', version: '1.0.0' },
      },
      ...params,
    },
  });
}

function createSseReader(response: Response): {
  readonly next: (timeoutMs?: number) => Promise<{ readonly method?: string } | null>;
  readonly close: () => void;
} {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  return {
    async next(timeoutMs = 2_000): Promise<{ readonly method?: string } | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = block
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length);
          if (data !== undefined) return JSON.parse(data) as { readonly method?: string };
          continue;
        }
        if (done) return null;
        const result = await reader.read();
        if (result.done) {
          done = true;
        } else {
          buffer += decoder.decode(result.value, { stream: true });
        }
      }
      throw new Error('timed out waiting for SSE event');
    },
    close() {
      void reader.cancel().catch(() => undefined);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describeWithPostgres('Phase 4B R13 MCP operations drain and restart over PostgreSQL signal source', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `mcp_operations_${randomUUID().replaceAll('-', '_')}`;
  let admin: Pool;
  let runtime: DatabaseRuntime;
  let apiSource: PostgresMcpChangeSignalSource;
  let app: FastifyInstance;
  let origin: string;
  let operations: Phase4bMcpReadOperations;
  let metrics: InMemoryMetrics;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema ${schema}`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const migrationRuntime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 1,
      applicationName: 'known-mcp-operations-migration-test',
    });
    await runMigrations(migrationRuntime.db, 'latest');
    await migrationRuntime.close();
    runtime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 4,
      applicationName: 'known-mcp-operations-integration-test',
    });
    const config = loadConfig(mcpEnv());
    apiSource = createPostgresMcpChangeSignalSource({
      pool: runtime.pool,
      channel: `mcp_sig_${schema.replaceAll('-', '_')}`,
    });
    await apiSource.start();
    metrics = new InMemoryMetrics();
    operations = createPhase4bMcpReadOperations({
      metrics,
      maxConcurrentRequests: config.mcp!.budgets.request.maxConcurrent,
      maxQueuedRequests: config.mcp!.budgets.request.maxQueue,
      maxListeners: config.mcp!.budgets.listen.maxConnections,
    });
    const toolAdapter = emptyReadToolAdapterBundle();
    app = buildApiApp({
      config,
      metrics,
      mcpReadOperations: operations,
      mcpReadTransport: {
        changeSignalSource: apiSource,
        readToolAdapter: toolAdapter.adapter,
        readToolParamDeclarations: toolAdapter.paramDeclarations,
      },
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpNodeResourceProjection: emptyNodeResourceProjection(),
      mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server is not listening');
    origin = `http://127.0.0.1:${address.port}`;
  }, 240_000);

  afterAll(async () => {
    if (app !== undefined) {
      const appClose = app.close().catch(() => undefined);
      await Promise.race([
        appClose,
        (async () => {
          // The drain test leaves HTTP keep-alive sockets that the server can
          // half-close before teardown runs; app.close() then waits for the
          // keep-alive timeout and can exhaust the hook budget. Teardown must
          // never hang, so force-close any remaining connections after a short
          // grace period.
          await waitForRealTime(
            2_000,
            'give Fastify keep-alive connections a bounded graceful-close window before force-closing them',
          );
          app.server.closeAllConnections?.();
          await appClose;
        })(),
      ]);
    }
    await apiSource?.close();
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  test('forced MCP drain closes only listen streams, then a fresh listener can restart and receive signals', async () => {
    const first = await mcpFetch(`${origin}/collections/-/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'subscriptions/listen',
        'mcp-protocol-version': '2026-07-28',
        accept: 'application/json, text/event-stream',
      },
      body: modernBody('subscriptions/listen', 'drain-first', {
        notifications: { resourcesListChanged: true },
      }),
    });
    assert.equal(first.status, 200);
    const firstReader = createSseReader(first);
    await waitFor(() => operations.inspect().activeListeners.length === 1);
    assert.equal(operations.inspect().activeListeners[0]?.method, 'subscriptions/listen');
    assert.deepEqual(
      Object.keys(operations.inspect().activeListeners[0] ?? {}).sort(),
      ['elapsedMs', 'kind', 'method', 'resourceKind'],
    );
    assert.equal(
      (await firstReader.next())?.method,
      'notifications/subscriptions/acknowledged',
    );

    operations.drain();
    assert.equal(await firstReader.next(), null);
    await waitFor(() => operations.inspect().activeListeners.length === 0);
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal(metrics.get('mcp.read.drain.total'), 1);

    const second = await mcpFetch(`${origin}/collections/-/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'subscriptions/listen',
        'mcp-protocol-version': '2026-07-28',
        accept: 'application/json, text/event-stream',
      },
      body: modernBody('subscriptions/listen', 'drain-second', {
        notifications: { resourcesListChanged: true },
      }),
    });
    assert.equal(second.status, 200);
    const secondReader = createSseReader(second);
    try {
      await waitFor(() => operations.inspect().activeListeners.length === 1);
      assert.equal(
        (await secondReader.next())?.method,
        'notifications/subscriptions/acknowledged',
      );
      const workerSource = createPostgresMcpChangeSignalSource({
        pool: runtime.pool,
        channel: `mcp_sig_${schema.replaceAll('-', '_')}`,
      });
      try {
        await workerSource.publish({ type: 'resource-list-changed' });
        assert.equal((await secondReader.next())?.method, 'notifications/resources/list_changed');
      } finally {
        await workerSource.close();
      }
    } finally {
      secondReader.close();
    }
  });

  describe('FIX-L-042 shared MCP OAuth revocation store and rotatable security epoch', () => {
    const OAUTH_ISSUER = 'https://issuer.example.test/realms/known';
    const OAUTH_CLIENT_ID = 'known-mcp-oauth-client';
    const OAUTH_SCOPES = ['mcp:read:public', 'mcp:read:own'];
    const OAUTH_SUBJECT = 'urn:known:subject:alice';

    let store: McpOauthRevocationStore;
    let secondStore: McpOauthRevocationStore;
    let secondRuntime: DatabaseRuntime;

    function sha256(value: string): string {
      return createHash('sha256').update(value, 'utf8').digest('base64url');
    }

    async function createKeyFixture(kid: string): Promise<{
      readonly kid: string;
      readonly privateKey: KeyLike;
      readonly jwk: Record<string, unknown>;
    }> {
      const pair = await generateKeyPair('RS256', { extractable: true });
      const jwk = await exportJWK(pair.publicKey);
      Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' });
      return { kid, privateKey: pair.privateKey, jwk };
    }

    function staticJwksProvider(keys: readonly Record<string, unknown>[]): JwksProvider {
      return {
        async getKeySet(): Promise<JSONWebKeySet> {
          return { keys: [...keys] } as JSONWebKeySet;
        },
      };
    }

    async function mintCredential(input: {
      readonly key: KeyLike | Uint8Array;
      readonly kid: string;
      readonly jti: string;
      readonly issuedAtSeconds?: number;
    }): Promise<string> {
      const now = Math.floor(Date.now() / 1_000);
      return new SignJWT({ scope: OAUTH_SCOPES.join(' '), client_id: OAUTH_CLIENT_ID })
        .setProtectedHeader({ alg: 'RS256', kid: input.kid })
        .setIssuer(OAUTH_ISSUER)
        .setSubject(OAUTH_SUBJECT)
        .setAudience(AUDIENCE)
        .setIssuedAt(input.issuedAtSeconds ?? now - 5)
        .setExpirationTime(now + 3_600)
        .setJti(input.jti)
        .sign(input.key);
    }

    function createVerifier(
      targetStore: McpOauthRevocationStore,
      jwk: Record<string, unknown>,
    ) {
      return createMcpOauthVerifier({
        issuer: OAUTH_ISSUER,
        audience: AUDIENCE,
        allowedScopes: OAUTH_SCOPES,
        jwks: staticJwksProvider([jwk]),
        isRevoked: (input) => targetStore.isRevoked(input),
        securityEpoch: () => targetStore.securityEpoch(),
        resolveAccountBySubject: async (sub) => (
          sub === OAUTH_SUBJECT
            ? { id: 'account-alice', subjectId: OAUTH_SUBJECT, status: 'active' }
            : null
        ),
      });
    }

    async function expectRevoked(
      targetStore: McpOauthRevocationStore,
      jwk: Record<string, unknown>,
      token: string,
    ): Promise<void> {
      await assert.rejects(
        () => createVerifier(targetStore, jwk).verify({ authorization: `Bearer ${token}` }),
        (error: unknown) => error instanceof McpOauthVerificationError
          && error.reason === 'revoked',
      );
    }

    beforeAll(async () => {
      store = createPostgresMcpOauthRevocationStore({ db: runtime.db });
      const secondUrl = new URL(databaseUrl);
      secondUrl.searchParams.set('options', `-c search_path=${schema}`);
      secondRuntime = createDatabaseRuntime(secondUrl.toString(), {
        maxConnections: 2,
        applicationName: 'known-mcp-oauth-store-second-test',
      });
      secondStore = createPostgresMcpOauthRevocationStore({ db: secondRuntime.db });
    }, 60_000);

    afterAll(async () => {
      await secondRuntime?.close();
    });

    async function anchorEpochBoundaryToPast(): Promise<void> {
      // The migration seeds effective_at at migrate time, which is seconds
      // before these tests run; tokens minted with a recent `iat` would then
      // fall before that boundary and be (correctly) treated as revoked.
      // Anchor the boundary one hour in the past so minted iats are
      // unambiguous relative to the epoch semantics under test.
      const anchored = new Date(Date.now() - 3_600_000);
      await sql`
        UPDATE mcp_oauth_security_epoch
        SET effective_at = ${anchored}, updated_at = ${anchored}
        WHERE id = 1
      `.execute(runtime.db);
    }

    test('revoking a signed token fails immediately and the fact is shared across instances', async () => {
      const key = await createKeyFixture('key-revoke');
      await anchorEpochBoundaryToPast();
      const jti = 'postgres-jti-revoked-1';
      const token = await mintCredential({ key: key.privateKey, kid: key.kid, jti });
      const first = await createVerifier(store, key.jwk).verify({
        authorization: `Bearer ${token}`,
      });
      assert.equal(first.binding.kind, 'authenticated');
      assert.equal(first.evidence.securityEpoch, MCP_OAUTH_DEFAULT_SECURITY_EPOCH);

      await store.revoke({
        issuer: OAUTH_ISSUER,
        subject: OAUTH_SUBJECT,
        clientId: OAUTH_CLIENT_ID,
        tokenId: jti,
        credentialDigest: sha256(token),
      });

      await expectRevoked(store, key.jwk, token);
      await expectRevoked(secondStore, key.jwk, token);
      assert.equal(
        await secondStore.isRevoked({
          issuer: OAUTH_ISSUER,
          subject: OAUTH_SUBJECT,
          clientId: OAUTH_CLIENT_ID,
          tokenId: jti,
          credentialDigest: sha256(token),
          issuedAtSeconds: Math.floor(Date.now() / 1_000) + 60,
        }),
        true,
        'the second instance must observe the same revocation fact',
      );

      const rows = (await sql<{
        readonly issuer_digest: string;
        readonly subject_digest: string;
        readonly client_id_digest: string;
        readonly token_id_digest: string;
        readonly credential_digest: string;
      }>`
        SELECT issuer_digest, subject_digest, client_id_digest, token_id_digest, credential_digest
        FROM mcp_oauth_revocations
        WHERE token_id_digest = ${sha256(jti)}
      `.execute(runtime.db)).rows;
      assert.equal(rows.length, 1, 'exactly one revocation row must be stored');
      const row = rows[0]!;
      assert.equal(row.issuer_digest, sha256(OAUTH_ISSUER));
      assert.equal(row.subject_digest, sha256(OAUTH_SUBJECT));
      assert.equal(row.client_id_digest, sha256(OAUTH_CLIENT_ID));
      assert.equal(row.token_id_digest, sha256(jti));
      assert.equal(row.credential_digest, sha256(token));
      for (const value of Object.values(row)) {
        assert.match(value, /^[A-Za-z0-9_-]{43}$/u, 'only one-way sha256 digests may be stored');
      }
      assert.equal(JSON.stringify(row).includes(token), false, 'the raw token must never be stored');
      assert.equal(JSON.stringify(row).includes(jti), false, 'the raw jti must never be stored');
      assert.equal(JSON.stringify(row).includes(OAUTH_SUBJECT), false, 'the raw subject must never be stored');
    });

    test('security epoch bump retires old tokens, accepts new tokens and is shared across instances', async () => {
      const key = await createKeyFixture('key-epoch');
      await anchorEpochBoundaryToPast();
      const beforeSeconds = Math.floor(Date.now() / 1_000) - 600;
      const afterSeconds = Math.floor(Date.now() / 1_000) + 120;
      const oldToken = await mintCredential({
        key: key.privateKey,
        kid: key.kid,
        jti: 'postgres-jti-old-epoch',
        issuedAtSeconds: beforeSeconds,
      });
      const newToken = await mintCredential({
        key: key.privateKey,
        kid: key.kid,
        jti: 'postgres-jti-new-epoch',
        issuedAtSeconds: afterSeconds,
      });

      const initial = await createVerifier(store, key.jwk).verify({
        authorization: `Bearer ${oldToken}`,
      });
      assert.equal(initial.evidence.securityEpoch, MCP_OAUTH_DEFAULT_SECURITY_EPOCH);

      const bumped = await store.bumpSecurityEpoch('epoch-bumped-3');
      assert.equal(bumped.value, 'epoch-bumped-3');
      assert.equal(
        await secondStore.securityEpoch(),
        'epoch-bumped-3',
        'the rotated epoch must be visible on every instance',
      );

      await expectRevoked(store, key.jwk, oldToken);
      await expectRevoked(secondStore, key.jwk, oldToken);
      const fresh = await createVerifier(secondStore, key.jwk).verify({
        authorization: `Bearer ${newToken}`,
      });
      assert.equal(fresh.evidence.securityEpoch, 'epoch-bumped-3');
      assert.equal(fresh.binding.securityEpoch, 'epoch-bumped-3');
    });

    test('a missing epoch row fails closed and bumpSecurityEpoch restores service', async () => {
      const key = await createKeyFixture('key-epoch-missing');
      await sql`DELETE FROM mcp_oauth_security_epoch`.execute(runtime.db);
      try {
        await assert.rejects(
          () => store.securityEpoch(),
          (error: unknown) => error instanceof Error
            && /security epoch is not provisioned/u.test(error.message),
        );
        await assert.rejects(
          () => store.isRevoked({
            issuer: OAUTH_ISSUER,
            subject: OAUTH_SUBJECT,
            clientId: OAUTH_CLIENT_ID,
            tokenId: 'postgres-jti-epoch-missing',
            credentialDigest: sha256('opaque-token'),
            issuedAtSeconds: Math.floor(Date.now() / 1_000) + 300,
          }),
          (error: unknown) => error instanceof Error
            && /security epoch is not provisioned/u.test(error.message),
        );
      } finally {
        await store.bumpSecurityEpoch(MCP_OAUTH_DEFAULT_SECURITY_EPOCH);
      }

      assert.equal(await store.securityEpoch(), MCP_OAUTH_DEFAULT_SECURITY_EPOCH);
      assert.equal(
        await secondStore.isRevoked({
          issuer: OAUTH_ISSUER,
          subject: OAUTH_SUBJECT,
          clientId: OAUTH_CLIENT_ID,
          tokenId: 'postgres-jti-epoch-missing',
          credentialDigest: sha256('opaque-token'),
          issuedAtSeconds: Math.floor(Date.now() / 1_000) + 300,
        }),
        false,
      );

      const token = await mintCredential({
        key: key.privateKey,
        kid: key.kid,
        jti: 'postgres-jti-epoch-restored',
        issuedAtSeconds: Math.floor(Date.now() / 1_000) + 120,
      });
      const restored = await createVerifier(store, key.jwk).verify({
        authorization: `Bearer ${token}`,
      });
      assert.equal(restored.binding.kind, 'authenticated');
    });
  });
});
