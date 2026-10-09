import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_HANDLER_NAME,
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_HANDLER_NAME,
} from '../../../src/modules/collections/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresCollectionMutationProjectionSink,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  createCollectionMutationEnvelopeRegistry,
  createPhase4bMcpChangeSignalSink,
  createProductionCollectionMutationOutboxRouter,
  createPostgresMcpChangeSignalSource,
  type PostgresMcpChangeSignalSource,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations, createDatabaseRuntime, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpResourceIdentity,
  createPhase4bMcpSnapshotResourceProjection,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
} from '../../../src/modules/publication/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';
import { createMcpTestFetch } from '../../support/phase4b-mcp-transport-scaffold.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const mcpFetch = createMcpTestFetch();

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
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

const logger: OutboxWorkerLogger = {
  info() {},
  warn() {},
  error() {},
};

interface SseEvent {
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
}

function createSseReader(response: Response): {
  readonly next: (timeoutMs?: number) => Promise<SseEvent | null>;
  readonly close: () => void;
} {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let pendingRead: Promise<void> | null = null;

  function readChunk(): Promise<void> {
    if (pendingRead !== null) return pendingRead;
    pendingRead = reader.read()
      .then((result) => {
        if (result.done) {
          done = true;
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
      })
      .finally(() => {
        pendingRead = null;
      });
    return pendingRead;
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for SSE event'));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  return {
    async next(timeoutMs = 3_000): Promise<SseEvent | null> {
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
          if (data !== undefined) return JSON.parse(data) as SseEvent;
          continue;
        }
        if (done) return null;
        await withTimeout(readChunk(), deadline - Date.now());
      }
      throw new Error('timed out waiting for SSE event');
    },
    close() {
      void reader.cancel().catch(() => undefined);
    },
  };
}

function modernBody(
  method: string,
  id: number | string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': {
          name: 'known-r11-postgres-test',
          version: '1.0.0',
        },
      },
      ...params,
    },
  });
}

function buildProjections(
  runtime: DatabaseRuntime,
  config: ReturnType<typeof loadConfig>,
): {
  readonly collectionProjection: Phase4bMcpCollectionResourceProjection;
  readonly snapshotProjection: Phase4bMcpSnapshotResourceProjection;
  readonly nodeProjection: Phase4bMcpNodeResourceProjection;
  readonly destroy: () => void;
} {
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'listen-pg-v1', secret: Buffer.alloc(32, 81).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'listen-mcp-v1', secret: Buffer.alloc(32, 83).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const collectionProjection = createPhase4bMcpCollectionResourceProjection({
    config: config.mcp!,
    directoryQuery: {
      reads: createPostgresPublicationDirectoryReadPort(runtime),
      cursors: publicationCursors,
      origin: 'https://known.example',
      maxPageSize: 500,
    },
    metadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(runtime),
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
    // P4A-R06: the Collection Resource projection consults the exposure-eligibility gate.
    sharedExposure: createPostgresSharedExposureFactsPort(runtime),
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize: 10,
    policyRevisionFor: async () => 'authority-1',
  });
  const snapshotQuery = {
    reads: createPostgresPublicationSnapshotReadPort(runtime),
    annotations: createPostgresPublicationAnnotationReadPort(runtime, {
      origin: 'https://known.example',
    }),
    relations: createPostgresPublicationRelationReadPort(runtime),
    accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
    cursors: publicationCursors,
    origin: 'https://known.example',
    now: () => NOW,
    sharedExposure: createPostgresSharedExposureFactsPort(runtime),
  };
  const snapshotProjection = createPhase4bMcpSnapshotResourceProjection({
    config: config.mcp!,
    snapshotQuery,
    now: () => NOW,
    pageSize: 10,
  });
  const nodeProjection = createPhase4bMcpNodeResourceProjection({
    config: config.mcp!,
    snapshotQuery,
    now: () => NOW,
  });
  return {
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

describeWithPostgres('Phase 4B R11 MCP listen over committed Outbox projection', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `mcp_listen_${randomUUID().replaceAll('-', '_')}`;
  let admin: Pool;
  let runtime: DatabaseRuntime;
  let repository: PostgresOutboxRepository;
  let durableSink: PostgresCollectionMutationProjectionSink;
  let apiSource: PostgresMcpChangeSignalSource;
  let channel: string;
  let app: FastifyInstance;
  let origin: string;
  let destroyProjections: () => void;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema ${schema}`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const migrationRuntime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 1,
      applicationName: 'known-mcp-listen-migration-test',
    });
    await runMigrations(migrationRuntime.db, 'latest');
    await migrationRuntime.close();
    runtime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 4,
      applicationName: 'known-mcp-listen-integration-test',
    });
    repository = new PostgresOutboxRepository(runtime.pool);
    durableSink = new PostgresCollectionMutationProjectionSink(runtime.pool);
    channel = `mcp_sig_${schema.replaceAll('-', '_')}`;

    const config = loadConfig(mcpEnv());
    const projections = buildProjections(runtime, config);
    destroyProjections = projections.destroy;
    apiSource = createPostgresMcpChangeSignalSource({
      pool: runtime.pool,
      channel,
    });
    await apiSource.start();
    const toolAdapter = emptyReadToolAdapterBundle();
    app = buildApiApp({
      config,
      mcpReadTransport: {
        changeSignalSource: apiSource,
        readToolAdapter: toolAdapter.adapter,
        readToolParamDeclarations: toolAdapter.paramDeclarations,
      },
      mcpReadResourceProjection: projections.collectionProjection,
      mcpNodeResourceProjection: projections.nodeProjection,
      mcpSnapshotResourceProjection: projections.snapshotProjection,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server is not listening');
    origin = `http://127.0.0.1:${address.port}`;
  }, 240_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await apiSource?.close();
    destroyProjections?.();
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  test('a separate PostgreSQL-backed worker source fans out to the API listener source', async () => {
    const workerSource = createPostgresMcpChangeSignalSource({
      pool: runtime.pool,
      channel,
    });
    const received: string[] = [];
    const subscription = apiSource.subscribe((signal) => {
      if (signal.type === 'resource-list-changed') received.push(signal.type);
    });
    try {
      await workerSource.publish({ type: 'resource-list-changed' });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const deadline = setTimeout(() => {
          rejectPromise(new Error('PostgreSQL change signal was not delivered'));
        }, 3_000);
        deadline.unref();
        const check = setInterval(() => {
          if (received.length > 0) {
            clearTimeout(deadline);
            clearInterval(check);
            resolvePromise();
          }
        }, 10);
      });
      assert.deepEqual(received, ['resource-list-changed']);
    } finally {
      subscription.unsubscribe();
    }
  });

  async function insertOutbox(input: {
    readonly outboxId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly handlerName: string;
    readonly aggregateId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void> {
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'outbox'), ($2, 'domain-event')
       on conflict (resource_id) do nothing`,
      [input.outboxId, input.eventId],
    );
    await runtime.pool.query(
      `insert into outbox_events(
         outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
         occurred_at, payload_json, available_at
       ) values (
         $1, $2, $3, 1, $4, 'projection_latest_only',
         'collection', $5, $5, 'rev-1', 1,
         current_timestamp, $6::jsonb, current_timestamp
       )`,
      [
        input.outboxId,
        input.eventId,
        input.eventType,
        input.handlerName,
        input.aggregateId,
        JSON.stringify(input.payload),
      ],
    );
  }

  function makeWorker(): VersionedOutboxWorker {
    const workerSource = createPostgresMcpChangeSignalSource({
      pool: runtime.pool,
      channel,
    });
    const signalSink = createPhase4bMcpChangeSignalSink({
      projectionSink: durableSink,
      signalSource: workerSource,
      config: loadConfig(mcpEnv()).mcp!,
      onError(error) {
        logger.error(error instanceof Error ? { error: error.message } : { error }, 'MCP signal sink failed');
      },
    });
    const routes = createProductionCollectionMutationOutboxRouter({
      sink: signalSink,
      logger,
    }).listRoutes();
    return new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter(routes),
      envelopes: createCollectionMutationEnvelopeRegistry(),
      logger,
      batchSize: 10,
      maxConcurrentHandlers: 10,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      acknowledgeTransientSideEffects: false,
    });
  }

  async function seedCollectionForListen(input: {
    readonly collectionId: string;
    readonly rootNodeId: string;
    readonly nodeId?: string;
    readonly visibility: 'public' | 'private';
    readonly ownerSubjectId: string;
  }): Promise<void> {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [input.collectionId, input.rootNodeId],
      );
      if (input.nodeId !== undefined) {
        await client.query(
          `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
          [input.nodeId],
        );
      }
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, publication_slug,
           published_at, updated_at)
         values ($1, $2, $3, 'bookmarks', $4, $5,
                 'r1', 'c1', 'p1', $6,
                 '2026-01-01T00:00:00Z'::timestamptz,
                 '2026-08-05T08:00:00Z'::timestamptz)`,
        [
          input.collectionId,
          input.ownerSubjectId,
          input.collectionId,
          input.visibility,
          input.rootNodeId,
          input.collectionId,
        ],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, kind, is_root, title,
           resource_revision, children_revision)
         values ($1, $2, 'folder', true, $3, 'r1', 'ch1')`,
        [input.rootNodeId, input.collectionId, `Root ${input.collectionId}`],
      );
      if (input.nodeId !== undefined) {
        await client.query(
          `insert into nodes(
             id, collection_id, parent_id, kind, is_root, title, url,
             visibility, position_token, resource_revision, children_revision)
           values ($1, $2, $3, 'bookmark', false, 'Node', $4,
                   'inherit', 'A', 'r1', 'ch1')`,
          [input.nodeId, input.collectionId, input.rootNodeId, `https://example.test/${input.nodeId}`],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test('committed Collection and Node Outbox events publish low-sensitivity URI hints and durable projection remains readable', async () => {
    const config = loadConfig(mcpEnv());
    const identity = createPhase4bMcpResourceIdentity(config.mcp!);
    const collectionId = `collection-${randomUUID()}`;
    const rootNodeId = `root-${randomUUID()}`;
    const nodeId = `node-${randomUUID()}`;

    await seedCollectionForListen({
      collectionId,
      rootNodeId,
      nodeId,
      visibility: 'public',
      ownerSubjectId: 'subject-r11',
    });
    await insertOutbox({
      outboxId: `outbox-create-${collectionId}`,
      eventId: `event-create-${collectionId}`,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      payload: {
        collectionId,
        kind: 'bookmarks',
        ownerSubjectId: 'subject-r11',
        rootNodeId,
      },
    });
    await insertOutbox({
      outboxId: `outbox-update-${nodeId}`,
      eventId: `event-update-${nodeId}`,
      eventType: NODE_UPDATED_EVENT_TYPE,
      handlerName: NODE_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      payload: {
        collectionId,
        contentRevision: 'content-1',
        kind: 'bookmark',
        nodeId,
        policyRevision: 'policy-1',
        resourceRevision: 'resource-1',
      },
    });

    const metadataUri = identity.collectionMetadata(collectionId);
    const snapshotUri = identity.collectionSnapshot(collectionId);
    const nodeUri = identity.collectionNode(collectionId, nodeId);
    const response = await mcpFetch(`${origin}/collections/-/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'subscriptions/listen',
        'mcp-protocol-version': '2026-07-28',
        accept: 'application/json, text/event-stream',
      },
      body: modernBody('subscriptions/listen', 'postgres-listen', {
        notifications: {
          resourceSubscriptions: [metadataUri, snapshotUri, nodeUri],
          resourcesListChanged: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const reader = createSseReader(response);
    try {
      const ack = await reader.next();
      assert.equal(ack?.method, 'notifications/subscriptions/acknowledged');

      const worker = makeWorker();
      assert.equal(await worker.runOnce(), true);
      assert.equal(await worker.runOnce(), true);

      const hints = [
        await reader.next(),
        await reader.next(),
        await reader.next(),
        await reader.next(),
        await reader.next(),
      ];
      const methods = hints.map((hint) => hint?.method);
      assert.equal(methods.includes('notifications/resources/updated'), true);
      assert.equal(methods.includes('notifications/resources/list_changed'), false);
      const uris = hints
        .filter((hint) => hint?.method === 'notifications/resources/updated')
        .map((hint) => hint?.params?.uri)
        .filter((uri): uri is string => typeof uri === 'string');
      assert.equal(uris.includes(metadataUri), true);
      assert.equal(uris.includes(snapshotUri), true);
      assert.equal(uris.includes(nodeUri), true);
      for (const hint of hints) {
        if (hint?.method !== 'notifications/resources/updated') continue;
        assert.equal((hint.params as { readonly contents?: unknown }).contents, undefined);
        assert.equal((hint.params as { readonly text?: unknown }).text, undefined);
      }

      const projectedCollection = await durableSink.repository.getResource(
        collectionId,
        'collection',
        collectionId,
      );
      assert.ok(projectedCollection);
      assert.equal(projectedCollection.lastEventType, COLLECTION_CREATED_EVENT_TYPE);
      const projectedNode = await durableSink.repository.getResource(
        collectionId,
        'node',
        nodeId,
      );
      assert.ok(projectedNode);
      assert.equal(projectedNode.lastEventType, NODE_UPDATED_EVENT_TYPE);
    } finally {
      reader.close();
    }
  });

  test('committed private Resource mutations do not leak hidden URIs and the listen stream continues', async () => {
    const config = loadConfig(mcpEnv());
    const identity = createPhase4bMcpResourceIdentity(config.mcp!);
    const privateCollectionId = `private-${randomUUID()}`;
    const privateRootNodeId = `private-root-${randomUUID()}`;
    const privateNodeId = `private-node-${randomUUID()}`;
    const publicCollectionId = `public-${randomUUID()}`;
    const publicRootNodeId = `public-root-${randomUUID()}`;
    const publicNodeId = `public-node-${randomUUID()}`;

    await seedCollectionForListen({
      collectionId: privateCollectionId,
      rootNodeId: privateRootNodeId,
      nodeId: privateNodeId,
      visibility: 'private',
      ownerSubjectId: 'subject-private',
    });
    await seedCollectionForListen({
      collectionId: publicCollectionId,
      rootNodeId: publicRootNodeId,
      nodeId: publicNodeId,
      visibility: 'public',
      ownerSubjectId: 'subject-r11',
    });

    const privateMetadataUri = identity.collectionMetadata(privateCollectionId);
    const privateSnapshotUri = identity.collectionSnapshot(privateCollectionId);
    const privateNodeUri = identity.collectionNode(privateCollectionId, privateNodeId);
    const publicMetadataUri = identity.collectionMetadata(publicCollectionId);
    const publicSnapshotUri = identity.collectionSnapshot(publicCollectionId);
    const publicNodeUri = identity.collectionNode(publicCollectionId, publicNodeId);
    const response = await mcpFetch(`${origin}/collections/-/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'subscriptions/listen',
        'mcp-protocol-version': '2026-07-28',
        accept: 'application/json, text/event-stream',
      },
      body: modernBody('subscriptions/listen', 'private-recheck', {
        notifications: {
          resourceSubscriptions: [
            privateMetadataUri,
            privateSnapshotUri,
            privateNodeUri,
            publicMetadataUri,
            publicSnapshotUri,
            publicNodeUri,
          ],
          resourcesListChanged: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const reader = createSseReader(response);
    try {
      assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');

      await insertOutbox({
        outboxId: `outbox-private-${privateCollectionId}`,
        eventId: `event-private-${privateCollectionId}`,
        eventType: COLLECTION_CREATED_EVENT_TYPE,
        handlerName: COLLECTION_CREATED_HANDLER_NAME,
        aggregateId: privateCollectionId,
        payload: {
          collectionId: privateCollectionId,
          kind: 'bookmarks',
          ownerSubjectId: 'subject-private',
          rootNodeId: privateRootNodeId,
        },
      });
      assert.equal(await makeWorker().runOnce(), true);
      await assert.rejects(() => reader.next(150), /timed out/);

      await insertOutbox({
        outboxId: `outbox-private-node-${privateNodeId}`,
        eventId: `event-private-node-${privateNodeId}`,
        eventType: NODE_UPDATED_EVENT_TYPE,
        handlerName: NODE_UPDATED_HANDLER_NAME,
        aggregateId: privateCollectionId,
        payload: {
          collectionId: privateCollectionId,
          contentRevision: 'content-1',
          kind: 'bookmark',
          nodeId: privateNodeId,
          policyRevision: 'policy-1',
          resourceRevision: 'resource-1',
        },
      });
      assert.equal(await makeWorker().runOnce(), true);
      await assert.rejects(() => reader.next(150), /timed out/);

      await insertOutbox({
        outboxId: `outbox-public-${publicCollectionId}`,
        eventId: `event-public-${publicCollectionId}`,
        eventType: COLLECTION_CREATED_EVENT_TYPE,
        handlerName: COLLECTION_CREATED_HANDLER_NAME,
        aggregateId: publicCollectionId,
        payload: {
          collectionId: publicCollectionId,
          kind: 'bookmarks',
          ownerSubjectId: 'subject-r11',
          rootNodeId: publicRootNodeId,
        },
      });
      assert.equal(await makeWorker().runOnce(), true);
      await insertOutbox({
        outboxId: `outbox-public-node-${publicNodeId}`,
        eventId: `event-public-node-${publicNodeId}`,
        eventType: NODE_UPDATED_EVENT_TYPE,
        handlerName: NODE_UPDATED_HANDLER_NAME,
        aggregateId: publicCollectionId,
        payload: {
          collectionId: publicCollectionId,
          contentRevision: 'content-1',
          kind: 'bookmark',
          nodeId: publicNodeId,
          policyRevision: 'policy-1',
          resourceRevision: 'resource-1',
        },
      });
      assert.equal(await makeWorker().runOnce(), true);
      const publicSignals = [
        await reader.next(),
        await reader.next(),
        await reader.next(),
        await reader.next(),
        await reader.next(),
      ];
      const deliveredUris = publicSignals
        .filter((signal) => signal?.method === 'notifications/resources/updated')
        .map((signal) => signal?.params?.uri);
      assert.deepEqual(
        [...new Set(deliveredUris)].sort(),
        [publicMetadataUri, publicSnapshotUri, publicNodeUri].sort(),
      );
      assert.equal(deliveredUris.includes(privateMetadataUri), false);
      assert.equal(deliveredUris.includes(privateSnapshotUri), false);
      assert.equal(deliveredUris.includes(privateNodeUri), false);
      assert.equal(
        publicSignals.filter((signal) => signal?.method === 'notifications/resources/list_changed').length,
        0,
      );
      await assert.rejects(() => reader.next(150), /timed out/);
    } finally {
      reader.close();
    }
  });

  test('a restarted worker does not replay completed Outbox hints to a new listener', async () => {
    const config = loadConfig(mcpEnv());
    const identity = createPhase4bMcpResourceIdentity(config.mcp!);
    const collectionId = `collection-replay-${randomUUID()}`;
    const rootNodeId = `root-replay-${randomUUID()}`;
    const outboxId = `outbox-replay-${collectionId}`;
    const eventId = `event-replay-${collectionId}`;

    await insertOutbox({
      outboxId,
      eventId,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      payload: {
        collectionId,
        kind: 'bookmarks',
        ownerSubjectId: 'subject-replay',
        rootNodeId,
      },
    });
    const firstWorker = makeWorker();
    assert.equal(await firstWorker.runOnce(), true);

    const metadataUri = identity.collectionMetadata(collectionId);
    const response = await mcpFetch(`${origin}/collections/-/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'subscriptions/listen',
        'mcp-protocol-version': '2026-07-28',
        accept: 'application/json, text/event-stream',
      },
      body: modernBody('subscriptions/listen', 'replay-listen', {
        notifications: {
          resourceSubscriptions: [metadataUri],
          resourcesListChanged: true,
        },
      }),
    });
    const reader = createSseReader(response);
    try {
      assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
      const restartedWorker = makeWorker();
      assert.equal(await restartedWorker.runOnce(), false);
      const late = await Promise.race([
        reader.next(250).then(
          () => 'event',
          () => 'timeout',
        ),
        new Promise<'timeout'>((resolvePromise) => {
          const timer = setTimeout(() => resolvePromise('timeout'), 300);
          timer.unref();
        }),
      ]);
      assert.equal(late, 'timeout');
    } finally {
      reader.close();
    }
  });
});
